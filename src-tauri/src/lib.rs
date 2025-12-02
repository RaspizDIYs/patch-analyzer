use tauri::{AppHandle, Manager, Emitter};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
use tauri::image::Image;
use tokio::sync::Mutex;
use crate::db::Database;
use crate::scraper::Scraper;
use crate::analyzer::Analyzer;
use crate::models::{PatchData, MetaAnalysisDiff, PatchNoteEntry, PatchCategory};
use std::collections::{HashSet, HashMap};
use serde::Serialize;
use regex::Regex;

pub mod models;
pub mod db;
pub mod scraper;
pub mod analyzer;

struct AppState {
    db: Database,
    scraper: Scraper,
    tier_cache: Option<(String, Vec<TierEntry>)>,
}

#[derive(Serialize, Clone, Debug)]
pub struct LogEntry {
    level: String,
    message: String,
    timestamp: String,
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

fn log(app: &AppHandle, level: &str, message: &str) {
    let entry = LogEntry {
        level: level.to_string(),
        message: message.to_string(),
        timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
    };
    
    // Emit to all windows
    if let Err(e) = app.emit("log_message", &entry) {
        println!("Failed to emit log: {}", e);
    } else {
        // Also try specific main window if global fails or to be sure
        let _ = app.emit_to("main", "log_message", &entry);
    }
    
    println!("[{}] {}", level, message);
}

// ... get_or_fetch_patch same ...
async fn get_or_fetch_patch(version: &str, app: &AppHandle, state: &AppState, force_refresh: bool) -> Result<PatchData, String> {
    if !force_refresh {
        if let Ok(Some(patch)) = state.db.get_patch(version).await {
            return Ok(patch);
        }
    }
    log(app, "INFO", &format!("Fetching patch data for {} from web...", version));
    match state.scraper.fetch_current_meta(version).await {
        Ok(data) => {
            let _ = state.db.save_patch(&data).await;
            log(app, "SUCCESS", &format!("Data for {} fetched and saved.", version));
            Ok(data)
        },
        Err(e) => {
            log(app, "ERROR", &format!("Failed to fetch patch {}: {}", version, e));
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn analyze_patch(version: String, force: bool, app: AppHandle, state: tauri::State<'_, Mutex<AppState>>) -> Result<Vec<MetaAnalysisDiff>, String> {
    let state = state.lock().await;
    let current = get_or_fetch_patch(&version, &app, &state, force).await?;
    let patches = state.db.get_recent_patches(10).await.map_err(|e| e.to_string())?;
    let previous = patches.iter().find(|p| p.version != version);

    if let Some(prev) = previous {
        let diffs = Analyzer::compare_patches(&current, prev);
        Ok(diffs)
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
async fn get_patch_by_version(version: String, app: AppHandle, state: tauri::State<'_, Mutex<AppState>>) -> Result<PatchData, String> {
    let state = state.lock().await;
    get_or_fetch_patch(&version, &app, &state, false).await
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
    match state.scraper.fetch_all_champions_ddragon().await {
        Ok(list) => Ok(
            list
                .into_iter()
                .map(|(name, name_en, icon_url)| ChampionListItem { name, name_en, icon_url })
                .collect(),
        ),
        Err(e) => Err(e.to_string())
    }
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
            if note.category == PatchCategory::ItemsRunes {
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
async fn sync_patch_history(app: AppHandle, state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
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
        let exists = {
             let state = state.lock().await;
             state.db.get_patch(&version).await.unwrap_or(None).is_some()
        };

        if !exists {
             log(&app, "INFO", &format!("Downloading missing patch: {} ...", version));
             let fetch_result = {
                 let state = state.lock().await;
                 state.scraper.fetch_current_meta(&version).await
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

    log(&app, "SUCCESS", "History sync completed.");
    Ok(())
}

#[tauri::command]
async fn clear_database(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let state = state.lock().await;
    state.db.clear_database().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = tokio::runtime::Runtime::new().unwrap().block_on(Database::new()).expect("Failed to init DB");
    let scraper = Scraper::new().expect("Failed to init Scraper");

    tauri::Builder::default()
        .setup(|app| {
            app.manage(Mutex::new(AppState { db, scraper, tier_cache: None }));
            
            let menu = Menu::with_items(app, &[
                &MenuItem::with_id(app, "Show", "Show", true, None::<&str>)?,
                &MenuItem::with_id(app, "Quit", "Quit", true, None::<&str>)?,
            ])?;

            // Use image crate via tauri's feature if available, or just ignore tray icon if compilation fails without
            // Since we added image-png, this should work
            let icon = Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap();

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("LoL Meta Analyzer")
                .icon(icon)
                .on_menu_event(move |tray, event| match event.id.as_ref() {
                    "Show" => {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
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
            clear_database
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
