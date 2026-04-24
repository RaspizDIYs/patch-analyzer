use std::collections::HashSet;
use std::time::Duration;

use reqwest::Url;
use reqwest::header;
use scraper::{Html, Selector, ElementRef};
use anyhow::Result;
use crate::models::{
    ChampionStats, ChangeBlock, ChangeType, ItemStat, LaneRole, MayhemAugmentation, PatchCategory,
    PatchData, PatchNoteEntry,
};
use crate::patch_version::ddragon_pair_to_display;
use crate::patch_change_trend::analyze_change_trend;
use chrono::Utc;
use regex::Regex;

fn patch_category_from_section_h2_id(id: &str, champion_slugs: &HashSet<String>) -> PatchCategory {
    let id = id.to_lowercase();
    if id == "patch-upcoming-skins-and-chromas" {
        return PatchCategory::UpcomingSkinsChromas;
    }
    if id.contains("champion") {
        return PatchCategory::Champions;
    }
    if id.contains("item") && !id.contains("rune") {
        return PatchCategory::Items;
    }
    if id.contains("rune") && !id.contains("item") {
        return PatchCategory::Runes;
    }
    if id.contains("item") || id.contains("rune") {
        return PatchCategory::ItemsRunes;
    }
    if id.contains("skin") || id.contains("chroma") {
        return PatchCategory::Skins;
    }
    if id.contains("bug") {
        return PatchCategory::BugFixes;
    }
    if id.contains("mayhem") || id.contains("chaos") || id.contains("aram-chaos") {
        return PatchCategory::ModeAramChaos;
    }
    if id.contains("arena") {
        return PatchCategory::ModeArena;
    }
    if id.contains("aram") {
        return PatchCategory::ModeAram;
    }
    if id.contains("mode") {
        return PatchCategory::Modes;
    }
    if id.contains("clash")
        || id.contains("ranked")
        || id.contains("swiftplay")
        || id.contains("matchmaking")
        || id.contains("autofill")
    {
        return PatchCategory::Modes;
    }
    if id.contains("system") || id.contains("qol") {
        return PatchCategory::Systems;
    }
    if id.contains("highlight") {
        return PatchCategory::NewContent;
    }
    if let Some(tail) = id.strip_prefix("patch-") {
        let slug = tail.split(':').next().unwrap_or("").trim();
        if !slug.is_empty() && slug != "notes-container" {
            if !champion_slugs.is_empty() && champion_slugs.contains(slug) {
                return PatchCategory::Champions;
            }
            if !champion_slugs.is_empty() {
                return PatchCategory::Systems;
            }
        }
    }
    PatchCategory::Unknown
}

fn sanitize_upcoming_skin_image_url(u: String) -> String {
    if u.contains("akamaihd.net") && u.contains("?f=") {
        if let Some(pos) = u.find("?f=") {
            return u[pos + 3..].to_string();
        }
    }
    u
}

fn find_img_ancestors(h4: ElementRef<'_>, img_sel: &Selector) -> Option<String> {
    let mut node = h4.parent();
    let mut depth = 0u8;
    while let Some(n) = node {
        if depth > 10 {
            break;
        }
        if let Some(el) = ElementRef::wrap(n) {
            if let Some(img) = el.select(img_sel).next() {
                return img_url_from_element(img).map(sanitize_upcoming_skin_image_url);
            }
        }
        node = ElementRef::wrap(n).and_then(|e| e.parent());
        depth += 1;
    }
    None
}

fn append_upcoming_skins_h4_fallback(el: ElementRef<'_>, notes: &mut Vec<PatchNoteEntry>) {
    let Ok(h4_sel) = Selector::parse("h4.skin-title") else {
        return;
    };
    let Ok(img_sel) = Selector::parse("img") else {
        return;
    };
    let mut seen = std::collections::HashSet::<String>::new();
    for (idx, h4) in el.select(&h4_sel).enumerate() {
        let title = h4.text().collect::<String>().trim().to_string();
        if title.is_empty() || !seen.insert(title.clone()) {
            continue;
        }
        let image_url = find_img_ancestors(h4, &img_sel);
        notes.push(PatchNoteEntry {
            id: format!("upcoming-skin-h4-{idx}-{}", notes.len()),
            title,
            image_url,
            category: PatchCategory::UpcomingSkinsChromas,
            change_type: ChangeType::New,
            summary: String::new(),
            details: Vec::new(),
            icon_candidates: None,
        });
    }
}

fn append_upcoming_skins_chromas_notes(el: ElementRef<'_>, notes: &mut Vec<PatchNoteEntry>) {
    let Ok(skin_box_sel) = Selector::parse(".skin-box") else {
        return;
    };
    let Ok(h4_sel) = Selector::parse("h4.skin-title") else {
        return;
    };
    let Ok(img_sel) = Selector::parse("img") else {
        return;
    };
    let skin_boxes: Vec<_> = el.select(&skin_box_sel).collect();
    if skin_boxes.is_empty() {
        append_upcoming_skins_h4_fallback(el, notes);
        return;
    }
    for (idx, box_el) in skin_boxes.into_iter().enumerate() {
        let title = box_el
            .select(&h4_sel)
            .next()
            .map(|h| h.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty());
        let Some(title) = title else {
            continue;
        };
        let image_url = box_el
            .select(&img_sel)
            .next()
            .and_then(img_url_from_element)
            .map(sanitize_upcoming_skin_image_url);
        notes.push(PatchNoteEntry {
            id: format!("upcoming-skin-{idx}-{}", notes.len()),
            title,
            image_url,
            category: PatchCategory::UpcomingSkinsChromas,
            change_type: ChangeType::New,
            summary: String::new(),
            details: Vec::new(),
            icon_candidates: None,
        });
    }
}

/// ARAM / Arena / Mayhem на riotgames: `content-border` → `white-stone` без `.patch-change-block`,
/// только `h4.change-detail-title`, затем пары `<p><strong>Имя</strong></p>` + `<ul>`.
fn append_flat_mode_style_notes(
    scraper: &Scraper,
    el: ElementRef<'_>,
    category: &PatchCategory,
    notes: &mut Vec<PatchNoteEntry>,
) {
    let Ok(white_inner_sel) = Selector::parse(".white-stone > div") else {
        return;
    };
    let Ok(strong_sel) = Selector::parse("strong") else {
        return;
    };
    let Ok(li_sel) = Selector::parse("li") else {
        return;
    };
    let Ok(img_sel) = Selector::parse("img") else {
        return;
    };

    let Some(inner) = el.select(&white_inner_sel).next() else {
        return;
    };

    let mut pending_title: Option<String> = None;
    let mut pending_icon: Option<String> = None;

    for node in inner.children() {
        let Some(child_el) = ElementRef::wrap(node) else {
            continue;
        };
        let tag = child_el.value().name();
        let classes: Vec<&str> = child_el.value().classes().collect();

        if tag == "h4" && classes.iter().any(|c| *c == "change-detail-title") {
            pending_title = None;
            pending_icon = None;
            continue;
        }

        if tag == "p" {
            if let Some(img) = child_el.select(&img_sel).next() {
                pending_icon = img_url_from_element(img);
            }
            if let Some(st) = child_el.select(&strong_sel).next() {
                let title_text = st.text().collect::<String>().trim().to_string();
                if !title_text.is_empty() {
                    pending_title = Some(title_text);
                }
            }
            continue;
        }

        if tag == "ul" {
            let Some(title) = pending_title.take() else {
                continue;
            };
            let mut changes = Vec::new();
            for li in child_el.select(&li_sel) {
                let text = li.text().collect::<String>().trim().to_string();
                if !text.is_empty() {
                    changes.push(text);
                }
            }
            if changes.is_empty() {
                continue;
            }
            let change_type = scraper.determine_change_type(
                "",
                &[ChangeBlock {
                    title: None,
                    icon_url: None,
                    changes: changes.clone(),
                }],
            );
            let category_key = match category {
                PatchCategory::ModeAramChaos => "aram-chaos",
                PatchCategory::ModeAram => "aram",
                PatchCategory::ModeArena => "arena",
                PatchCategory::Modes => "modes",
                _ => "mode",
            };
            notes.push(PatchNoteEntry {
                id: format!("flat-mode-{category_key}-{}-{}", notes.len(), title),
                title,
                image_url: pending_icon.take(),
                category: category.clone(),
                change_type,
                summary: String::new(),
                details: vec![ChangeBlock {
                    title: None,
                    icon_url: None,
                    changes,
                }],
                icon_candidates: None,
            });
        }
    }
}

