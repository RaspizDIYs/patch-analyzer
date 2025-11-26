use tauri::{State, Manager};
use tokio::sync::Mutex;
use crate::db::Database;
use crate::scraper::Scraper;
use crate::analyzer::Analyzer;
use crate::models::{MetaAnalysisDiff, PatchData};

pub mod models;
pub mod db;
pub mod scraper;
pub mod analyzer;

struct AppState {
    db: Database,
    scraper: Scraper,
}

#[tauri::command]
async fn analyze_patch(
    version: String, 
    state: State<'_, Mutex<AppState>>
) -> Result<Vec<MetaAnalysisDiff>, String> {
    let app = state.lock().await;
    
    // 1. Фетчим текущие данные (и op.gg и riot)
    let current_data = app.scraper.fetch_current_meta(&version)
        .await
        .map_err(|e| format!("Scraper Error: {}", e))?;
        
    // 2. Сохраняем в БД
    app.db.save_patch(&current_data)
        .await
        .map_err(|e| format!("DB Error: {}", e))?;
        
    // 3. Ищем историю
    let recent = app.db.get_recent_patches(2)
        .await
        .map_err(|e| e.to_string())?;
        
    if recent.len() < 2 {
        // Если истории нет, сравниваем с самим собой (нули) но показываем предсказания из патч-нотов
        let diffs = Analyzer::compare_patches(&current_data, &current_data);
        return Ok(diffs);
    }
    
    let diffs = Analyzer::compare_patches(&recent[0], &recent[1]);
    Ok(diffs)
}

#[tauri::command]
async fn get_latest_patch_data(state: State<'_, Mutex<AppState>>) -> Result<Option<PatchData>, String> {
    let app = state.lock().await;
    let recent = app.db.get_recent_patches(1).await.map_err(|e| e.to_string())?;
    Ok(recent.into_iter().next())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            tauri::async_runtime::block_on(async {
                let db = Database::new().await.expect("Failed to init DB");
                let scraper = Scraper::new().expect("Failed to init Scraper");
                
                app.manage(Mutex::new(AppState { db, scraper }));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![analyze_patch, get_latest_patch_data])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
