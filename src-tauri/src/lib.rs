use tauri::{AppHandle, Emitter, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
use tauri::image::Image;
use std::sync::Arc;
use std::path::PathBuf;
use tokio::sync::Mutex;
use crate::db::Database;
use crate::scraper::Scraper;
use crate::models::{
    GameAssetsMeta, MayhemAugmentation, MetaAnalysisDiff, PatchCategory, PatchData, PatchNoteEntry,
    StaticCatalogRow,
};
use crate::analyzer::Analyzer;
use std::collections::{HashSet, HashMap};
use crate::patch_version::versions_match;
use crate::patch_change_trend::analyze_change_trend;
use serde::Serialize;

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
mod asset_cache;
mod patch_change_trend;
pub mod wiki_augment_bundle;

struct AppState {
    db: Arc<Database>,
    scraper: Arc<Scraper>,
    tier_cache: Mutex<Option<(String, Vec<TierEntry>)>>,
}

#[cfg(not(debug_assertions))]
#[derive(serde::Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[cfg(not(debug_assertions))]
#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubReleaseAsset>,
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

#[derive(Serialize, Clone)]
struct PreviousPatchSavedPayload {
    version: String,
    processed: usize,
    total: usize,
    downloaded: usize,
    skipped: usize,
    saved: bool,
}

#[tauri::command]
fn analyze_change_trends(texts: Vec<String>) -> Vec<String> {
    texts
        .into_iter()
        .map(|t| match analyze_change_trend(&t) {
            1 => "up".to_string(),
            -1 => "down".to_string(),
            _ => "neutral".to_string(),
        })
        .collect()
}

fn log(_app: &AppHandle, level: &str, message: &str) {
    println!("[{}] {}", level, message);
}

#[cfg(not(debug_assertions))]
fn is_release_newer(current: &str, latest: &str) -> bool {
    let parse = |raw: &str| -> Vec<u32> {
        raw.trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let cur = parse(current);
    let lat = parse(latest);
    let max_len = cur.len().max(lat.len());
    for idx in 0..max_len {
        let a = *cur.get(idx).unwrap_or(&0);
        let b = *lat.get(idx).unwrap_or(&0);
        if b > a {
            return true;
        }
        if b < a {
            return false;
        }
    }
    false
}

#[cfg(not(debug_assertions))]
async fn try_auto_update_from_github(app: AppHandle) {
    let current_version = app.package_info().version.to_string();
    let release_url = "https://api.github.com/repos/RaspizDIYs/patch-analyzer/releases/latest";
    let client = match reqwest::Client::builder()
        .user_agent(format!("PatchAnalyzer/{current_version}"))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log(&app, "WARN", &format!("auto-update client init failed: {e}"));
            return;
        }
    };

    let release = match client
        .get(release_url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(resp) => match resp.json::<GithubRelease>().await {
            Ok(parsed) => parsed,
            Err(e) => {
                log(&app, "WARN", &format!("auto-update release json parse failed: {e}"));
                return;
            }
        },
        Err(e) => {
            log(&app, "WARN", &format!("auto-update release fetch failed: {e}"));
            return;
        }
    };

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    if !is_release_newer(&current_version, &latest_version) {
        return;
    }

    let selected_asset = release
        .assets
        .iter()
        .find(|asset| {
            let n = asset.name.to_lowercase();
            n.ends_with(".exe") && (n.contains("setup") || n.contains("nsis"))
        })
        .or_else(|| release.assets.iter().find(|asset| asset.name.to_lowercase().ends_with(".exe")));

    let Some(asset) = selected_asset else {
        log(&app, "WARN", "auto-update: no .exe installer asset found");
        return;
    };

    let installer_bytes = match client
        .get(&asset.browser_download_url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(resp) => match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                log(&app, "WARN", &format!("auto-update installer bytes failed: {e}"));
                return;
            }
        },
        Err(e) => {
            log(&app, "WARN", &format!("auto-update installer download failed: {e}"));
            return;
        }
    };

    let cache_dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir());
    if let Err(e) = std::fs::create_dir_all(&cache_dir) {
        log(&app, "WARN", &format!("auto-update cache dir create failed: {e}"));
        return;
    }

    let installer_path = cache_dir.join(format!("patch-analyzer-{latest_version}-setup.exe"));
    if let Err(e) = std::fs::write(&installer_path, installer_bytes.as_ref()) {
        log(&app, "WARN", &format!("auto-update installer save failed: {e}"));
        return;
    }

    let spawn_result = std::process::Command::new(&installer_path).spawn();
    match spawn_result {
        Ok(_) => {
            log(
                &app,
                "INFO",
                &format!(
                    "auto-update: launching installer {} ({})",
                    asset.name,
                    latest_version
                ),
            );
            app.exit(0);
        }
        Err(e) => {
            log(
                &app,
                "WARN",
                &format!("auto-update installer launch failed: {e}"),
            );
        }
    }
}

