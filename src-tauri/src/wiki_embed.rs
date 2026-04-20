use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tauri::webview::{PageLoadEvent, Url, WebviewBuilder};
use tauri_plugin_opener::OpenerExt;

pub const WIKI_EMBED_LABEL: &str = "wiki-embed";
const WIKI_CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub fn is_allowed_wiki_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let h = host.to_lowercase();
    h == "wiki.leagueoflegends.com"
        || h == "leagueoflegends.fandom.com"
        || h == "www.leagueoflegends.fandom.com"
        || (h.ends_with(".fandom.com") && h.contains("leagueoflegends"))
}

#[tauri::command]
pub fn wiki_embed_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    if !is_allowed_wiki_url(&target) {
        return Err("URL must be League wiki or leagueoflegends.fandom.com (https)".to_string());
    }

    let window = app
        .get_webview("main")
        .ok_or_else(|| "main webview not found".to_string())?
        .window();

    if let Some(w) = app.get_webview(WIKI_EMBED_LABEL) {
        w.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        w.set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        w.navigate(target).map_err(|e| e.to_string())?;
        w.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let app_emit = app.clone();
    let opener_app = app.clone();

    let builder = WebviewBuilder::new(WIKI_EMBED_LABEL, WebviewUrl::External(target))
        .user_agent(WIKI_CHROME_UA)
        .on_navigation(move |u| {
            if is_allowed_wiki_url(u) {
                true
            } else if u.scheme() == "http" || u.scheme() == "https" {
                let _ = opener_app.opener().open_url(u.as_str(), None::<&str>);
                false
            } else {
                false
            }
        })
        .on_page_load(move |wv, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Ok(u) = wv.url() {
                    let _ = app_emit.emit(
                        "wiki-embed:navigated",
                        serde_json::json!({ "url": u.to_string() }),
                    );
                }
            }
        });

    let wiki_wv = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    wiki_wv.show().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn wiki_embed_close(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview(WIKI_EMBED_LABEL) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn wiki_embed_resize(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let w = app
        .get_webview(WIKI_EMBED_LABEL)
        .ok_or_else(|| "wiki embed not open".to_string())?;
    w.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    w.set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn wiki_embed_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    if !is_allowed_wiki_url(&target) {
        return Err("invalid wiki URL".to_string());
    }
    let w = app
        .get_webview(WIKI_EMBED_LABEL)
        .ok_or_else(|| "wiki embed not open".to_string())?;
    w.navigate(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wiki_embed_go_back(app: AppHandle) -> Result<(), String> {
    let w = app
        .get_webview(WIKI_EMBED_LABEL)
        .ok_or_else(|| "wiki embed not open".to_string())?;
    w.eval("history.back()").map_err(|e| e.to_string())
}
