use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::Path;

use crate::db::Database;
use crate::models::{IconSourceEntry, StaticCatalogRow};
use crate::scraper::Scraper;

const CD_BASE: &str = "https://raw.communitydragon.org/latest";
const DDRAGON: &str = "https://ddragon.leagueoflegends.com";

fn ddragon_champion_icon(ver: &str, champ_id: &str) -> String {
    format!("{}/cdn/{}/img/champion/{}.png", DDRAGON, ver, champ_id)
}

fn ddragon_item_icon(ver: &str, item_id: &str) -> String {
    format!("{}/cdn/{}/img/item/{}.png", DDRAGON, ver, item_id)
}

fn ddragon_spell_icon(ver: &str, spell_image_file: &str) -> String {
    format!("{}/cdn/{}/img/spell/{}", DDRAGON, ver, spell_image_file)
}

fn cd_item_icon_url(icon_path: &str) -> String {
    if icon_path.contains("Items/Icons2D") || icon_path.contains("items/icons2d") {
        if let Some(name) = icon_path.rsplit('/').next() {
            let lower = name.to_lowercase();
            return format!(
                "{}/plugins/rcp-be-lol-game-data/global/default/assets/items/icons2d/{}",
                CD_BASE, lower
            );
        }
    }
    let rest = icon_path.trim_start_matches("/lol-game-data/");
    format!(
        "{}/plugins/rcp-be-lol-game-data/global/default/{}",
        CD_BASE, rest
    )
}

fn cd_generic_plugin_url(strip: &str) -> String {
    let rest = strip.trim_start_matches("/lol-game-data/");
    format!(
        "{}/plugins/rcp-be-lol-game-data/global/default/{}",
        CD_BASE, rest
    )
}

/// Kiwi / Mayhem / ARAM-специфичные пути vs Cherry (Arena) vs Strawberry (Swarm).
fn augment_pool_from_icon_path(icon_path: &str) -> &'static str {
    let p = icon_path.to_lowercase();
    if p.contains("/strawberry/") {
        return "swarm";
    }
    if p.contains("/kiwi/")
        || p.contains("mayhem")
        || p.contains("aram_")
        || p.contains("/maps/particles/kiwi/")
    {
        return "mayhem";
    }
    if p.contains("/cherry/") {
        return "arena";
    }
    "unknown"
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {} for {}", resp.status(), url);
    }
    let v: Value = resp.json().await.with_context(|| format!("json {}", url))?;
    Ok(v)
}

pub async fn try_seed_manifest_meta(db: &Database) -> Result<()> {
    if db.static_catalog_count().await? > 0 {
        return Ok(());
    }
    if db.get_game_assets_meta().await?.is_some() {
        return Ok(());
    }
    let manifest: Value =
        serde_json::from_str(include_str!("../resources/manifest.json")).unwrap_or_else(|_| json!({}));
    let ver = manifest
        .get("ddragon_version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");
    db.insert_seed_game_assets_meta(ver).await?;
    Ok(())
}