fn game_assets_cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join("game_assets_icons"))
}

fn patch_assets_cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join("patch_assets"))
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

const PATCH_NOT_CACHED: &str = "PATCH_NOT_CACHED";
const PREVIOUS_PATCH_SAVED_EVENT: &str = "previous_patch_saved";

async fn get_or_fetch_patch(
    version: &str,
    patch_notes_locale: &str,
    app: &AppHandle,
    db: &Database,
    scraper: &Scraper,
    force_refresh: bool,
    allow_network: bool,
) -> Result<PatchData, String> {
    if force_refresh {
        if !allow_network {
            return Err(PATCH_NOT_CACHED.to_string());
        }
    } else {
        match db
            .get_patch_resolving_with_locale(version, patch_notes_locale)
            .await
        {
            Ok(Some(mut patch)) => {
                if allow_network {
                    if let Some(dir) = patch_assets_cache_dir(app) {
                        let _ = asset_cache::localize_patch_assets(
                            scraper.http_client(),
                            &dir,
                            &mut patch,
                        )
                        .await;
                        let _ = db.save_patch(&patch).await;
                    }
                }
                if !patch.patch_notes.is_empty() || !allow_network {
                    return db
                        .patch_with_wiki_augment_enrichment(patch)
                        .await
                        .map_err(|e| e.to_string());
                }
            }
            Ok(None) => {
                if !allow_network {
                    return Err(PATCH_NOT_CACHED.to_string());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    if !allow_network {
        return Err(PATCH_NOT_CACHED.to_string());
    }
    log(
        app,
        "INFO",
        &format!("Fetching patch data for {} from web...", version),
    );
    match scraper
        .fetch_current_meta(version, patch_notes_locale)
        .await
    {
        Ok(mut data) => {
            if let Some(dir) = patch_assets_cache_dir(app) {
                let _ = asset_cache::localize_patch_assets(scraper.http_client(), &dir, &mut data).await;
            }
            let _ = db.save_patch(&data).await;
            refresh_augments_catalog_if_needed(scraper, db, force_refresh, app).await;
            let data = db
                .patch_with_wiki_augment_enrichment(data)
                .await
                .map_err(|e| e.to_string())?;
            log(
                app,
                "SUCCESS",
                &format!("Data for {} fetched and saved.", version),
            );
            Ok(data)
        }
        Err(e) => {
            log(
                app,
                "ERROR",
                &format!("Failed to fetch patch {}: {}", version, e),
            );
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn get_patch_by_version(
    version: String,
    patch_notes_locale: String,
    allow_network: Option<bool>,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PatchData, String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
    let allow_network = allow_network.unwrap_or(false);
    get_or_fetch_patch(
        &version,
        loc,
        &app,
        state.db.as_ref(),
        state.scraper.as_ref(),
        false,
        allow_network,
    )
    .await
}

#[tauri::command]
async fn analyze_patch(
    version: String,
    force: bool,
    patch_notes_locale: String,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MetaAnalysisDiff>, String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
    let current = get_or_fetch_patch(
        &version,
        loc,
        &app,
        state.db.as_ref(),
        state.scraper.as_ref(),
        force,
        true,
    )
    .await?;
    let patches = state
        .db
        .get_patches_newest_versions_first(50)
        .await
        .map_err(|e| e.to_string())?;
    let current_idx = patches
        .iter()
        .position(|p| versions_match(&p.version, &version));
    let previous = current_idx.and_then(|i| patches.get(i + 1));

    if let Some(prev) = previous {
        Ok(Analyzer::compare_patches(&current, prev))
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
async fn check_patches_exist(versions: Vec<String>, state: tauri::State<'_, AppState>) -> Result<HashMap<String, bool>, String> {
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
async fn get_latest_ddragon_version(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    state.scraper.fetch_latest_ddragon_version().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_patch_notes_exists(
    version: String,
    patch_notes_locale: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
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
async fn get_available_patches(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    state.scraper.fetch_available_patches().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_latest_patch_data(state: tauri::State<'_, AppState>) -> Result<Option<PatchData>, String> {
    let recent = state
        .db
        .get_patches_newest_versions_first(1)
        .await
        .map_err(|e| e.to_string())?;
    let Some(latest) = recent.into_iter().next() else {
        return Ok(None);
    };
    let enriched = state
        .db
        .patch_with_wiki_augment_enrichment(latest)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(enriched))
}

#[tauri::command]
async fn get_cached_patch_versions(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    state
        .db
        .list_cached_patch_versions()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_champion_history(
    champion_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChampionHistoryEntry>, String> {
    state
        .db
        .get_champion_history(&champion_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_item_history(
    item_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChampionHistoryEntry>, String> {
    state
        .db
        .get_item_history(&item_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_rune_history(
    rune_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChampionHistoryEntry>, String> {
    state
        .db
        .get_rune_history(&rune_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_all_champions(state: tauri::State<'_, AppState>) -> Result<Vec<ChampionListItem>, String> {
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
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let force = force.unwrap_or(true);
    let icon_cache = game_assets_cache_dir(&app);
    let cache = icon_cache.as_deref();
    game_assets::refresh_game_assets(state.scraper.as_ref(), state.db.as_ref(), cache, force)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_game_assets_meta(state: tauri::State<'_, AppState>) -> Result<Option<GameAssetsMeta>, String> {
    state.db.get_game_assets_meta().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_static_catalog_rows(
    kind: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<StaticCatalogRow>, String> {
    state
        .db
        .get_static_catalog_kind(&kind)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_static_catalog_items_for_maps(
    map_ids: Vec<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<StaticCatalogRow>, String> {
    state
        .db
        .filter_static_catalog_items_by_maps(&map_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_changed_itemsrunes_titles(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let patches = state
        .db
        .get_patches_newest_versions_first(20)
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
    window_size: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TierEntry>, String> {
    let limit = window_size.unwrap_or(20).clamp(1, 50) as i64;
    let patches = state
        .db
        .get_patches_newest_versions_first(limit)
        .await
        .map_err(|e| e.to_string())?;

    let mut signature = String::new();
    signature.push_str(&format!("limit={limit};"));
    for p in &patches {
        signature.push_str(&p.version);
        signature.push('|');
        signature.push_str(&p.fetched_at.to_rfc3339());
        signature.push(';');
    }

    {
        let cache = state.tier_cache.lock().await;
        if let Some((cached_sig, cached_list)) = cache.as_ref() {
            if *cached_sig == signature {
                return Ok(cached_list.clone());
            }
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
                    match analyze_change_trend(change) {
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

    let mut cache = state.tier_cache.lock().await;
    *cache = Some((signature, list.clone()));

    Ok(list)
}

#[tauri::command]
async fn sync_patch_history(
    patch_notes_locale: String,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
    log(&app, "INFO", "Starting full history sync...");
    
    let patches_list = state
        .scraper
        .fetch_available_patches()
        .await
        .map_err(|e| e.to_string())?;

    log(&app, "INFO", &format!("Found {} patches to check.", patches_list.len()));

    for version in patches_list {
        let need_fetch = match state
            .db
            .get_patch_resolving_with_locale(&version, loc)
            .await
            .ok()
            .flatten()
        {
            Some(p) => p.patch_notes.is_empty(),
            None => true,
        };

        if need_fetch {
            log(
                &app,
                "INFO",
                &format!("Downloading missing patch: {} ...", version),
            );
            let fetch_result = state.scraper.fetch_current_meta(&version, loc).await;

            match fetch_result {
                Ok(mut data) => {
                    if let Some(dir) = patch_assets_cache_dir(&app) {
                        let _ = asset_cache::localize_patch_assets(
                            state.scraper.http_client(),
                            &dir,
                            &mut data,
                        )
                        .await;
                    }
                    if let Err(e) = state.db.save_patch(&data).await {
                        log(&app, "ERROR", &format!("Failed to save {}: {}", version, e));
                    } else {
                        log(&app, "SUCCESS", &format!("Saved patch {}", version));
                    }
                }
                Err(e) => {
                    log(&app, "ERROR", &format!("Failed to download {}: {}", version, e));
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }
    }

    refresh_augments_catalog_if_needed(
        state.scraper.as_ref(),
        state.db.as_ref(),
        false,
        &app,
    )
    .await;

    log(&app, "SUCCESS", "History sync completed.");
    Ok(())
}

#[tauri::command]
async fn sync_previous_patch_history_to_limit(
    target_total: Option<u32>,
    patch_notes_locale: String,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let loc = if patch_notes_locale == "en" { "en" } else { "ru" };
    let target_total = target_total.unwrap_or(50).clamp(50, 100) as usize;
    let baseline_recent = 20usize;

    let patches_list = state
        .scraper
        .fetch_available_patches_with_limit(100)
        .await
        .map_err(|e| e.to_string())?;

    if patches_list.len() <= baseline_recent {
        log(
            &app,
            "INFO",
            "No previous patches available for retrospective sync.",
        );
        return Ok(());
    }

    let end = target_total.min(patches_list.len());
    if end <= baseline_recent {
        log(&app, "INFO", "Selected target does not require previous patch sync.");
        return Ok(());
    }
    let previous_slice = &patches_list[baseline_recent..end];

    log(
        &app,
        "INFO",
        &format!(
            "Starting previous patches sync: target_total={}, syncing {} versions.",
            target_total,
            previous_slice.len()
        ),
    );

    let total = previous_slice.len();
    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let _ = app.emit(
        PREVIOUS_PATCH_SAVED_EVENT,
        PreviousPatchSavedPayload {
            version: String::new(),
            processed: 0,
            total,
            downloaded,
            skipped,
            saved: false,
        },
    );

    for (idx, version) in previous_slice.iter().enumerate() {
        let already_cached = state
            .db
            .patch_exists_resolving(version)
            .await
            .unwrap_or(false);
        if already_cached {
            skipped += 1;
            log(
                &app,
                "INFO",
                &format!("Skipping already cached previous patch: {}", version),
            );
            let _ = app.emit(
                PREVIOUS_PATCH_SAVED_EVENT,
                PreviousPatchSavedPayload {
                    version: version.to_string(),
                    processed: idx + 1,
                    total,
                    downloaded,
                    skipped,
                    saved: false,
                },
            );
            continue;
        }

        let mut saved = false;
        log(
            &app,
            "INFO",
            &format!("Downloading previous patch: {} ...", version),
        );
        let fetch_result = state.scraper.fetch_current_meta(version, loc).await;

        match fetch_result {
            Ok(mut data) => {
                if let Some(dir) = patch_assets_cache_dir(&app) {
                    let _ = asset_cache::localize_patch_assets(
                        state.scraper.http_client(),
                        &dir,
                        &mut data,
                    )
                    .await;
                }
                if let Err(e) = state.db.save_patch(&data).await {
                    log(&app, "ERROR", &format!("Failed to save {}: {}", version, e));
                } else {
                    log(&app, "SUCCESS", &format!("Saved previous patch {}", version));
                    saved = true;
                    downloaded += 1;
                }
            }
            Err(e) => {
                log(&app, "ERROR", &format!("Failed to download {}: {}", version, e));
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        let _ = app.emit(
            PREVIOUS_PATCH_SAVED_EVENT,
            PreviousPatchSavedPayload {
                version: version.to_string(),
                processed: idx + 1,
                total,
                downloaded,
                skipped,
                saved,
            },
        );
    }

    refresh_augments_catalog_if_needed(
        state.scraper.as_ref(),
        state.db.as_ref(),
        false,
        &app,
    )
    .await;

    log(&app, "SUCCESS", "Previous patches sync completed.");
    Ok(())
}

#[tauri::command]
async fn clear_database(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.clear_database().await.map_err(|e| e.to_string())?;
    let mut cache = state.tier_cache.lock().await;
    *cache = None;
    Ok(())
}

fn count_files_recursive(dir: &std::path::Path) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let entries = match std::fs::read_dir(&path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(md) = entry.metadata() {
                if md.is_file() {
                    files += 1;
                    bytes += md.len();
                }
            }
        }
    }
    (files, bytes)
}

#[derive(Serialize)]
struct CacheStatusPayload {
    patch_versions: usize,
    patch_locales: Vec<String>,
    static_catalog_rows: usize,
    patch_asset_files: u64,
    patch_asset_bytes: u64,
    game_asset_files: u64,
    game_asset_bytes: u64,
}

#[derive(Serialize)]
struct AssetValidationPayload {
    checked: usize,
    missing: usize,
    broken_paths: Vec<String>,
}

#[tauri::command]
async fn cache_status(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<CacheStatusPayload, String> {
    let versions = state
        .db
        .list_cached_patch_versions()
        .await
        .map_err(|e| e.to_string())?;
    let locales = state
        .db
        .list_cached_patch_locales()
        .await
        .map_err(|e| e.to_string())?;
    let static_rows = state
        .db
        .static_catalog_count()
        .await
        .map_err(|e| e.to_string())? as usize;

    let (patch_asset_files, patch_asset_bytes) = patch_assets_cache_dir(&app)
        .filter(|p| p.exists())
        .map(|p| count_files_recursive(&p))
        .unwrap_or((0, 0));
    let (game_asset_files, game_asset_bytes) = game_assets_cache_dir(&app)
        .filter(|p| p.exists())
        .map(|p| count_files_recursive(&p))
        .unwrap_or((0, 0));

    let payload = CacheStatusPayload {
        patch_versions: versions.len(),
        patch_locales: locales,
        static_catalog_rows: static_rows,
        patch_asset_files,
        patch_asset_bytes,
        game_asset_files,
        game_asset_bytes,
    };
    if let Ok(s) = serde_json::to_string(&payload) {
        log(&app, "INFO", &format!("cache_status => {}", s));
    }
    Ok(payload)
}

#[tauri::command]
async fn warm_full_cache(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let cache = game_assets_cache_dir(&app);
    game_assets::refresh_game_assets(
        state.scraper.as_ref(),
        state.db.as_ref(),
        cache.as_deref(),
        true,
    )
    .await
    .map_err(|e| e.to_string())?;
    let patches = state
        .scraper
        .fetch_available_patches()
        .await
        .map_err(|e| e.to_string())?;

    for locale in ["ru", "en"] {
        for version in &patches {
            let _ = get_or_fetch_patch(
                version,
                locale,
                &app,
                state.db.as_ref(),
                state.scraper.as_ref(),
                false,
                true,
            )
            .await;
        }
    }
    log(&app, "SUCCESS", "warm_full_cache => completed");
    Ok(())
}

#[tauri::command]
async fn clear_all_cached_data(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .db
        .clear_all_cached_data()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(dir) = game_assets_cache_dir(&app) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Some(dir) = patch_assets_cache_dir(&app) {
        let _ = std::fs::remove_dir_all(dir);
    }
    let mut cache = state.tier_cache.lock().await;
    *cache = None;
    log(&app, "SUCCESS", "clear_all_cached_data => completed");
    Ok(())
}

#[tauri::command]
async fn validate_cached_assets(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<AssetValidationPayload, String> {
    let mut checked = 0usize;
    let mut missing = 0usize;
    let mut broken_paths: Vec<String> = Vec::new();

    let kinds = ["champion", "item", "rune", "augment", "champion_ability"];
    for kind in kinds {
        let rows = state
            .db
            .get_static_catalog_kind(kind)
            .await
            .unwrap_or_default();
        for row in rows {
            for src in row.icon_sources {
                let Some(url) = src.url else { continue };
                if src.t != "file" {
                    continue;
                }
                checked += 1;
                let p = PathBuf::from(&url);
                if !p.exists() {
                    missing += 1;
                    if broken_paths.len() < 100 {
                        broken_paths.push(url);
                    }
                }
            }
        }
    }

    let payload = AssetValidationPayload {
        checked,
        missing,
        broken_paths,
    };
    if let Ok(s) = serde_json::to_string(&payload) {
        log(&app, "INFO", &format!("validate_cached_assets => {}", s));
    }
    Ok(payload)
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
    state: tauri::State<'_, AppState>,
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

    let cached = state.db.get_skin_spotlight_cached(&ck).await;
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
            let _ = state
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
    state: tauri::State<'_, AppState>,
    locale: String,
) -> Result<MayhemAugmentationsPayload, String> {
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

    let page = state
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

    if let Ok(Some((notes, t))) = state.db.get_augments_catalog(cat_key).await {
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
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let scraper = state.scraper.clone();
    let db = state.db.clone();
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
    let scraper = Arc::new(Scraper::new().expect("Failed to init Scraper"));

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
            let db = Arc::new(
                tokio::runtime::Runtime::new()
                    .expect("runtime")
                    .block_on(Database::open(&db_path))
                    .expect("Failed to init DB"),
            );

            app.manage(AppState {
                db: db.clone(),
                scraper: scraper.clone(),
                tier_cache: Mutex::new(None),
            });

            let db_spawn = db.clone();
            let scraper_spawn = scraper.clone();
            let icon_cache_dir = app_data.join("game_assets_icons");
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                let _ = game_assets::try_seed_manifest_meta(db_spawn.as_ref()).await;
                if db_spawn.static_catalog_count().await.unwrap_or(0) == 0 {
                    let _ = game_assets::refresh_game_assets(
                        scraper_spawn.as_ref(),
                        db_spawn.as_ref(),
                        Some(icon_cache_dir.as_path()),
                        true,
                    )
                    .await;
                }
            });

            #[cfg(not(debug_assertions))]
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    try_auto_update_from_github(app_handle).await;
                });
            }
            
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
            get_cached_patch_versions,
            get_latest_patch_data,
            get_patch_by_version,
            get_champion_history,
            get_item_history,
            get_rune_history,
            get_all_champions,
            get_changed_itemsrunes_titles,
            get_tier_list,
            sync_patch_history,
            sync_previous_patch_history_to_limit,
            clear_database,
            clear_all_cached_data,
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
            get_mayhem_augmentations_page,
            refresh_mayhem_augmentations_from_wiki,
            refresh_game_assets,
            warm_full_cache,
            cache_status,
            validate_cached_assets,
            get_game_assets_meta,
            get_static_catalog_rows,
            get_static_catalog_items_for_maps
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
