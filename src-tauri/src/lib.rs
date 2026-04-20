use tauri::{AppHandle, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
use tauri::image::Image;
use tokio::sync::Mutex;
use crate::db::Database;
use crate::scraper::Scraper;
use crate::models::{
    GameAssetsMeta, MayhemAugmentation, MetaAnalysisDiff, PatchCategory, PatchData, PatchNoteEntry,
    StaticCatalogRow,
};
use crate::analyzer::Analyzer;
use std::collections::{HashSet, HashMap};
use serde::Serialize;
use regex::Regex;

pub mod models;
pub mod db;
pub mod scraper;
pub mod analyzer;
pub mod patch_version;
mod youtube_feed;
mod youtube_data_api;
mod wiki_embed;
mod game_assets;
mod patch_icons;

struct AppState {
    db: Database,
    scraper: Scraper,
    tier_cache: Option<(String, Vec<TierEntry>)>,
}

#[derive(Serialize)]
pub struct ChampionHistoryEntry {
    pub patch_version: String,
    pub date: chrono::DateTime<chrono::Utc>,
    pub change: PatchNoteEntry,
}

#[derive(Serialize)]
pub struct ChampionListItem {
    name: String,
    name_en: String,
    icon_url: String,
    key: String,
    id: String,
}

#[derive(Serialize, Clone)]
pub struct TierEntry {
    pub name: String,
    pub category: PatchCategory,
    pub buffs: u32,
    pub nerfs: u32,
    pub adjusted: u32,
    pub icon_url: Option<String>,
}

#[tauri::command]
fn analyze_change_trends(texts: Vec<String>) -> Vec<String> {
    texts
        .into_iter()
        .map(|t| match analyze_change_trend_backend(&t) {
            1 => "up".to_string(),
            -1 => "down".to_string(),
            _ => "neutral".to_string(),
        })
        .collect()
}

fn analyze_change_trend_backend(text: &str) -> i32 {
    let lower = text.to_lowercase();

    // 1) Жёсткий нерф: удаление / "больше не ..." (кроме "больше не уменьшается")
    if lower.contains("удалено")
        || lower.contains("removed")
        || (lower.contains("больше не")
            && !lower.contains("больше не уменьшается")
            && !lower.contains("no longer reduced"))
    {
        return -1;
    }

    // 2) "больше не уменьшается" / "no longer reduced" — всегда бафф
    if lower.contains("больше не уменьшается") || lower.contains("no longer reduced") {
        return 1;
    }

    // 3) Инверсные статы: меньше = лучше
    let is_inverse = lower.contains("перезарядка")
        || lower.contains("cooldown")
        || lower.contains("стоимость")
        || lower.contains("cost")
        || lower.contains("mana")
        || lower.contains("маны")
        || lower.contains("energy")
        || lower.contains("энергии")
        || lower.contains("затраты")
        || lower.contains("время")
        || lower.contains("time");

    // 4) Разбираем "from -> to" как на фронте (аналог analyzeChangeTrend)
    let arrow_re = Regex::new(r"\s*(?:→|⇒|->)\s*").unwrap();
    let parts: Vec<&str> = arrow_re.split(text).collect();
    if parts.len() == 2 {
        let parse_val = |s: &str| -> f64 {
            let num_re = Regex::new(r"[-+]?\d+(?:[.,]\d+)?").unwrap();
            let nums: Vec<f64> = num_re
                .find_iter(s)
                .filter_map(|m| m.as_str().replace(',', ".").parse::<f64>().ok())
                .collect();
            if nums.is_empty() {
                f64::NAN
            } else {
                nums.iter().sum()
            }
        };

        let from = parse_val(parts[0]);
        let to = parse_val(parts[1]);

        if from.is_finite() && to.is_finite() {
            if to > from {
                return if is_inverse { -1 } else { 1 };
            }
            if to < from {
                return if is_inverse { 1 } else { -1 };
            }
        }
    }

    // 5) Ключевые слова: бафф
    let buff_re =
        Regex::new(r"(увеличен|усилен|increased|buffed|new effect|новый эффект)").unwrap();
    if buff_re.is_match(&lower) {
        return 1;
    }

    // 6) Ключевые слова: нерф
    let nerf_re = Regex::new(r"(уменьшен|ослаблен|decreased|nerfed|removed|удалено)").unwrap();
    if nerf_re.is_match(&lower) {
        return -1;
    }

    // 7) Иначе — изменение без явного баффа/нерфа
    0
}

fn log(_app: &AppHandle, level: &str, message: &str) {
    println!("[{}] {}", level, message);
}

async fn refresh_augments_catalog_if_needed(
    scraper: &Scraper,
    db: &Database,
    force: bool,
    app: &AppHandle,
) {
    let key_en = db::AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_EN;
    let last = match db.get_augments_catalog(key_en).await {
        Ok(Some((_, t))) => Some(t),
        Ok(None) => None,
        Err(e) => {
            log(app, "WARN", &format!("augments catalog read: {}", e));
            None
        }
    };
    if !db::augments_catalog_should_refresh(last, force) {
        return;
    }
    match scraper.fetch_aram_mayhem_augmentations_bundle_en().await {
        Ok((entries, detailed)) if !entries.is_empty() => {
            if let Err(e) = db.save_augments_catalog(key_en, &entries).await {
                log(app, "WARN", &format!("augments catalog save: {}", e));
            } else {
                log(
                    app,
                    "INFO",
                    &format!("Augments catalog EN: {} entries", entries.len()),
                );
            }
            if let Err(e) = db
                .save_mayhem_augmentations_page(db::MAYHEM_AUG_PAGE_KEY_EN, &detailed)
                .await
            {
                log(app, "WARN", &format!("mayhem aug page EN save: {}", e));
            }
            if let Err(e) = db
                .save_augments_catalog(db::AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_RU, &entries)
                .await
            {
                log(app, "WARN", &format!("augments catalog RU save: {}", e));
            } else {
                log(
                    app,
                    "INFO",
                    &format!("Augments catalog RU (mirror EN): {} entries", entries.len()),
                );
            }
            if let Err(e) = db
                .save_mayhem_augmentations_page(db::MAYHEM_AUG_PAGE_KEY_RU, &detailed)
                .await
            {
                log(app, "WARN", &format!("mayhem aug page RU save: {}", e));
            }
        }
        Ok(_) => log(app, "WARN", "augments wiki: empty table"),
        Err(e) => log(app, "WARN", &format!("augments wiki: {}", e)),
    }
}

async fn get_or_fetch_patch(
    version: &str,
    patch_notes_locale: &str,
    app: &AppHandle,
    state: &AppState,
    force_refresh: bool,
) -> Result<PatchData, String> {
    if !force_refresh {
        if let Ok(Some(patch)) = state.db.get_patch_resolving(version).await {
            let stored_loc = patch.patch_notes_locale.as_deref().unwrap_or("ru");
            if stored_loc == patch_notes_locale && !patch.patch_notes.is_empty() {
                refresh_augments_catalog_if_needed(&state.scraper, &state.db, false, app).await;
                return state
                    .db
                    .patch_with_wiki_augment_enrichment(patch)
                    .await
                    .map_err(|e| e.to_string());
            }
        }
    }
    log(app, "INFO", &format!("Fetching patch data for {} from web...", version));
    match state.scraper.fetch_current_meta(version, patch_notes_locale).await {
        Ok(data) => {
            let _ = state.db.save_patch(&data).await;
            refresh_augments_catalog_if_needed(&state.scraper, &state.db, force_refresh, app).await;
            let data = state
                .db
                .patch_with_wiki_augment_enrichment(data)
                .await
                .map_err(|e| e.to_string())?;
            log(app, "SUCCESS", &format!("Data for {} fetched and saved.", version));
            Ok(data)
        }
        Err(e) => {
            log(app, "ERROR", &format!("Failed to fetch patch {}: {}", version, e));
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn get_patch_by_version(
    version: String,
    patch_notes_locale: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<PatchData, String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
    let state = state.lock().await;
    get_or_fetch_patch(&version, loc, &app, &state, false).await
}

#[tauri::command]
async fn analyze_patch(
    version: String,
    force: bool,
    patch_notes_locale: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<MetaAnalysisDiff>, String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
    let state = state.lock().await;
    let current = get_or_fetch_patch(&version, loc, &app, &state, force).await?;
    let patches = state
        .db
        .get_recent_patches(10)
        .await
        .map_err(|e| e.to_string())?;
    let previous = patches.iter().find(|p| p.version != version);

    if let Some(prev) = previous {
        Ok(Analyzer::compare_patches(&current, prev))
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
async fn check_patches_exist(versions: Vec<String>, state: tauri::State<'_, Mutex<AppState>>) -> Result<HashMap<String, bool>, String> {
    let state = state.lock().await;
    let mut result = HashMap::new();
    for version in versions {
        let exists = state
            .db
            .patch_exists_resolving(&version)
            .await
            .map_err(|e| e.to_string())?;
        result.insert(version, exists);
    }
    Ok(result)
}

#[tauri::command]
async fn get_latest_ddragon_version(state: tauri::State<'_, Mutex<AppState>>) -> Result<Option<String>, String> {
    let state = state.lock().await;
    state.scraper.fetch_latest_ddragon_version().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_patch_notes_exists(
    version: String,
    patch_notes_locale: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<bool, String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
    let state = state.lock().await;
    Ok(state.scraper.check_patch_notes_exists(&version, loc).await)
}

#[tauri::command]
async fn get_fallback_rune_icon(style_key: String, rune_key: String) -> Result<Option<String>, String> {
    use std::path::PathBuf;
    use std::fs;
    
    if style_key.is_empty() || rune_key.is_empty() {
        return Ok(None);
    }
    
    // Путь относительно директории src-tauri
    let mut resource_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    resource_path.push("arch");
    resource_path.push("Styles");
    resource_path.push(&style_key);
    resource_path.push(&rune_key);
    
    // Пробуем найти PNG файл в этой папке
    if let Ok(entries) = fs::read_dir(&resource_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext.to_string_lossy().to_lowercase() == "png" {
                        // Возвращаем путь как file:// URL для локальных файлов
                        if let Some(path_str) = path.to_str() {
                            let url = format!("file:///{}", path_str.replace('\\', "/"));
                            return Ok(Some(url));
                        }
                    }
                }
            }
        }
    }
    
    Ok(None)
}

#[tauri::command]
async fn get_available_patches(state: tauri::State<'_, Mutex<AppState>>) -> Result<Vec<String>, String> {
    let state = state.lock().await;
    state.scraper.fetch_available_patches().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_latest_patch_data(state: tauri::State<'_, Mutex<AppState>>) -> Result<Option<PatchData>, String> {
    let state = state.lock().await;
    let recent = state.db.get_recent_patches(1).await.unwrap_or_default();
    if let Some(latest) = recent.first() {
        Ok(Some(latest.clone()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn get_champion_history(
    champion_name: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<ChampionHistoryEntry>, String> {
    let state = state.lock().await;
    state
        .db
        .get_champion_history(&champion_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_item_history(
    item_name: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<ChampionHistoryEntry>, String> {
    let state = state.lock().await;
    state
        .db
        .get_item_history(&item_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_rune_history(
    rune_name: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<ChampionHistoryEntry>, String> {
    let state = state.lock().await;
    state
        .db
        .get_rune_history(&rune_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_all_champions(state: tauri::State<'_, Mutex<AppState>>) -> Result<Vec<ChampionListItem>, String> {
    let state = state.lock().await;
    if let Ok(rows) = state.db.get_static_catalog_kind("champion").await {
        if !rows.is_empty() {
            return Ok(rows
                .into_iter()
                .map(|r| {
                    let icon = r
                        .icon_sources
                        .iter()
                        .find_map(|e| e.url.clone())
                        .unwrap_or_default();
                    let key = r
                        .cd_meta
                        .as_ref()
                        .and_then(|m| m.get("key"))
                        .and_then(|x| x.as_str())
                        .unwrap_or(&r.stable_id)
                        .to_string();
                    ChampionListItem {
                        name: r.name_ru,
                        name_en: r.name_en,
                        icon_url: icon,
                        key,
                        id: r.stable_id,
                    }
                })
                .collect());
        }
    }
    match state.scraper.fetch_all_champions_ddragon().await {
        Ok(list) => Ok(
            list
                .into_iter()
                .map(|(name, name_en, icon_url, key, id)| ChampionListItem { 
                    name, 
                    name_en, 
                    icon_url,
                    key,
                    id
                })
                .collect(),
        ),
        Err(e) => Err(e.to_string())
    }
}

#[tauri::command]
async fn refresh_game_assets(
    app: AppHandle,
    force: Option<bool>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let force = force.unwrap_or(true);
    let icon_cache = app
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("game_assets_icons"));
    let state = state.lock().await;
    let cache = icon_cache.as_deref();
    game_assets::refresh_game_assets(&state.scraper, &state.db, cache, force)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_game_assets_meta(state: tauri::State<'_, Mutex<AppState>>) -> Result<Option<GameAssetsMeta>, String> {
    let state = state.lock().await;
    state.db.get_game_assets_meta().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_static_catalog_rows(
    kind: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<StaticCatalogRow>, String> {
    let state = state.lock().await;
    state
        .db
        .get_static_catalog_kind(&kind)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_static_catalog_items_for_maps(
    map_ids: Vec<u32>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<StaticCatalogRow>, String> {
    let state = state.lock().await;
    state
        .db
        .filter_static_catalog_items_by_maps(&map_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_changed_itemsrunes_titles(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<String>, String> {
    let state = state.lock().await;
    let patches = state
        .db
        .get_recent_patches(20)
        .await
        .map_err(|e| e.to_string())?;

    let mut set: HashSet<String> = HashSet::new();
    for patch in patches {
        for note in patch.patch_notes {
            if note.category == PatchCategory::Items || note.category == PatchCategory::Runes || note.category == PatchCategory::ItemsRunes {
                set.insert(note.title.clone());
            }
        }
    }

    Ok(set.into_iter().collect())
}

#[tauri::command]
async fn get_tier_list(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<TierEntry>, String> {
    let mut state = state.lock().await;
    let patches = state
        .db
        .get_recent_patches(20)
        .await
        .map_err(|e| e.to_string())?;

    // Строим сигнатуру состояния данных (версии + fetched_at) для кеша
    let mut signature = String::new();
    for p in &patches {
        signature.push_str(&p.version);
        signature.push('|');
        signature.push_str(&p.fetched_at.to_rfc3339());
        signature.push(';');
    }

    if let Some((cached_sig, cached_list)) = &state.tier_cache {
        if *cached_sig == signature {
            return Ok(cached_list.clone());
        }
    }

    let mut map: HashMap<(String, PatchCategory), TierEntry> = HashMap::new();

    for patch in patches {
        for note in patch.patch_notes {
            if note.category == PatchCategory::UpcomingSkinsChromas
                || note.category == PatchCategory::ModeAramAugments
            {
                continue;
            }
            let key = (note.title.clone(), note.category.clone());
            let entry = map.entry(key).or_insert(TierEntry {
                name: note.title.clone(),
                category: note.category.clone(),
                buffs: 0,
                nerfs: 0,
                adjusted: 0,
                icon_url: None,
            });

            // Сохраняем иконку из патч-нотов (берем последнюю найденную)
            if let Some(ref icon) = note.image_url {
                entry.icon_url = Some(icon.clone());
            }

            for block in &note.details {
                for change in &block.changes {
                    match analyze_change_trend_backend(change) {
                        1 => entry.buffs += 1,
                        -1 => entry.nerfs += 1,
                        _ => entry.adjusted += 1,
                    }
                }
            }
        }
    }

    let mut list: Vec<TierEntry> = map.into_values().collect();
    list.sort_by(|a, b| {
        let score_a = a.buffs as i32 - a.nerfs as i32;
        let score_b = b.buffs as i32 - b.nerfs as i32;
        score_b
            .cmp(&score_a)
            .then_with(|| b.buffs.cmp(&a.buffs))
            .then_with(|| a.nerfs.cmp(&b.nerfs))
    });

    state.tier_cache = Some((signature, list.clone()));

    Ok(list)
}

#[tauri::command]
async fn sync_patch_history(
    patch_notes_locale: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
    log(&app, "INFO", "Starting full history sync...");
    
    let patches_list = {
        let state = state.lock().await;
        match state.scraper.fetch_available_patches().await {
             Ok(list) => list,
             Err(e) => return Err(e.to_string())
        }
    };

    log(&app, "INFO", &format!("Found {} patches to check.", patches_list.len()));

    for version in patches_list {
        let need_fetch = {
             let state = state.lock().await;
             match state.db.get_patch_resolving(&version).await.ok().flatten() {
                 Some(p) => {
                     let sl = p.patch_notes_locale.as_deref().unwrap_or("ru");
                     sl != loc || p.patch_notes.is_empty()
                 }
                 None => true,
             }
        };

        if need_fetch {
             log(&app, "INFO", &format!("Downloading missing patch: {} ...", version));
             let fetch_result = {
                 let state = state.lock().await;
                 state.scraper.fetch_current_meta(&version, loc).await
             };
             
             match fetch_result {
                 Ok(data) => {
                     let state = state.lock().await;
                     if let Err(e) = state.db.save_patch(&data).await {
                         log(&app, "ERROR", &format!("Failed to save {}: {}", version, e));
                     } else {
                         log(&app, "SUCCESS", &format!("Saved patch {}", version));
                     }
                 },
                 Err(e) => {
                     log(&app, "ERROR", &format!("Failed to download {}: {}", version, e));
                 }
             }
             tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }
    }

    {
        let state = state.lock().await;
        refresh_augments_catalog_if_needed(&state.scraper, &state.db, false, &app).await;
    }

    log(&app, "SUCCESS", "History sync completed.");
    Ok(())
}

#[tauri::command]
async fn clear_database(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let state = state.lock().await;
    state.db.clear_database().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_database_path(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("patches.db").to_string_lossy().into_owned())
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn fetch_youtube_feed(channel_id: String) -> Result<Vec<youtube_feed::YoutubeFeedItem>, String> {
    let s = channel_id.trim();
    if s.is_empty() {
        return Err("empty channel_id".to_string());
    }
    youtube_feed::fetch_youtube_feed_async(s).await
}

#[derive(Serialize)]
pub struct SkinSpotlightResolveResult {
    pub video_id: Option<String>,
    pub video_title: Option<String>,
    /// "cache" | "api" | "not_found" | "no_key" | "invalid_query" | "error"
    pub source: String,
}

#[tauri::command]
async fn resolve_skin_spotlight_video(
    state: tauri::State<'_, Mutex<AppState>>,
    cache_key: String,
    search_query: String,
    channel_id: String,
) -> Result<SkinSpotlightResolveResult, String> {
    let ck = cache_key
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let sq = search_query.trim().to_string();
    let ch = channel_id.trim();
    if ck.len() < 3 || sq.len() < 4 || ch.is_empty() {
        return Ok(SkinSpotlightResolveResult {
            video_id: None,
            video_title: None,
            source: "invalid_query".into(),
        });
    }

    let cached = {
        let guard = state.lock().await;
        guard.db.get_skin_spotlight_cached(&ck).await
    };
    if let Ok(Some((vid, title))) = cached {
        return Ok(SkinSpotlightResolveResult {
            video_id: Some(vid),
            video_title: Some(title),
            source: "cache".into(),
        });
    }

    let api_key = match std::env::var("YOUTUBE_DATA_API_KEY") {
        Ok(k) if !k.trim().is_empty() => k,
        _ => {
            return Ok(SkinSpotlightResolveResult {
                video_id: None,
                video_title: None,
                source: "no_key".into(),
            });
        }
    };

    let client = reqwest::Client::builder()
        .user_agent("PatchAnalyzer/1.0 (Tauri)")
        .build()
        .map_err(|e| e.to_string())?;

    let searched =
        youtube_data_api::search_first_video_in_channel(&client, &api_key, ch, &sq).await;

    match searched {
        Ok(Some((vid, title))) => {
            let guard = state.lock().await;
            let _ = guard
                .db
                .save_skin_spotlight_cached(&ck, &vid, &title)
                .await;
            Ok(SkinSpotlightResolveResult {
                video_id: Some(vid),
                video_title: Some(title),
                source: "api".into(),
            })
        }
        Ok(None) => Ok(SkinSpotlightResolveResult {
            video_id: None,
            video_title: None,
            source: "not_found".into(),
        }),
        Err(e) => Ok(SkinSpotlightResolveResult {
            video_id: None,
            video_title: None,
            source: format!("error:{e}"),
        }),
    }
}

#[tauri::command]
fn update_tray_menu_labels(app: AppHandle, show: String, quit: String) -> Result<(), String> {
    let show_item = MenuItem::with_id(&app, "Show", show, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(&app, "Quit", quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&show_item, &quit_item]).map_err(|e| e.to_string())?;
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "tray not found".to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct MayhemAugmentationsPayload {
    pub entries: Vec<MayhemAugmentation>,
    pub fetched_at: Option<String>,
}

#[tauri::command]
async fn get_mayhem_augmentations_page(
    state: tauri::State<'_, Mutex<AppState>>,
    locale: String,
) -> Result<MayhemAugmentationsPayload, String> {
    let guard = state.lock().await;
    let key = if locale == "en" {
        db::MAYHEM_AUG_PAGE_KEY_EN
    } else {
        db::MAYHEM_AUG_PAGE_KEY_RU
    };
    let cat_key = if locale == "en" {
        db::AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_EN
    } else {
        db::AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_RU
    };

    let page = guard
        .db
        .get_mayhem_augmentations_page(key)
        .await
        .map_err(|e| e.to_string())?;

    if let Some((ref entries, t)) = page {
        if !entries.is_empty() {
            return Ok(MayhemAugmentationsPayload {
                entries: entries.clone(),
                fetched_at: Some(t.to_rfc3339()),
            });
        }
    }

    if let Ok(Some((notes, t))) = guard.db.get_augments_catalog(cat_key).await {
        let entries = db::mayhem_rows_from_patch_notes(&notes);
        if !entries.is_empty() {
            return Ok(MayhemAugmentationsPayload {
                entries,
                fetched_at: Some(t.to_rfc3339()),
            });
        }
    }

    if let Some((_, t)) = page {
        return Ok(MayhemAugmentationsPayload {
            entries: vec![],
            fetched_at: Some(t.to_rfc3339()),
        });
    }

    Ok(MayhemAugmentationsPayload {
        entries: vec![],
        fetched_at: None,
    })
}

#[tauri::command]
async fn refresh_mayhem_augmentations_from_wiki(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let scraper = &guard.scraper;
    let db = &guard.db;
    let (en_notes, en_det) = scraper
        .fetch_aram_mayhem_augmentations_bundle_en()
        .await
        .map_err(|e| e.to_string())?;
    if !en_notes.is_empty() {
        db.save_augments_catalog(db::AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_EN, &en_notes)
            .await
            .map_err(|e| e.to_string())?;
        db.save_mayhem_augmentations_page(db::MAYHEM_AUG_PAGE_KEY_EN, &en_det)
            .await
            .map_err(|e| e.to_string())?;
        db.save_augments_catalog(db::AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_RU, &en_notes)
            .await
            .map_err(|e| e.to_string())?;
        db.save_mayhem_augmentations_page(db::MAYHEM_AUG_PAGE_KEY_RU, &en_det)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let scraper = Scraper::new().expect("Failed to init Scraper");

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("app_data_dir");
            std::fs::create_dir_all(&app_data).expect("create_dir app_data");
            let db_path = app_data.join("patches.db");
            if !db_path.exists() {
                if let Ok(cwd) = std::env::current_dir() {
                    let legacy = cwd.join("patches.db");
                    if legacy.is_file() {
                        if let Err(e) = std::fs::copy(&legacy, &db_path) {
                            eprintln!(
                                "patch-analyzer: migrate patches.db from {:?} failed: {}",
                                legacy, e
                            );
                        }
                    }
                }
            }
            let db = tokio::runtime::Runtime::new()
                .expect("runtime")
                .block_on(Database::open(&db_path))
                .expect("Failed to init DB");

            app.manage(Mutex::new(AppState {
                db,
                scraper,
                tier_cache: None,
            }));

            let ah = app.handle().clone();
            let icon_cache_dir = app_data.join("game_assets_icons");
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                let st = ah.state::<Mutex<AppState>>();
                let s = st.lock().await;
                let _ = game_assets::try_seed_manifest_meta(&s.db).await;
                if s.db.static_catalog_count().await.unwrap_or(0) == 0 {
                    let _ = game_assets::refresh_game_assets(
                        &s.scraper,
                        &s.db,
                        Some(icon_cache_dir.as_path()),
                        true,
                    )
                    .await;
                }
            });
            
            let menu = Menu::with_items(app, &[
                &MenuItem::with_id(app, "Show", "Show", true, None::<&str>)?,
                &MenuItem::with_id(app, "Quit", "Quit", true, None::<&str>)?,
            ])?;

            // Use image crate via tauri's feature if available, or just ignore tray icon if compilation fails without
            // Since we added image-png, this should work
            let icon = Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap();

            let _tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("LoL Meta Analyzer")
                .icon(icon)
                .on_menu_event(move |tray, event| match event.id.as_ref() {
                    "Show" => {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.set_skip_taskbar(false);
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "Quit" => {
                        tray.app_handle().exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                         if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.set_skip_taskbar(false);
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            analyze_patch,
            get_available_patches,
            get_latest_patch_data,
            get_patch_by_version,
            get_champion_history,
            get_item_history,
            get_rune_history,
            get_all_champions,
            get_changed_itemsrunes_titles,
            get_tier_list,
            sync_patch_history,
            clear_database,
            check_patches_exist,
            get_latest_ddragon_version,
            check_patch_notes_exists,
            get_fallback_rune_icon,
            analyze_change_trends,
            get_database_path,
            exit_app,
            update_tray_menu_labels,
            fetch_youtube_feed,
            resolve_skin_spotlight_video,
            wiki_embed::wiki_embed_open,
            wiki_embed::wiki_embed_close,
            wiki_embed::wiki_embed_resize,
            wiki_embed::wiki_embed_navigate,
            wiki_embed::wiki_embed_go_back,
            get_mayhem_augmentations_page,
            refresh_mayhem_augmentations_from_wiki,
            refresh_game_assets,
            get_game_assets_meta,
            get_static_catalog_rows,
            get_static_catalog_items_for_maps
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