/// src / data-src / data-lazy-src / первый URL из srcset (часто у картинок Riot только srcset).
fn img_url_from_element(img: ElementRef) -> Option<String> {
    let v = img.value();
    for attr in ["src", "data-src", "data-lazy-src"] {
        if let Some(s) = v.attr(attr) {
            if !s.is_empty() && !s.starts_with("data:") {
                return Some(s.to_string());
            }
        }
    }
    if let Some(ss) = v.attr("srcset") {
        for part in ss.split(',') {
            let p = part.trim();
            if let Some(u) = p.split_whitespace().next() {
                if !u.is_empty() && !u.starts_with("data:") {
                    return Some(u.to_string());
                }
            }
        }
    }
    None
}

/// Регион страницы новостей Riot: ru-ru, en-gb (как в URL патч-нотов).
pub fn riot_news_region_path(patch_notes_locale: &str) -> &'static str {
    if patch_notes_locale == "en" {
        "en-gb"
    } else {
        "ru-ru"
    }
}

fn normalize_patch_notes_locale(s: &str) -> &'static str {
    if s == "en" { "en" } else { "ru" }
}

const LEAGUE_WIKI_ORIGIN: &str = "https://wiki.leagueoflegends.com";

pub(crate) fn resolve_league_wiki_asset_url(raw: &str) -> String {
    let u = raw.trim();
    if u.starts_with("//") {
        return format!("https:{u}");
    }
    if u.starts_with('/') {
        return format!("{LEAGUE_WIKI_ORIGIN}{u}");
    }
    u.to_string()
}

pub(crate) fn clean_wiki_asset_url(raw: &str) -> String {
    let u = resolve_league_wiki_asset_url(raw);
    let u = u.trim();
    if u.contains("akamaihd.net") && u.contains("?f=") {
        if let Some(pos) = u.find("?f=") {
            return u[pos + 3..].to_string();
        }
    }
    u.to_string()
}

