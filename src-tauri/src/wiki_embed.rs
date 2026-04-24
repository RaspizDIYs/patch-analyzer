use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::NewWindowResponse;
use tauri_plugin_opener::OpenerExt;

pub const WIKI_EMBED_LABEL: &str = "wiki-embed";
const WIKI_CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WIKI_EMBED_INIT_SCRIPT: &str = r#"
(() => {
  const apply = () => {
    const html = document.documentElement;
    const body = document.body;
    if (!html || !body) return;
    html.style.overflowX = "hidden";
    body.style.overflowX = "hidden";

    let style = document.getElementById("patch-analyzer-wiki-scroll-fix");
    if (!style) {
      style = document.createElement("style");
      style.id = "patch-analyzer-wiki-scroll-fix";
      style.textContent = `
        html, body { overflow-x: hidden !important; }
        *::-webkit-scrollbar:horizontal {
          height: 0 !important;
          max-height: 0 !important;
        }
      `;
      document.head.appendChild(style);
    }
  };

  apply();
  window.addEventListener("load", apply, { once: true });
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
})();
"#;

pub fn is_allowed_wiki_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    url.host_str()
        .map(|h| h.eq_ignore_ascii_case("wiki.leagueoflegends.com"))
        .unwrap_or(false)
}

fn focus_navigate_wiki_window(app: &AppHandle, url: &Url) -> Result<(), String> {
    let w = app
        .get_webview_window(WIKI_EMBED_LABEL)
        .ok_or_else(|| "wiki window missing".to_string())?;
    w.navigate(url.clone()).map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn wiki_embed_open(app: AppHandle, url: String) -> Result<(), String> {
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    if !is_allowed_wiki_url(&target) {
        return Err("URL must be https://wiki.leagueoflegends.com/...".to_string());
    }

    if app.get_webview_window(WIKI_EMBED_LABEL).is_some() {
        focus_navigate_wiki_window(&app, &target)?;
        return Ok(());
    }

    let opener_nav = app.clone();
    let opener_newwin = app.clone();

    WebviewWindowBuilder::new(&app, WIKI_EMBED_LABEL, WebviewUrl::External(target.clone()))
        .title("LoL Wiki")
        .inner_size(1100.0, 800.0)
        .user_agent(WIKI_CHROME_UA)
        .initialization_script(WIKI_EMBED_INIT_SCRIPT)
        .on_navigation(move |u| {
            if is_allowed_wiki_url(u) {
                true
            } else if u.scheme() == "http" || u.scheme() == "https" {
                let _ = opener_nav.opener().open_url(u.as_str(), None::<&str>);
                false
            } else {
                false
            }
        })
        .on_new_window(move |u, _| {
            if is_allowed_wiki_url(&u) {
                let _ = focus_navigate_wiki_window(&opener_newwin, &u);
                NewWindowResponse::Deny
            } else if u.scheme() == "http" || u.scheme() == "https" {
                let _ = opener_newwin.opener().open_url(u.as_str(), None::<&str>);
                NewWindowResponse::Deny
            } else {
                NewWindowResponse::Deny
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn wiki_embed_close(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WIKI_EMBED_LABEL) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