async fn cache_https_icon_to_dir(
    client: &reqwest::Client,
    dir: &Path,
    kind: &str,
    stable_id: &str,
    https_url: &str,
) -> Option<IconSourceEntry> {
    if !https_url.starts_with("http") {
        return None;
    }
    let safe: String = stable_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let kind_dir = dir.join(kind);
    let path = kind_dir.join(format!("{safe}.png"));
    if path.exists() {
        return Some(IconSourceEntry {
            t: "file".into(),
            url: Some(path.to_string_lossy().into_owned()),
        });
    }
    let resp = client.get(https_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    std::fs::create_dir_all(&kind_dir).ok()?;
    std::fs::write(&path, &bytes).ok()?;
    Some(IconSourceEntry {
        t: "file".into(),
        url: Some(path.to_string_lossy().into_owned()),
    })
}

fn prepend_file_source(icon_sources: &mut Vec<IconSourceEntry>, file_source: Option<IconSourceEntry>) {
    let Some(f) = file_source else {
        return;
    };
    let Some(file_url) = f.url.as_deref() else {
        return;
    };
    icon_sources.retain(|s| s.url.as_deref() != Some(file_url));
    icon_sources.insert(0, f);
}

async fn latest_ddragon_version(client: &reqwest::Client) -> Result<String> {
    let arr: Vec<String> = fetch_json(
        client,
        &format!("{}/api/versions.json", DDRAGON),
    )
    .await?
    .as_array()
    .context("versions array")?
    .iter()
    .filter_map(|x| x.as_str().map(|s| s.to_string()))
    .collect();
    arr.first()
        .cloned()
        .context("empty versions")
}

pub async fn refresh_game_assets(
    scraper: &Scraper,
    db: &Database,
    icon_cache_dir: Option<&Path>,
    force: bool,
) -> Result<()> {
    if !force {
        let count = db.static_catalog_count().await.unwrap_or(0);
        if count > 0 {
            if let Ok(Some(meta)) = db.get_game_assets_meta().await {
                if let Ok(t) = chrono::DateTime::parse_from_rfc3339(&meta.catalog_built_at) {
                    let age = chrono::Utc::now().signed_duration_since(t.with_timezone(&chrono::Utc));
                    if age.num_hours() < 24 {
                        return Ok(());
                    }
                }
            }
        }
    }

    let client = scraper.http_client();
    let ver = latest_ddragon_version(client).await?;
    let mut rows: Vec<StaticCatalogRow> = Vec::new();

    let ru_ch = fetch_json(
        client,
        &format!(
            "{}/cdn/{}/data/ru_RU/champion.json",
            DDRAGON, ver
        ),
    )
    .await?;
    let en_ch = fetch_json(
        client,
        &format!(
            "{}/cdn/{}/data/en_US/champion.json",
            DDRAGON, ver
        ),
    )
    .await?;

    if let (Some(data_ru), Some(data_en)) = (
        ru_ch.get("data").and_then(|d| d.as_object()),
        en_ch.get("data").and_then(|d| d.as_object()),
    ) {
        for (key, val_ru) in data_ru {
            let val_en = data_en.get(key);
            let name_ru = val_ru
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name_en = val_en
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let id = val_ru
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(key)
                .to_string();
            let champ_key = val_ru
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let icon = ddragon_champion_icon(&ver, &id);
            let mut icon_sources = vec![IconSourceEntry {
                t: "ddragon".into(),
                url: Some(icon.clone()),
            }];
            if let Some(dir) = icon_cache_dir {
                if let Some(f) =
                    cache_https_icon_to_dir(client, dir, "champion", &id, &icon).await
                {
                    icon_sources.insert(0, f);
                }
            }
            rows.push(StaticCatalogRow {
                kind: "champion".into(),
                stable_id: id.clone(),
                name_ru,
                name_en,
                riot_augment_id: None,
                cd_meta: Some(json!({"key": champ_key})),
                icon_sources,
                source: "ddragon".into(),
            });
        }
    }

    let ru_it = fetch_json(
        client,
        &format!("{}/cdn/{}/data/ru_RU/item.json", DDRAGON, ver),
    )
    .await?;
    let en_it = fetch_json(
        client,
        &format!("{}/cdn/{}/data/en_US/item.json", DDRAGON, ver),
    )
    .await?;

    let cd_items: Value = match client
        .get(&format!(
            "{}/plugins/rcp-be-lol-game-data/global/default/v1/items.json",
            CD_BASE
        ))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(json!([])),
        _ => json!([]),
    };

    let mut cd_by_id: std::collections::HashMap<i64, Value> = std::collections::HashMap::new();
    if let Some(arr) = cd_items.as_array() {
        for it in arr {
            if let Some(id) = it.get("id").and_then(|x| x.as_i64()) {
                cd_by_id.insert(id, it.clone());
            }
        }
    }

    if let (Some(data_ru), Some(data_en)) = (
        ru_it.get("data").and_then(|d| d.as_object()),
        en_it.get("data").and_then(|d| d.as_object()),
    ) {
        for (id_s, val_ru) in data_ru {
            let name_ru = val_ru
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name_en = data_en
                .get(id_s)
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let dd_icon = ddragon_item_icon(&ver, id_s);
            let mut icon_sources = vec![IconSourceEntry {
                t: "ddragon".into(),
                url: Some(dd_icon.clone()),
            }];
            if let Some(dir) = icon_cache_dir {
                let file_icon = cache_https_icon_to_dir(client, dir, "item", id_s, &dd_icon).await;
                prepend_file_source(&mut icon_sources, file_icon);
            }
            let mut cd_meta: Option<Value> = None;
            if let Ok(id_n) = id_s.parse::<i64>() {
                if let Some(cd) = cd_by_id.get(&id_n) {
                    cd_meta = Some(cd.clone());
                    if let Some(p) = cd.get("iconPath").and_then(|x| x.as_str()) {
                        let u = cd_item_icon_url(p);
                        let entry = IconSourceEntry {
                            t: "cdragon".into(),
                            url: Some(u),
                        };
                        if let Some(dir) = icon_cache_dir {
                            if let Some(url) = entry.url.as_ref() {
                                let file_icon = cache_https_icon_to_dir(client, dir, "item", id_s, url).await;
                                prepend_file_source(&mut icon_sources, file_icon);
                            }
                        }
                        icon_sources.push(entry);
                    }
                }
            }
            let ddragon_map_ids: Option<Vec<u32>> = val_ru
                .get("maps")
                .and_then(|x| x.as_object())
                .map(|m| {
                    m.iter()
                        .filter(|(_, on)| on.as_bool() == Some(true))
                        .filter_map(|(k, _)| k.parse().ok())
                        .collect::<Vec<u32>>()
                })
                .filter(|v| !v.is_empty());
            match (&mut cd_meta, ddragon_map_ids.as_ref()) {
                (Some(cm), Some(mids)) => {
                    if let Some(obj) = cm.as_object_mut() {
                        if obj.get("mapIds").is_none() {
                            obj.insert("mapIds".to_string(), json!(mids));
                        }
                    }
                }
                (None, Some(mids)) => {
                    cd_meta = Some(json!({ "mapIds": mids }));
                }
                _ => {}
            }
            rows.push(StaticCatalogRow {
                kind: "item".into(),
                stable_id: id_s.clone(),
                name_ru,
                name_en,
                riot_augment_id: None,
                cd_meta,
                icon_sources,
                source: "merged".into(),
            });
        }
    }

    let ru_r = fetch_json(
        client,
        &format!(
            "{}/cdn/{}/data/ru_RU/runesReforged.json",
            DDRAGON, ver
        ),
    )
    .await?;
    let en_r = fetch_json(
        client,
        &format!(
            "{}/cdn/{}/data/en_US/runesReforged.json",
            DDRAGON, ver
        ),
    )
    .await?;

    if let (Some(arr_ru), Some(arr_en)) = (ru_r.as_array(), en_r.as_array()) {
        let n_styles = arr_ru.len().min(arr_en.len());
        for si in 0..n_styles {
            let style_ru = &arr_ru[si];
            let style_en = &arr_en[si];
            let sk = style_en
                .get("key")
                .and_then(|x| x.as_str())
                .unwrap_or("?");
            let slots_ru = style_ru.get("slots").and_then(|x| x.as_array());
            let slots_en = style_en.get("slots").and_then(|x| x.as_array());
            let Some(slots_ru) = slots_ru else { continue };
            let Some(slots_en) = slots_en else { continue };
            let ns = slots_ru.len().min(slots_en.len());
            for sj in 0..ns {
                let slot_ru = &slots_ru[sj];
                let slot_en = &slots_en[sj];
                let runes_ru = slot_ru.get("runes").and_then(|x| x.as_array());
                let runes_en = slot_en.get("runes").and_then(|x| x.as_array());
                let Some(runes_ru) = runes_ru else { continue };
                let Some(runes_en) = runes_en else { continue };
                let nr = runes_ru.len().min(runes_en.len());
                for rk in 0..nr {
                    let rune_ru = &runes_ru[rk];
                    let rune_en = &runes_en[rk];
                    let rid = rune_ru.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
                    let rkey = rune_ru
                        .get("key")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name_ru = rune_ru
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name_en = rune_en
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let icon_path = rune_ru
                        .get("icon")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let url = if icon_path.is_empty() {
                        None
                    } else {
                        Some(format!("{}/cdn/img/{}", DDRAGON, icon_path))
                    };
                    let stable_id = format!("{}:{}", sk, rid);
                    let mut icon_sources = vec![IconSourceEntry {
                        t: "ddragon".into(),
                        url: url.clone(),
                    }];
                    if let (Some(dir), Some(icon_url)) = (icon_cache_dir, url.as_ref()) {
                        let file_icon = cache_https_icon_to_dir(client, dir, "rune", &stable_id, icon_url).await;
                        prepend_file_source(&mut icon_sources, file_icon);
                    }
                    rows.push(StaticCatalogRow {
                        kind: "rune".into(),
                        stable_id,
                        name_ru,
                        name_en,
                        riot_augment_id: None,
                        cd_meta: Some(json!({"style": sk, "key": rkey, "id": rid})),
                        icon_sources,
                        source: "ddragon".into(),
                    });
                }
            }
        }
    }

    let cherry: Value = match client
        .get(&format!(
            "{}/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json",
            CD_BASE
        ))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(json!([])),
        _ => json!([]),
    };

    if let Some(arr) = cherry.as_array() {
        for a in arr {
            let id = a.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
            let name_en = a
                .get("nameTRA")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let path = a
                .get("augmentSmallIconPath")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let pool = augment_pool_from_icon_path(path);
            let stable_id = format!("{}_{}", id, pool);
            let cd_url = if path.is_empty() {
                None
            } else {
                Some(cd_generic_plugin_url(path))
            };
            let mut icon_sources = Vec::new();
            if let Some(u) = cd_url {
                icon_sources.push(IconSourceEntry {
                    t: "cdragon".into(),
                    url: Some(u),
                });
                if let Some(dir) = icon_cache_dir {
                    let first = icon_sources.first().and_then(|s| s.url.as_ref()).cloned();
                    if let Some(icon_url) = first {
                        let file_icon = cache_https_icon_to_dir(client, dir, "augment", &stable_id, &icon_url).await;
                        prepend_file_source(&mut icon_sources, file_icon);
                    }
                }
            }
            rows.push(StaticCatalogRow {
                kind: "augment".into(),
                stable_id,
                name_ru: name_en.clone(),
                name_en: name_en.clone(),
                riot_augment_id: Some(id.to_string()),
                cd_meta: Some(json!({"pool": pool, "raw": a})),
                icon_sources,
                source: "cdragon".into(),
            });
        }
    }

    if let (Some(data_ru), Some(data_en)) = (
        ru_ch.get("data").and_then(|d| d.as_object()),
        en_ch.get("data").and_then(|d| d.as_object()),
    ) {
        for (key, val_ru) in data_ru {
            let champ_id = val_ru
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(key)
                .to_string();
            let val_en_root = data_en.get(key);
            let champ_id_en = val_en_root
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or(&champ_id)
                .to_string();
            let ru_detail_url = format!("{}/cdn/{}/data/ru_RU/champion/{}.json", DDRAGON, ver, champ_id);
            let en_detail_url = format!("{}/cdn/{}/data/en_US/champion/{}.json", DDRAGON, ver, champ_id_en);
            let ru_detail = fetch_json(client, &ru_detail_url).await.unwrap_or_else(|_| json!({}));
            let en_detail = fetch_json(client, &en_detail_url).await.unwrap_or_else(|_| json!({}));
            let ru_data = ru_detail.get("data").and_then(|d| d.get(&champ_id));
            let en_data = en_detail
                .get("data")
                .and_then(|d| d.get(&champ_id_en).or_else(|| d.get(&champ_id)));
            if let (Some(ru_data), Some(en_data)) = (ru_data, en_data) {
                let ru_spells = ru_data.get("spells").and_then(|s| s.as_array()).cloned().unwrap_or_default();
                let en_spells = en_data.get("spells").and_then(|s| s.as_array()).cloned().unwrap_or_default();
                let spell_len = ru_spells.len().min(en_spells.len());
                for idx in 0..spell_len {
                    let rs = &ru_spells[idx];
                    let es = &en_spells[idx];
                    let spell_id = rs
                        .get("id")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("slot_{}", idx));
                    let image_file = rs
                        .get("image")
                        .and_then(|x| x.get("full"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let mut icon_sources = Vec::new();
                    if !image_file.is_empty() {
                        let icon = ddragon_spell_icon(&ver, image_file);
                        icon_sources.push(IconSourceEntry {
                            t: "ddragon".into(),
                            url: Some(icon.clone()),
                        });
                        if let Some(dir) = icon_cache_dir {
                            let stable_id = format!("{}:{}", champ_id, spell_id);
                            let file_icon =
                                cache_https_icon_to_dir(client, dir, "champion_ability", &stable_id, &icon).await;
                            prepend_file_source(&mut icon_sources, file_icon);
                        }
                    }
                    rows.push(StaticCatalogRow {
                        kind: "champion_ability".into(),
                        stable_id: format!("{}:{}", champ_id, spell_id),
                        name_ru: rs.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        name_en: es.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        riot_augment_id: None,
                        cd_meta: Some(json!({"champion_id": champ_id, "slot": idx, "ability_id": spell_id})),
                        icon_sources,
                        source: "ddragon".into(),
                    });
                }

                if let (Some(ru_passive), Some(en_passive)) =
                    (ru_data.get("passive"), en_data.get("passive"))
                {
                    let image_file = ru_passive
                        .get("image")
                        .and_then(|x| x.get("full"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let mut icon_sources = Vec::new();
                    if !image_file.is_empty() {
                        let icon = ddragon_spell_icon(&ver, image_file);
                        icon_sources.push(IconSourceEntry {
                            t: "ddragon".into(),
                            url: Some(icon.clone()),
                        });
                        if let Some(dir) = icon_cache_dir {
                            let stable_id = format!("{}:passive", champ_id);
                            let file_icon =
                                cache_https_icon_to_dir(client, dir, "champion_ability", &stable_id, &icon).await;
                            prepend_file_source(&mut icon_sources, file_icon);
                        }
                    }
                    rows.push(StaticCatalogRow {
                        kind: "champion_ability".into(),
                        stable_id: format!("{}:passive", champ_id),
                        name_ru: ru_passive
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        name_en: en_passive
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        riot_augment_id: None,
                        cd_meta: Some(json!({"champion_id": champ_id, "slot": -1, "ability_id": "passive"})),
                        icon_sources,
                        source: "ddragon".into(),
                    });
                }
            }
        }
    }

    db.clear_static_catalog().await?;
    db.upsert_static_rows(&rows).await?;
    db.set_game_assets_meta(Some(&ver), Some(&chrono::Utc::now().to_rfc3339()))
        .await?;

    Ok(())
}