fn wiki_cell_plain_text(cell: ElementRef<'_>) -> String {
    cell.text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn wiki_row_direct_cells(row: ElementRef<'_>) -> Vec<ElementRef<'_>> {
    row.children()
        .filter_map(ElementRef::wrap)
        .filter(|el| matches!(el.value().name(), "th" | "td"))
        .collect()
}

#[derive(Clone, Copy)]
struct WikiAugmentCols {
    icon: usize,
    name: usize,
    tier: Option<usize>,
    set_col: Option<usize>,
    effect: usize,
}

fn infer_augment_columns(col_count: usize, headers: &[String]) -> WikiAugmentCols {
    if col_count == 0 {
        return WikiAugmentCols {
            icon: 0,
            name: 0,
            tier: None,
            set_col: None,
            effect: 0,
        };
    }
    let last = col_count.saturating_sub(1);
    if headers.is_empty() || headers.iter().all(|h| h.trim().is_empty()) {
        return match col_count {
            1 => WikiAugmentCols {
                icon: 0,
                name: 0,
                tier: None,
                set_col: None,
                effect: 0,
            },
            2 => WikiAugmentCols {
                icon: 0,
                name: 1,
                tier: None,
                set_col: None,
                effect: 1,
            },
            3 => WikiAugmentCols {
                icon: 0,
                name: 1,
                tier: None,
                set_col: None,
                effect: 2,
            },
            4 => WikiAugmentCols {
                icon: 0,
                name: 1,
                tier: Some(2),
                set_col: None,
                effect: 3,
            },
            _ => WikiAugmentCols {
                icon: 0,
                name: 1,
                tier: Some(2),
                set_col: Some(3),
                effect: 4.min(last),
            },
        };
    }

    let mut icon_o = None;
    let mut name_o = None;
    let mut tier_o = None;
    let mut set_o = None;
    let mut effect_o = None;
    for (i, h) in headers.iter().enumerate() {
        let low = h.to_lowercase();
        if low.contains("icon") {
            icon_o = Some(i);
            continue;
        }
        if low.contains("effect") || low.contains("description") {
            effect_o = Some(i);
            continue;
        }
        if low.contains("tier") {
            tier_o = Some(i);
            continue;
        }
        if low.contains("set") {
            set_o = Some(i);
            continue;
        }
        if low.contains("augment") || (low.contains("name") && !low.contains("user")) {
            name_o = Some(i);
        }
    }

    let icon = icon_o.unwrap_or(0);
    let mut name = name_o.unwrap_or(1.min(last));
    let mut effect = effect_o.unwrap_or(last);
    if effect == name && col_count > 1 {
        effect = last;
    }
    if name >= col_count {
        name = name.min(last);
    }
    if effect >= col_count {
        effect = last;
    }
    WikiAugmentCols {
        icon,
        name,
        tier: tier_o,
        set_col: set_o,
        effect,
    }
}

fn slugify_augment_id(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    s.trim_matches('-').chars().take(96).collect()
}

fn augment_title_from_icon_url(icon_url: &str) -> Option<String> {
    let u = icon_url.split('?').next().unwrap_or(icon_url);
    for seg in u.rsplit('/') {
        let lower = seg.to_lowercase();
        if !lower.contains("_mayhem_augment") {
            continue;
        }
        let name = seg.split('?').next()?;
        let fname = name.strip_prefix("80px-").unwrap_or(name);
        let base = fname
            .strip_suffix(".png")
            .or_else(|| fname.strip_suffix(".webp"))
            .unwrap_or(fname);
        let l = base.to_lowercase();
        let stem = if let Some(i) = l.find("_mayhem_augment") {
            &base[..i]
        } else {
            base
        };
        if stem.is_empty() {
            continue;
        }
        return Some(stem.replace('_', " ").trim().to_string());
    }
    None
}

fn derive_augment_title(plain: &str, icon_url: &Option<String>) -> String {
    let t = plain.trim();
    let unknown = t == "???"
        || t.is_empty()
        || t.chars().all(|c| c == '?' || c.is_whitespace());
    if unknown {
        return icon_url
            .as_ref()
            .and_then(|u| augment_title_from_icon_url(u))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| t.to_string());
    }
    t.to_string()
}

fn strip_html_to_plain(html: &str) -> String {
    let mut s = html.to_string();
    while let Some(a) = s.find('<') {
        match s[a..].find('>') {
            Some(b) => s.replace_range(a..=a + b, " "),
            None => break,
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn normalize_league_wiki_html_fragment(html: &str) -> String {
    html.replace(r#"href="/"#, r#"href="https://wiki.leagueoflegends.com/"#)
        .replace(r#"src="/"#, r#"src="https://wiki.leagueoflegends.com/"#)
        .replace(r#"href="//"#, r#"href="https://"#)
        .replace(r#"src="//"#, r#"src="https://"#)
}

fn parse_set_cell_augment(cell: ElementRef<'_>) -> (String, Option<String>) {
    let Ok(img_sel) = Selector::parse("img") else {
        return (wiki_cell_plain_text(cell), None);
    };
    let Ok(a_sel) = Selector::parse("a") else {
        return (wiki_cell_plain_text(cell), None);
    };
    let icon = cell
        .select(&img_sel)
        .next()
        .and_then(img_url_from_element)
        .map(|u| clean_wiki_asset_url(&u));
    let label = cell
        .select(&a_sel)
        .next()
        .map(|a| {
            a.text()
                .collect::<Vec<_>>()
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| wiki_cell_plain_text(cell));
    (label.trim().to_string(), icon)
}

/// Полные строки таблицы Augments (иконка, HTML эффекта, тир, сет).
pub fn parse_aram_mayhem_augmentations_detailed(html: &str) -> Vec<MayhemAugmentation> {
    let Ok(table_sel) = Selector::parse(
        "#mw-content-text table.wikitable, .mw-parser-output table.wikitable",
    ) else {
        return vec![];
    };
    let document = Html::parse_document(html);
    let tr_sel = Selector::parse("tr").unwrap();
    let th_sel = Selector::parse("th").unwrap();
    let img_sel = Selector::parse("img").unwrap();

    let mut best_table: Option<ElementRef<'_>> = None;
    let mut best_rows = 0u32;
    for table in document.select(&table_sel) {
        let mut data_rows = 0u32;
        for tr in table.select(&tr_sel) {
            let cells = wiki_row_direct_cells(tr);
            if cells.len() >= 2 {
                data_rows += 1;
            }
        }
        if data_rows > best_rows {
            best_rows = data_rows;
            best_table = Some(table);
        }
    }

    let Some(table) = best_table else {
        return vec![];
    };

    let rows: Vec<_> = table.select(&tr_sel).collect();
    if rows.is_empty() {
        return vec![];
    }

    let mut header_texts: Vec<String> = vec![];
    let mut start_data = 0usize;
    if let Some(first) = rows.first() {
        if first.select(&th_sel).next().is_some() {
            for cell in wiki_row_direct_cells(*first) {
                header_texts.push(
                    cell.text().collect::<Vec<_>>().join(" ").trim().to_string(),
                );
            }
            start_data = 1;
        }
    }

    let col_count = rows
        .iter()
        .skip(start_data)
        .find_map(|r| {
            let c = wiki_row_direct_cells(*r);
            if c.len() >= 2 {
                Some(c.len())
            } else {
                None
            }
        })
        .unwrap_or_else(|| header_texts.len().max(5));

    let cols = infer_augment_columns(col_count, &header_texts);

    let mut out = Vec::new();
    let mut aug_idx = 0usize;

    for row in rows.iter().skip(start_data) {
        let cells = wiki_row_direct_cells(*row);
        if cells.len() < 2 {
            continue;
        }
        let name_cell = match cells.get(cols.name) {
            Some(c) => *c,
            None => continue,
        };
        let plain_name = wiki_cell_plain_text(name_cell);
        let icon_cell = cells.get(cols.icon).copied().or_else(|| cells.first().copied());
        let image_url = icon_cell
            .and_then(|c| c.select(&img_sel).next())
            .and_then(img_url_from_element)
            .map(|u| clean_wiki_asset_url(&u));

        let title = derive_augment_title(&plain_name, &image_url);
        if title.is_empty() {
            continue;
        }

        let effect_html = cells
            .get(cols.effect)
            .map(|c| normalize_league_wiki_html_fragment(&c.inner_html()))
            .unwrap_or_default();

        let tier = cols
            .tier
            .and_then(|ti| cells.get(ti))
            .map(|c| wiki_cell_plain_text(*c))
            .unwrap_or_default();

        let (set_label, set_icon_url) = cols
            .set_col
            .and_then(|si| cells.get(si))
            .map(|c| parse_set_cell_augment(*c))
            .unwrap_or_else(|| (String::new(), None));

        let slug = slugify_augment_id(&title);
        let id = format!("mayhem-aug-{aug_idx}-{slug}");
        aug_idx += 1;

        out.push(MayhemAugmentation {
            id,
            title,
            icon_url: image_url,
            effect_html,
            tier,
            set_label,
            set_icon_url,
        });
    }

    out
}

fn mayhem_augmentations_to_patch_notes(rows: &[MayhemAugmentation]) -> Vec<PatchNoteEntry> {
    rows.iter()
        .map(|m| {
            let effect_plain = strip_html_to_plain(&m.effect_html);
            let mut summary_bits = vec![m.tier.clone()];
            if !m.set_label.is_empty() {
                summary_bits.push(m.set_label.clone());
            }
            let summary = summary_bits.join(" · ");
            let slug = slugify_augment_id(&m.title);
            let id = format!("aug-{slug}");
            let details = if effect_plain.is_empty() {
                vec![]
            } else {
                vec![ChangeBlock {
                    title: None,
                    icon_url: None,
                    changes: vec![effect_plain],
                }]
            };
            PatchNoteEntry {
                id,
                title: m.title.clone(),
                image_url: m.icon_url.clone(),
                category: PatchCategory::ModeAramAugments,
                change_type: ChangeType::None,
                summary,
                details,
                icon_candidates: None,
            }
        })
        .collect()
}

pub struct Scraper {
    client: reqwest::Client,
}

fn wrap_wiki_parse_fragment_as_document(fragment: &str) -> String {
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><div id=\"mw-content-text\">{fragment}</div></body></html>"
    )
}

impl Scraper {
    pub fn http_client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn new() -> Result<Self> {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::USER_AGENT,
            header::HeaderValue::from_static(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            ),
        );
        headers.insert(header::ACCEPT, header::HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"));
        headers.insert(header::ACCEPT_LANGUAGE, header::HeaderValue::from_static("en-US,en;q=0.9,ru;q=0.8"));
        headers.insert(
            header::HeaderName::from_static("sec-ch-ua"),
            header::HeaderValue::from_static(r#""Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24""#),
        );
        headers.insert(
            header::HeaderName::from_static("sec-ch-ua-mobile"),
            header::HeaderValue::from_static("?0"),
        );
        headers.insert(
            header::HeaderName::from_static("sec-ch-ua-platform"),
            header::HeaderValue::from_static("\"Windows\""),
        );

        let client = reqwest::Client::builder()
            .default_headers(headers)
            .cookie_store(true)
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(90))
            .build()?;

        Ok(Self { client })
    }

    /// MediaWiki API — чаще проходит Cloudflare, чем сырой HTML (меньше 403 у клиентов).
    async fn fetch_wiki_parse_fragment(
        &self,
        wiki_lang: &str,
        page_title: &str,
    ) -> Result<String> {
        let base = format!("{LEAGUE_WIKI_ORIGIN}/{wiki_lang}/api.php");
        let url = Url::parse_with_params(
            &base,
            &[
                ("action", "parse"),
                ("page", page_title),
                ("prop", "text"),
                ("format", "json"),
            ],
        )?;
        let resp = self.client.get(url).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("wiki parse API HTTP {}", resp.status());
        }
        let v: serde_json::Value = resp.json().await?;
        if let Some(err) = v.get("error").and_then(|e| e.get("info")).and_then(|x| x.as_str()) {
            anyhow::bail!("wiki parse API error: {err}");
        }
        let html = v["parse"]["text"]["*"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("wiki parse: missing parse.text"))?;
        Ok(html.to_string())
    }

    async fn get_league_wiki_html(&self, wiki_path: &str) -> Result<String> {
        let url = format!("{LEAGUE_WIKI_ORIGIN}{wiki_path}");
        let resp = self
            .client
            .get(&url)
            .header(
                header::REFERER,
                header::HeaderValue::from_static("https://wiki.leagueoflegends.com/en-us/"),
            )
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("wiki augments HTTP {}", resp.status());
        }
        Ok(resp.text().await?)
    }

    async fn get_league_wiki_html_with_extra_headers(&self, wiki_path: &str) -> Result<String> {
        let url = format!("{LEAGUE_WIKI_ORIGIN}{wiki_path}");
        let resp = self
            .client
            .get(&url)
            .header(
                header::REFERER,
                header::HeaderValue::from_static("https://wiki.leagueoflegends.com/en-us/"),
            )
            .header(header::HeaderName::from_static("sec-fetch-dest"), "document")
            .header(header::HeaderName::from_static("sec-fetch-mode"), "navigate")
            .header(header::HeaderName::from_static("sec-fetch-site"), "cross-site")
            .header(header::HeaderName::from_static("upgrade-insecure-requests"), "1")
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("wiki augments HTTP {}", resp.status());
        }
        Ok(resp.text().await?)
    }

    async fn load_aram_mayhem_augments_wiki_html(&self) -> Result<String> {
        const STEP: Duration = Duration::from_secs(50);
        let path = "/en-us/ARAM:_Mayhem/Augments";
        let page = "ARAM:_Mayhem/Augments";

        let api = tokio::time::timeout(STEP, self.fetch_wiki_parse_fragment("en-us", page)).await;
        match api {
            Ok(Ok(frag)) => Ok(wrap_wiki_parse_fragment_as_document(&frag)),
            Ok(Err(e_api)) => {
                let get = tokio::time::timeout(STEP, self.get_league_wiki_html(path)).await;
                match get {
                    Ok(Ok(html)) => Ok(html),
                    Ok(Err(e_get)) => tokio::time::timeout(STEP, self.get_league_wiki_html_with_extra_headers(path))
                        .await
                        .map_err(|_| {
                            anyhow::anyhow!(
                                "wiki augments: timeout GET+hdr (API {e_api}; GET {e_get})"
                            )
                        })?
                        .map_err(|e3| {
                            anyhow::anyhow!("wiki augments: API {e_api}; GET {e_get}; GET+hdr {e3}")
                        }),
                    Err(_) => Err(anyhow::anyhow!(
                        "wiki augments: timeout GET (API {e_api})"
                    )),
                }
            }
            Err(_) => {
                let get = tokio::time::timeout(STEP, self.get_league_wiki_html(path)).await;
                match get {
                    Ok(Ok(html)) => Ok(html),
                    Ok(Err(e_get)) => tokio::time::timeout(STEP, self.get_league_wiki_html_with_extra_headers(path))
                        .await
                        .map_err(|_| {
                            anyhow::anyhow!("wiki augments: timeout GET+hdr (GET {e_get})")
                        })?
                        .map_err(|e3| {
                            anyhow::anyhow!("wiki augments: GET {e_get}; GET+hdr {e3}")
                        }),
                    Err(_) => Err(anyhow::anyhow!("wiki augments: timeout API+GET")),
                }
            }
        }
    }

    pub async fn fetch_all_champions_ddragon(&self) -> Result<Vec<(String, String, String, String, String)>> {
        let ver_url = "https://ddragon.leagueoflegends.com/api/versions.json";
        let versions: Vec<String> = self.client.get(ver_url).send().await?.json().await?;
        let latest = versions.first().map(|s| s.as_str()).unwrap_or("14.23.1");

        let ru_url = format!(
            "https://ddragon.leagueoflegends.com/cdn/{}/data/ru_RU/champion.json",
            latest
        );
        let en_url = format!(
            "https://ddragon.leagueoflegends.com/cdn/{}/data/en_US/champion.json",
            latest
        );

        let (ru_resp, en_resp) = tokio::try_join!(
            self.client.get(&ru_url).send(),
            self.client.get(&en_url).send(),
        )?;

        let ru_json: serde_json::Value = ru_resp.json().await?;
        let en_json: serde_json::Value = en_resp.json().await?;

        let mut champs = Vec::new();
        if let Some(data_ru) = ru_json.get("data").and_then(|d| d.as_object()) {
            if let Some(data_en) = en_json.get("data").and_then(|d| d.as_object()) {
                for (key, val_ru) in data_ru {
                    let val_en = data_en.get(key).cloned().unwrap_or(serde_json::Value::Null);
                    let name_ru = val_ru
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name_en = val_en
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let id = val_ru
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let champion_key = val_ru
                        .get("key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let icon_url = format!(
                        "https://ddragon.leagueoflegends.com/cdn/{}/img/champion/{}.png",
                        latest, id
                    );
                    // Возвращаем: (name_ru, name_en, icon_url, champion_key, champion_id)
                    champs.push((name_ru, name_en, icon_url, champion_key, id));
                }
            }
        }
        champs.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(champs)
    }

    pub async fn fetch_latest_ddragon_version(&self) -> Result<Option<String>> {
        let url = "https://ddragon.leagueoflegends.com/api/versions.json";
        match self.client.get(url).send().await {
            Ok(resp) => {
                if let Ok(versions) = resp.json::<Vec<String>>().await {
                    if let Some(latest) = versions.first() {
                        return Ok(Some(latest.clone()));
                    }
                }
                Ok(None)
            },
            Err(_) => Ok(None)
        }
    }

    async fn patch_tags_list_contains_version(&self, tags_url: &str, version: &str) -> bool {
        let Ok(resp) = self.client.get(tags_url).send().await else {
            return false;
        };
        let Ok(text) = resp.text().await else {
            return false;
        };
        let document = Html::parse_document(&text);
        let link_selector = Selector::parse("a[href*='patch-']").unwrap();
        let re = Regex::new(r"patch-(\d+)-(\d+)-notes").unwrap();
        for link in document.select(&link_selector) {
            if let Some(href) = link.value().attr("href") {
                if let Some(caps) = re.captures(href) {
                    let patch_version = format!("{}.{}", &caps[1], &caps[2]);
                    if patch_version == version {
                        return true;
                    }
                }
            }
        }
        false
    }

    pub async fn check_patch_notes_exists(&self, version: &str, patch_notes_locale: &str) -> bool {
        let loc = normalize_patch_notes_locale(patch_notes_locale);
        let primary = riot_news_region_path(loc);
        let secondary = if primary == "ru-ru" { "en-gb" } else { "ru-ru" };
        for region in [primary, secondary] {
            let url = format!(
                "https://www.leagueoflegends.com/{}/news/tags/patch-notes/",
                region
            );
            if self.patch_tags_list_contains_version(&url, version).await {
                return true;
            }
        }
        false
    }

    pub async fn fetch_available_patches_with_limit(&self, limit: usize) -> Result<Vec<String>> {
        // Используем патчи из DDragon для согласования с форматом статистики
        let ver_url = "https://ddragon.leagueoflegends.com/api/versions.json";
        let mut patches = Vec::new();
        
        if let Ok(resp) = self.client.get(ver_url).send().await {
            if let Ok(versions) = resp.json::<Vec<String>>().await {
                for version in versions {
                    let parts: Vec<&str> = version.split('.').collect();
                    if parts.len() >= 2 {
                        let major: i32 = parts[0].parse().unwrap_or(-1);
                        let minor: i32 = parts[1].parse().unwrap_or(-1);
                        if major < 0 || minor < 0 {
                            continue;
                        }
                        let patch = ddragon_pair_to_display(major, minor);
                        if !patches.contains(&patch) {
                            patches.push(patch);
                        }
                    }
                }
            }
        }
        
        // Если DDragon недоступен, используем fallback
        if patches.is_empty() {
            patches = (14..=24)
                .rev()
                .map(|min| ddragon_pair_to_display(15, min))
                .collect();
        }

        patches.sort_by(|a, b| {
            let parts_a: Vec<&str> = a.split('.').collect();
            let parts_b: Vec<&str> = b.split('.').collect();
            let major_a = parts_a.get(0).unwrap_or(&"0").parse::<i32>().unwrap_or(0);
            let minor_a = parts_a.get(1).unwrap_or(&"0").parse::<i32>().unwrap_or(0);
            let major_b = parts_b.get(0).unwrap_or(&"0").parse::<i32>().unwrap_or(0);
            let minor_b = parts_b.get(1).unwrap_or(&"0").parse::<i32>().unwrap_or(0);

            if major_a != major_b { major_b.cmp(&major_a) } else { minor_b.cmp(&minor_a) }
        });

        let safe_limit = limit.clamp(1, 100);
        patches.truncate(safe_limit);

        Ok(patches)
    }

    pub async fn fetch_available_patches(&self) -> Result<Vec<String>> {
        self.fetch_available_patches_with_limit(20).await
    }

    pub async fn fetch_current_meta(&self, patch_version: &str, patch_notes_locale: &str) -> Result<PatchData> {
        let mut champions = match self.scrape_leagueofgraphs().await {
            Ok(c) if !c.is_empty() => c,
            _ => vec![]
        };
        
        if champions.is_empty() {
             if let Ok(c) = self.scrape_metasrc().await {
                 if !c.is_empty() { champions = c; }
             }
        }

        let loc = normalize_patch_notes_locale(patch_notes_locale);
        let (patch_notes, banner_url) = self
            .scrape_riot_patch_notes(patch_version, loc)
            .await
            .unwrap_or_else(|_| (vec![], None));

        if champions.is_empty() && !patch_notes.is_empty() {
            for note in &patch_notes {
                if note.category == PatchCategory::Champions {
                    champions.push(ChampionStats {
                        id: note.title.clone(),
                        name: note.title.clone(),
                        tier: "?".to_string(),
                        role: LaneRole::Mid, 
                        win_rate: 50.0,
                        pick_rate: 0.0,
                        ban_rate: 0.0,
                        image_url: note.image_url.clone(),
                        core_items: vec![],
                        popular_runes: vec![],
                    });
                }
            }
        }

        Ok(PatchData {
            version: patch_version.to_string(),
            fetched_at: Utc::now(),
            champions,
            patch_notes,
            banner_url,
            patch_notes_locale: Some(loc.to_string()),
        })
    }

    fn clean_cdn_image_url(url: &str) -> String {
        let u = url.trim();
        if u.contains("akamaihd.net") && u.contains("?f=") {
            if let Some(pos) = u.find("?f=") {
                return u[pos + 3..].to_string();
            }
        }
        u.to_string()
    }

    /// Баннер статьи (Sanity / og:image), как на странице патч-нотов LoL.
    pub(crate) fn extract_article_banner(html: &str) -> Option<String> {
        let document = Html::parse_document(html);
        let meta_sel = Selector::parse("meta").ok()?;
        for meta in document.select(&meta_sel) {
            let prop = meta
                .value()
                .attr("property")
                .or_else(|| meta.value().attr("name"));
            let is_og = prop == Some("og:image");
            let is_tw = prop == Some("twitter:image") || prop == Some("twitter:image:src");
            if !is_og && !is_tw {
                continue;
            }
            if let Some(content) = meta.value().attr("content") {
                let cleaned = Self::clean_cdn_image_url(content);
                if !cleaned.is_empty() {
                    return Some(cleaned);
                }
            }
        }
        None
    }

    #[allow(dead_code)] // тесты + совместимость
    pub(crate) fn parse_aram_mayhem_augments_wiki_html(html: &str) -> Vec<PatchNoteEntry> {
        mayhem_augmentations_to_patch_notes(&parse_aram_mayhem_augmentations_detailed(html))
    }

    pub async fn fetch_aram_mayhem_augmentations_bundle_en(
        &self,
    ) -> Result<(Vec<PatchNoteEntry>, Vec<MayhemAugmentation>)> {
        let text = self.load_aram_mayhem_augments_wiki_html().await?;
        let detailed = parse_aram_mayhem_augmentations_detailed(&text);
        let notes = mayhem_augmentations_to_patch_notes(&detailed);
        Ok((notes, detailed))
    }

    pub async fn fetch_aram_mayhem_augmentations_bundle_ru(
        &self,
    ) -> Result<(Vec<PatchNoteEntry>, Vec<MayhemAugmentation>)> {
        self.fetch_aram_mayhem_augmentations_bundle_en().await
    }

    pub async fn fetch_aram_mayhem_augments_wiki(&self) -> Result<Vec<PatchNoteEntry>> {
        Ok(self.fetch_aram_mayhem_augmentations_bundle_en().await?.0)
    }

    pub async fn fetch_aram_mayhem_augments_wiki_ru(&self) -> Result<Vec<PatchNoteEntry>> {
        Ok(self.fetch_aram_mayhem_augmentations_bundle_ru().await?.0)
    }

    async fn scrape_riot_patch_notes(
        &self,
        version: &str,
        patch_notes_locale: &str,
    ) -> Result<(Vec<PatchNoteEntry>, Option<String>)> {
        let slug = version.replace(".", "-");
        let primary = riot_news_region_path(patch_notes_locale);
        let secondary = if primary == "ru-ru" { "en-gb" } else { "ru-ru" };
        let mut urls = Vec::with_capacity(4);
        for region in [primary, secondary] {
            urls.push(format!(
                "https://www.leagueoflegends.com/{}/news/game-updates/league-of-legends-patch-{}-notes/",
                region, slug
            ));
            urls.push(format!(
                "https://www.leagueoflegends.com/{}/news/game-updates/patch-{}-notes/",
                region, slug
            ));
        }
        for url in urls {
            let Ok(resp) = self.client.get(&url).send().await else {
                continue;
            };
            if !resp.status().is_success() {
                continue;
            }
            let Ok(text) = resp.text().await else {
                continue;
            };
            let banner = Self::extract_article_banner(&text);
            let champion_slugs = self.fetch_champion_slug_set().await;
            let notes = self.parse_riot_patch_notes_html(&text, &champion_slugs, patch_notes_locale);
            if !notes.is_empty() {
                return Ok((notes, banner));
            }
        }
        Ok((vec![], None))
    }

    async fn fetch_champion_slug_set(&self) -> HashSet<String> {
        let mut set = HashSet::new();
        let ver = match self.fetch_latest_ddragon_version().await {
            Ok(Some(v)) => v,
            _ => return set,
        };
        let url = format!(
            "https://ddragon.leagueoflegends.com/cdn/{}/data/en_US/champion.json",
            ver
        );
        let Ok(resp) = self.client.get(&url).send().await else {
            return set;
        };
        let Ok(json) = resp.json::<serde_json::Value>().await else {
            return set;
        };
        if let Some(data) = json.get("data").and_then(|d| d.as_object()) {
            for (key, val) in data {
                set.insert(key.to_lowercase());
                if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                    set.insert(id.to_lowercase());
                }
            }
        }
        set
    }

    pub(crate) fn parse_riot_patch_notes_html(
        &self,
        html: &str,
        champion_slugs: &HashSet<String>,
        patch_notes_locale: &str,
    ) -> Vec<PatchNoteEntry> {
        let bugfix_entry_title = if patch_notes_locale == "en" {
            "Bug fix"
        } else {
            "Исправление ошибки"
        };
        let document = Html::parse_document(html);
        let mut notes = Vec::new();
        
        let container_sel = Selector::parse("#patch-notes-container").unwrap();
        
        if let Some(container) = document.select(&container_sel).next() {
            let mut current_category = PatchCategory::Unknown;
            
                    let h2_sel = Selector::parse("h2").unwrap();
                    let change_block_sel = Selector::parse(".patch-change-block").unwrap();
                    let img_sel = Selector::parse("img").unwrap();
                    let ref_link_sel = Selector::parse("a.reference-link").unwrap();
                    let li_sel = Selector::parse("li").unwrap();
                    let ul_sel = Selector::parse("ul").unwrap();

            for child in container.children() {
                if let Some(el) = ElementRef::wrap(child) {
                    let h2_el = el.select(&h2_sel).next();
                    if let Some(h2) = h2_el {
                        let id = h2.value().id().unwrap_or("");
                        current_category = patch_category_from_section_h2_id(id, champion_slugs);
                    }
                    
                    // Helper to clean URLs from Riot's proxy
                    let clean_url = |url: Option<String>| -> Option<String> {
                        url.map(|u| {
                            if u.contains("akamaihd.net") && u.contains("?f=") {
                                if let Some(pos) = u.find("?f=") {
                                    return u[pos + 3..].to_string();
                                }
                            }
                            u
                        })
                    };
                    
                    let patch_blocks: Vec<ElementRef<'_>> = el.select(&change_block_sel).collect();

                    if !patch_blocks.is_empty() {
                    for block_el in patch_blocks {
                        let mut wrapper = block_el;
                        // Try to find inner div if it exists (common Riot structure)
                        for child_node in block_el.children() {
                            if let Some(child_el) = ElementRef::wrap(child_node) {
                                if child_el.value().name() == "div" {
                                    wrapper = child_el;
                                    break;
                                }
                            }
                        }

                        // State Machine for parsing potentially multiple champions in one block
                        let mut pending_icon: Option<String> = None;
                        let mut current_entry: Option<PatchNoteEntry> = None;

                        for child in wrapper.children() {
                            if let Some(child_el) = ElementRef::wrap(child) {
                                let tag = child_el.value().name();
                                let classes = child_el.value().classes().collect::<Vec<_>>().join(" ");

                                // Case 1a: отдельная картинка до заголовка (без reference-link)
                                if tag == "img" && pending_icon.is_none() {
                                    pending_icon = clean_url(img_url_from_element(child_el));
                                }
                                // Case 1b: <a class="reference-link"> прямой потомок (старые патчи)
                                else if tag == "a" && classes.contains("reference-link") {
                                    pending_icon = clean_url(
                                        child_el
                                            .select(&img_sel)
                                            .next()
                                            .and_then(img_url_from_element),
                                    );
                                }
                                // Case 1c: <p><a class="reference-link"><img>…</a></p> (напр. патч 26.8+)
                                else if tag == "p" {
                                    if let Some(alink) = child_el.select(&ref_link_sel).next() {
                                        pending_icon = clean_url(
                                            alink
                                                .select(&img_sel)
                                                .next()
                                                .and_then(img_url_from_element),
                                        );
                                    }
                                }
                                // Case 2: Title (H3 or .change-title) -> New Entry
                                else if (tag == "h3" || tag == "h4" || classes.contains("change-title")) && 
                                        !classes.contains("change-detail-title") && !classes.contains("ability-title") {
                                    let h4_looks_like_detail = tag == "h4"
                                        && current_entry.is_some()
                                        && !classes.contains("change-title");
                                    if h4_looks_like_detail {
                                        if let Some(entry) = current_entry.as_mut() {
                                            let detail_title = child_el.text().collect::<String>().trim().to_string();
                                            if !detail_title.is_empty() {
                                                entry.details.push(ChangeBlock {
                                                    title: Some(detail_title),
                                                    icon_url: pending_icon.take(),
                                                    changes: Vec::new(),
                                                });
                                            }
                                        }
                                        continue;
                                    }
                                    
                                    // If we have a completed entry, save it
                                    if let Some(entry) = current_entry.take() {
                                        notes.push(entry);
                                    }

                                    let title_text = child_el.text().collect::<String>().trim().to_string();
                                    if !title_text.is_empty() {
                                        current_entry = Some(PatchNoteEntry {
                                            id: title_text.clone(),
                                            title: title_text,
                                            image_url: pending_icon.take(), // Use and clear pending icon
                                            category: current_category.clone(),
                                            change_type: ChangeType::Adjusted, // Will calculate later
                                            summary: String::new(),
                                            details: Vec::new(),
                                            icon_candidates: None,
                                        });
                                    }
                                }
                                // Case 3: Summary (blockquote)
                                else if tag == "blockquote" {
                                    if let Some(entry) = current_entry.as_mut() {
                                        entry.summary = child_el.text().collect::<String>().trim().to_string();
                                    }
                                }
                                // Case 4: Ability Title (H4)
                                else if (tag == "h4") && (classes.contains("change-detail-title") || classes.contains("ability-title")) {
                                    if let Some(entry) = current_entry.as_mut() {
                                        let detail_title = child_el.text().collect::<String>().trim().to_string();
                                        let detail_icon = clean_url(
                                            child_el
                                                .select(&img_sel)
                                                .next()
                                                .and_then(img_url_from_element),
                                        );
                                        
                                        entry.details.push(ChangeBlock {
                                            title: Some(detail_title),
                                            icon_url: detail_icon,
                                            changes: Vec::new(),
                                        });
                                    }
                                }
                                // Case 5: Changes List (UL)
                                else if tag == "ul" {
                                    if let Some(entry) = current_entry.as_mut() {
                                        let mut changes = Vec::new();
                                        for li in child_el.select(&li_sel) {
                                            let text = li.text().collect::<String>().trim().to_string();
                                            if !text.is_empty() { changes.push(text); }
                                        }
                                        
                                        if !changes.is_empty() {
                                            // Attach to last block, or create new nameless block
                                            if let Some(last_block) = entry.details.last_mut() {
                                                last_block.changes.extend(changes);
                                            } else {
                                                entry.details.push(ChangeBlock {
                                                    title: None,
                                                    icon_url: None,
                                                    changes,
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        // Push the final entry from this block
                        if let Some(mut entry) = current_entry {
                            entry.change_type = self.determine_change_type(&entry.summary, &entry.details);
                            notes.push(entry);
                        }
                    }
                    } else if current_category == PatchCategory::UpcomingSkinsChromas {
                        append_upcoming_skins_chromas_notes(el, &mut notes);
                    } else if el.value().has_class("content-border", scraper::CaseSensitivity::CaseSensitive) {
                        if current_category == PatchCategory::BugFixes {
                            for ul in el.select(&ul_sel) {
                                for li in ul.select(&li_sel) {
                                    let text = li.text().collect::<String>().trim().to_string();
                                    if text.is_empty() {
                                        continue;
                                    }
                                    notes.push(PatchNoteEntry {
                                        id: format!("fix_{}", notes.len()),
                                        title: bugfix_entry_title.to_string(),
                                        image_url: None,
                                        category: current_category.clone(),
                                        change_type: ChangeType::Fix,
                                        summary: text.clone(),
                                        details: vec![ChangeBlock {
                                            title: None,
                                            icon_url: None,
                                            changes: vec![text],
                                        }],
                                        icon_candidates: None,
                                    });
                                }
                            }
                        } else if matches!(
                            current_category,
                            PatchCategory::ModeAramChaos
                                | PatchCategory::ModeAram
                                | PatchCategory::ModeArena
                                | PatchCategory::Modes
                        ) {
                            append_flat_mode_style_notes(self, el, &current_category, &mut notes);
                        }
                    }
                }
            }
        }
        notes
    }
    
    async fn scrape_leagueofgraphs(&self) -> Result<Vec<ChampionStats>> {
        let url = "https://www.leagueofgraphs.com/ru/champions/tier-list";
        if let Ok(resp) = self.client.get(url).send().await {
            if let Ok(text) = resp.text().await {
                let _document = Html::parse_document(&text);
                return Ok(vec![]); 
            }
        }
        Ok(vec![])
    }

    async fn scrape_metasrc(&self) -> Result<Vec<ChampionStats>> { Ok(vec![]) }

    fn determine_change_type(&self, summary: &str, details: &[ChangeBlock]) -> ChangeType {
        let detail_text = details
            .iter()
            .flat_map(|b| b.changes.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");
        let text = format!("{} {}", summary, detail_text);
        let text = text.trim();

        if text.is_empty() {
            return ChangeType::Adjusted;
        }
        let removal_re = Regex::new(
            r"(?i)(удал(яем|ён|ен|ено|ены|ении|ение)|убир(аем|ем)|сним(аем|ем)|отключ(аем|ен|ено)|больше не\s+(будет|существ|действ|доступ)|исчез(нет|ла|ают)?|will be removed|has been removed|removed from|no longer (available|appears|in ))",
        )
        .unwrap();
        let new_re = Regex::new(
            r"(?i)(добавляем|добавлен(о|ы)?|впервые|новый\s|новая\s|новое\s|новые\s|теперь доступн|появ(ится|ились|ятся)|introducing|we are adding|we're adding|new to league)",
        )
        .unwrap();
        if removal_re.is_match(text) {
            ChangeType::Removed
        } else if new_re.is_match(text) {
            ChangeType::New
        } else {
            let mut has_buff = false;
            let mut has_nerf = false;

            for trend in details
                .iter()
                .flat_map(|b| b.changes.iter())
                .map(|s| analyze_change_trend(s))
            {
                match trend {
                    1 => has_buff = true,
                    -1 => has_nerf = true,
                    _ => {}
                }
                if has_buff && has_nerf {
                    break;
                }
            }

            if !(has_buff || has_nerf) {
                match analyze_change_trend(text) {
                    1 => has_buff = true,
                    -1 => has_nerf = true,
                    _ => {}
                }
            }

            match (has_buff, has_nerf) {
                (true, false) => ChangeType::Buff,
                (false, true) => ChangeType::Nerf,
                _ => ChangeType::Adjusted,
            }
        }
    }
    
    pub async fn scrape_champion_details(&self, _name: &str, _role: &LaneRole) -> Result<(Vec<ItemStat>, Vec<String>)> {
        Ok((vec![], vec![]))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::models::{ChangeType, PatchCategory};

    fn non_empty_champion_slugs() -> HashSet<String> {
        HashSet::from(["aatrox".to_string()])
    }

    #[test]
    fn extracts_og_image_banner() {
        let html = r#"<!DOCTYPE html><html><head>
<meta property="og:image" content="https://cmsassets.rgpub.io/sanity/images/x.jpg?w=480">
</head><body></body></html>"#;
        let u = Scraper::extract_article_banner(html).expect("banner");
        assert!(u.contains("cmsassets.rgpub.io"));
        assert!(u.contains("x.jpg"));
    }

    #[test]
    fn parses_sibling_header_then_content_border_blocks() {
        let html = r###"<!DOCTYPE html><html><body>
<div id="patch-notes-container">
<header class="header-primary"><h2 id="patch-champions">Чемпионы</h2></header>
<div class="content-border"><div class="patch-change-block white-stone"><div>
<p><a class="reference-link" href="#"><img src="https://ddragon/x.png"></a></p>
<h3 class="change-title" id="patch-test"><a href="#">Тест</a></h3>
<blockquote class="blockquote context"><p>Сводка</p></blockquote>
<h4 class="change-detail-title ability-title">Q</h4>
<ul><li>урон увеличен с 1 до 2</li></ul>
</div></div></div>
</div></body></html>"###;
        let s = Scraper::new().unwrap();
        let notes = s.parse_riot_patch_notes_html(html, &HashSet::new(), "ru");
        assert!(!notes.is_empty(), "notes: {:?}", notes);
        assert_eq!(notes[0].title, "Тест");
        assert_eq!(
            notes[0].image_url.as_deref(),
            Some("https://ddragon/x.png"),
            "иконка из <p><a class=\"reference-link\"><img>"
        );
    }

    fn minimal_patch_block(title: &str, h2_id: &str) -> String {
        format!(
            r###"<div id="patch-notes-container">
<header class="header-primary"><h2 id="{}">S</h2></header>
<div class="content-border"><div class="patch-change-block white-stone"><div>
<h3 class="change-title">{}</h3>
<ul><li>change</li></ul>
</div></div></div>
</div>"###,
            h2_id, title,
        )
    }

    #[test]
    fn categorizes_riot_aram_mayhem_section_id() {
        let s = Scraper::new().unwrap();
        let notes =
            s.parse_riot_patch_notes_html(&minimal_patch_block("X", "patch-aram:-mayhem"), &HashSet::new(), "ru");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].category, PatchCategory::ModeAramChaos);
    }

    #[test]
    fn categorizes_riot_aram_mayhem_id_without_colon() {
        let s = Scraper::new().unwrap();
        let notes =
            s.parse_riot_patch_notes_html(&minimal_patch_block("X", "patch-aram-mayhem"), &HashSet::new(), "ru");
        assert_eq!(notes[0].category, PatchCategory::ModeAramChaos);
    }

    #[test]
    fn categorizes_riot_aram_section_id() {
        let s = Scraper::new().unwrap();
        let notes = s.parse_riot_patch_notes_html(&minimal_patch_block("X", "patch-aram"), &HashSet::new(), "ru");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].category, PatchCategory::ModeAram);
    }

    #[test]
    fn categorizes_riot_arena_section_id() {
        let s = Scraper::new().unwrap();
        let notes = s.parse_riot_patch_notes_html(&minimal_patch_block("X", "patch-arena"), &HashSet::new(), "ru");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].category, PatchCategory::ModeArena);
    }

    #[test]
    fn parses_flat_aram_mayhem_without_patch_change_block() {
        let html = r##"<div id="patch-notes-container">
<header class="header-primary"><h2 id="patch-aram:-mayhem">ARAM: Mayhem</h2></header>
<div class="content-border"><div class="white-stone accent-before"><div>
<blockquote class="blockquote context"><p>Intro</p></blockquote>
<hr class="divider">
<h4 class="change-detail-title"><strong>Champions</strong></h4>
<p><strong>Mel</strong></p>
<ul><li><strong>W</strong>: 35 ⇒ 45</li></ul>
<h4 class="change-detail-title"><strong>Items</strong></h4>
<p><strong>Locket</strong></p>
<ul><li>CD: 90 ⇒ 75</li></ul>
</div></div></div>
</div>"##;
        let s = Scraper::new().unwrap();
        let notes = s.parse_riot_patch_notes_html(html, &HashSet::new(), "en");
        assert_eq!(notes.len(), 2, "notes: {:?}", notes);
        assert_eq!(notes[0].title, "Mel");
        assert_eq!(notes[0].category, PatchCategory::ModeAramChaos);
        assert_eq!(notes[1].title, "Locket");
        assert_eq!(notes[1].category, PatchCategory::ModeAramChaos);
    }

    #[test]
    fn categorizes_clash_ranked_matchmaking_as_modes() {
        let s = Scraper::new().unwrap();
        let slugs = non_empty_champion_slugs();
        for id in [
            "patch-clash-summoner",
            "patch-ranked",
            "patch-sr-ranked-and-matchmaking",
            "patch-lane-based-autofill-matchmaking",
            "patch-swiftplay",
        ] {
            let notes = s.parse_riot_patch_notes_html(&minimal_patch_block("M", id), &slugs, "ru");
            assert_eq!(notes[0].category, PatchCategory::Modes, "id={id}");
        }
    }

    #[test]
    fn categorizes_system_sections_from_patch_26_1_ids() {
        let s = Scraper::new().unwrap();
        let slugs = non_empty_champion_slugs();
        for (id, expected) in [
            ("patch-role-quests", PatchCategory::Systems),
            (
                "patch-lobby-hostage-taking-and-player-behavior-updates",
                PatchCategory::Systems,
            ),
            ("patch-demacia-rising", PatchCategory::Systems),
            ("patch-systems", PatchCategory::Systems),
            ("patch-atakhan-blood-roses-and-feats", PatchCategory::Systems),
        ] {
            let notes = s.parse_riot_patch_notes_html(&minimal_patch_block("S", id), &slugs, "ru");
            assert_eq!(notes[0].category, expected, "id={id}");
        }
    }

    #[test]
    fn categorizes_champion_h2_by_ddragon_slug() {
        let s = Scraper::new().unwrap();
        let slugs = HashSet::from(["veigar".to_string()]);
        let notes = s.parse_riot_patch_notes_html(&minimal_patch_block("Veigar", "patch-veigar"), &slugs, "ru");
        assert_eq!(notes[0].category, PatchCategory::Champions);
    }

    #[test]
    fn parses_upcoming_skins_skin_box() {
        let s = Scraper::new().unwrap();
        let html = r###"<div id="patch-notes-container">
<header class="header-primary"><h2 id="patch-upcoming-skins-and-chromas">Upcoming</h2></header>
<div class="content-border">
<div class="skin-box">
<div class="content-border"><a class="skins" href="#"><img src="https://cdn.example.com/skin.png" alt=""></a></div>
<h4 class="skin-title">Fried Chicken King Swain</h4>
</div>
</div>
</div>"###;
        let notes = s.parse_riot_patch_notes_html(html, &non_empty_champion_slugs(), "en");
        let upcoming: Vec<_> = notes
            .iter()
            .filter(|n| n.category == PatchCategory::UpcomingSkinsChromas)
            .collect();
        assert_eq!(upcoming.len(), 1, "notes: {:?}", notes);
        assert_eq!(upcoming[0].title, "Fried Chicken King Swain");
        assert!(upcoming[0].image_url.as_deref().unwrap_or("").contains("skin.png"));
    }

    #[test]
    fn parses_upcoming_skins_h4_without_skin_box() {
        let s = Scraper::new().unwrap();
        let html = r###"<div id="patch-notes-container">
<header class="header-primary"><h2 id="patch-upcoming-skins-and-chromas">Upcoming</h2></header>
<div class="content-border">
<img src="https://cdn.example.com/fallback.png" alt="">
<h4 class="skin-title">Test Skin Only H4</h4>
</div>
</div>"###;
        let notes = s.parse_riot_patch_notes_html(html, &non_empty_champion_slugs(), "en");
        let upcoming: Vec<_> = notes
            .iter()
            .filter(|n| n.category == PatchCategory::UpcomingSkinsChromas)
            .collect();
        assert_eq!(upcoming.len(), 1, "notes: {:?}", notes);
        assert_eq!(upcoming[0].title, "Test Skin Only H4");
        assert!(upcoming[0]
            .image_url
            .as_deref()
            .unwrap_or("")
            .contains("fallback.png"));
    }

    #[test]
    fn parses_wiki_aram_mayhem_augments_table() {
        let html = r##"<div id="mw-content-text"><table class="wikitable">
<tr><th>Icon</th><th>Augment</th><th>Tier</th><th>Set</th><th>Effect</th></tr>
<tr><td><img alt="a" src="//wiki.leagueoflegends.com/images/a.png"></td><td>Fan the Hammer</td><td>Gold</td><td>1</td><td>Per missile: bonus damage.</td></tr>
</table></div>"##;
        let notes = Scraper::parse_aram_mayhem_augments_wiki_html(html);
        assert_eq!(notes.len(), 1, "notes: {:?}", notes);
        assert_eq!(notes[0].title, "Fan the Hammer");
        assert_eq!(notes[0].category, PatchCategory::ModeAramAugments);
        assert_eq!(notes[0].change_type, ChangeType::None);
        assert!(notes[0]
            .image_url
            .as_deref()
            .unwrap_or("")
            .contains("wiki.leagueoflegends.com"));
        assert!(notes[0].summary.contains("Gold"));
        assert_eq!(notes[0].details.len(), 1);
        assert!(notes[0].details[0].changes[0].contains("missile"));
    }

    #[test]
    fn change_type_removed_from_ru_wording() {
        let s = Scraper::new().unwrap();
        let html = r###"<div id="patch-notes-container">
<header class="header-primary"><h2 id="patch-systems">Системы</h2></header>
<div class="content-border"><div class="patch-change-block white-stone"><div>
<h3 class="change-title">Атакхан</h3>
<ul><li>Атакхан удалён из Ущелья призывателей.</li></ul>
</div></div></div>
</div>"###;
        let notes = s.parse_riot_patch_notes_html(html, &non_empty_champion_slugs(), "ru");
        assert_eq!(notes[0].change_type, ChangeType::Removed);
    }

    fn detail_block(changes: &[&str]) -> Vec<ChangeBlock> {
        vec![ChangeBlock {
            title: None,
            icon_url: None,
            changes: changes.iter().map(|s| s.to_string()).collect(),
        }]
    }

    #[test]
    fn classify_mundo_monster_caps_as_nerf() {
        let s = Scraper::new().unwrap();
        let ty = s.determine_change_type(
            "Снижаем скорость зачистки леса.",
            &detail_block(&[
                "Максимальный урон монстрам: 300/375/450/525/600 → 250/325/400/475/550",
                "Максимальный урон монстрам: 200% → 140%",
            ]),
        );
        assert_eq!(ty, ChangeType::Nerf);
    }

    #[test]
    fn classify_karma_stats_and_mana_as_nerf() {
        let s = Scraper::new().unwrap();
        let ty = s.determine_change_type(
            "Ослабим E и основные показатели.",
            &detail_block(&[
                "Сила атаки: 51 → 49",
                "Прирост силы атаки: 3,3 → 3,0",
                "Затраты маны: 50/55/60/65/70 → 60/65/70/75/80",
            ]),
        );
        assert_eq!(ty, ChangeType::Nerf);
    }

    #[test]
    fn classify_lillia_monster_cap_as_buff() {
        let s = Scraper::new().unwrap();
        let ty = s.determine_change_type(
            "Усиливаем зачистку леса.",
            &detail_block(&["Максимальный урон монстрам: 65 → 70–180 (зависит от уровня)"]),
        );
        assert_eq!(ty, ChangeType::Buff);
    }

    #[test]
    fn classify_lucian_cooldown_and_mana_as_buff() {
        let s = Scraper::new().unwrap();
        let ty = s.determine_change_type(
            "Сократим перезарядку и затраты маны.",
            &detail_block(&[
                "Перезарядка: 18/17/16/15/14 секунд → 16/15,5/15/14,5/14 секунд",
                "Затраты маны: 40/30/20/10/0 → 32/24/16/8/0",
            ]),
        );
        assert_eq!(ty, ChangeType::Buff);
    }
}
