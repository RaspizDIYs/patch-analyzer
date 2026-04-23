//! Офлайн: скачать модули вики + категории иконок + cherry-augments.json → `src/data/augments-bundled.json`.
use anyhow::{Context, Result};
use lol_meta_analyzer_lib::wiki_augment_bundle::{build_bundled, parse_category_gallery_page};
use scraper::{Html, Selector};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const UA: &str = "patch-analyzer-wiki-augment-fetch/1.0 (offline)";

fn fetch_text(client: &reqwest::blocking::Client, url: &str) -> Result<String> {
    let resp = client
        .get(url)
        .header(
            reqwest::header::REFERER,
            "https://wiki.leagueoflegends.com/en-us/",
        )
        .send()
        .with_context(|| format!("GET {}", url))?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {} for {}", resp.status(), url);
    }
    Ok(resp.text()?)
}

fn find_next_category_url(html: &str, current: &str) -> Option<String> {
    let doc = Html::parse_document(html);
    let a_sel = Selector::parse("a").ok()?;
    for a in doc.select(&a_sel) {
        let t = a.text().collect::<String>().to_lowercase();
        if !t.contains("next") {
            continue;
        }
        let href = a.value().attr("href")?;
        if !href.contains("Category") && !href.contains("filefrom") && !href.contains("pagefrom")
        {
            continue;
        }
        if href == current || href.contains("redlink") {
            continue;
        }
        let full = if href.starts_with("http") {
            href.to_string()
        } else {
            format!("https://wiki.leagueoflegends.com{}", href)
        };
        return Some(full);
    }
    None
}

fn fetch_category_all_pages(
    client: &reqwest::blocking::Client,
    base_path: &str,
    pool: &str,
) -> Result<HashMap<String, String>> {
    let mut merged = HashMap::new();
    let mut url = format!("https://wiki.leagueoflegends.com{}", base_path);
    let mut guard = 0u32;
    loop {
        guard += 1;
        if guard > 50 {
            anyhow::bail!("category pagination exceeded 50 pages for {}", base_path);
        }
        let html = fetch_text(client, &url)?;
        let page = parse_category_gallery_page(&html, pool);
        for (k, v) in page {
            merged.insert(k, v);
        }
        let Some(next) = find_next_category_url(&html, "") else {
            break;
        };
        if next == url {
            break;
        }
        url = next;
    }
    Ok(merged)
}

fn main() -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(UA)
        .build()?;

    let arena_lua = fetch_text(
        &client,
        "https://wiki.leagueoflegends.com/en-us/Module:ArenaAugmentData/data?action=raw",
    )?;
    let mayhem_lua = fetch_text(
        &client,
        "https://wiki.leagueoflegends.com/en-us/Module:MayhemAugmentData/data?action=raw",
    )?;

    let arena_icons = fetch_category_all_pages(&client, "/en-us/Category:Arena_augment_icons", "arena")?;
    let mayhem_icons =
        fetch_category_all_pages(&client, "/en-us/Category:ARAM:_Mayhem_augment_icons", "mayhem")?;

    let cherry = fetch_text(
        &client,
        "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json",
    )
    .ok();

    let bundled = build_bundled(
        &arena_lua,
        &mayhem_lua,
        &arena_icons,
        &mayhem_icons,
        cherry.as_deref(),
    );

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out = root.join("../src/data/augments-bundled.json");
    let json = serde_json::to_string_pretty(&bundled)?;
    fs::write(&out, json).with_context(|| format!("write {}", out.display()))?;
    eprintln!(
        "Wrote {} arena={} mayhem={} arena_icons={} mayhem_icons={}",
        out.display(),
        bundled.arena.len(),
        bundled.mayhem.len(),
        arena_icons.len(),
        mayhem_icons.len()
    );
    Ok(())
}
