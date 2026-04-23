//! Локальный бандл аугментов (wiki modules + category galleries), без сети в рантайме приложения.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

use scraper::{Html, Selector};

use crate::db::augment_row_matches_icon_url;
use crate::db::normalize_augment_lookup_key;
use crate::db::WIKI_AUGMENT_DETAIL_TITLE;
use crate::models::{ChangeBlock, PatchCategory, PatchNoteEntry, StaticCatalogRow};
use crate::scraper::{clean_wiki_asset_url, resolve_league_wiki_asset_url};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundledAugmentEntry {
    pub title: String,
    pub tier: String,
    #[serde(default)]
    pub set_label: String,
    #[serde(default)]
    pub description_html: String,
    #[serde(default)]
    pub notes_html: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    /// "arena" | "mayhem"
    pub pool: String,
    #[serde(default)]
    pub riot_augment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AugmentsBundled {
    pub generated_at: String,
    pub arena: Vec<BundledAugmentEntry>,
    pub mayhem: Vec<BundledAugmentEntry>,
}

const CD_BASE: &str = "https://raw.communitydragon.org/latest";

fn percent_decode_filename(s: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h1), Some(h2)) = (
                (b[i + 1] as char).to_digit(16),
                (b[i + 2] as char).to_digit(16),
            ) {
                out.push(((h1 << 4) | h2) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn cherry_plugin_icon_url(path: &str) -> Option<String> {
    let p = path.trim();
    if p.is_empty() {
        return None;
    }
    let rest = p.trim_start_matches("/lol-game-data/");
    Some(format!(
        "{}/plugins/rcp-be-lol-game-data/global/default/{}",
        CD_BASE, rest
    ))
}

fn skip_lua_string(bytes: &[u8], mut i: usize) -> Option<usize> {
    if bytes.get(i)? != &b'"' {
        return None;
    }
    i += 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => {
                i = i.saturating_add(2);
            }
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

fn skip_lua_long_bracket(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i)? != &b'[' {
        return None;
    }
    let mut eq = 0usize;
    let mut j = i + 1;
    while j < bytes.len() && bytes[j] == b'=' {
        eq += 1;
        j += 1;
    }
    if bytes.get(j)? != &b'[' {
        return None;
    }
    j += 1;
    let close = format!("]{}]", "=".repeat(eq));
    let rest = std::str::from_utf8(bytes.get(j..)?).ok()?;
    let pos = rest.find(&close)?;
    Some(j + pos + close.len())
}

fn skip_until_inner_table_end(bytes: &[u8], mut i: usize) -> Option<usize> {
    let mut depth = 1u32;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' {
            i = skip_lua_string(bytes, i)?;
            continue;
        }
        if b == b'[' {
            if let Some(ni) = skip_lua_long_bracket(bytes, i) {
                i = ni;
                continue;
            }
        }
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Извлекает тело вложенной таблицы после `["key"] = {` — `inner` без внешних скобок.
fn extract_augment_inner_tables(lua: &str) -> Vec<(String, String)> {
    let bytes = lua.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 2 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'"' {
            let name_start = i + 2;
            let mut j = name_start;
            while j < bytes.len() && bytes[j] != b'"' {
                j += 1;
            }
            if j >= bytes.len() {
                break;
            }
            let name = lua[name_start..j].to_string();
            j += 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if bytes.get(j) == Some(&b']') {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
            }
            if bytes.get(j) != Some(&b'=') {
                i = j;
                continue;
            }
            j += 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if bytes.get(j) != Some(&b'{') {
                i = j;
                continue;
            }
            let inner_start = j + 1;
            let end_inner = skip_until_inner_table_end(bytes, inner_start);
            let Some(end_pos) = end_inner else {
                break;
            };
            let inner = lua[inner_start..end_pos].to_string();
            out.push((name, inner));
            i = end_pos + 1;
            continue;
        }
        i += 1;
    }
    out
}

fn extract_field_string(inner: &str, field: &str) -> Option<String> {
    let key = format!(r#"["{}"]"#, field);
    let pos = inner.find(&key)?;
    let mut i = pos + key.len();
    let bytes = inner.as_bytes();
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i)? != &b'=' {
        return None;
    }
    i += 1;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i)? != &b'"' {
        return None;
    }
    i += 1;
    let mut s = String::new();
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return Some(s),
            b'\\' => {
                i += 1;
                let c = *bytes.get(i)?;
                match c {
                    b'n' => s.push('\n'),
                    b't' => s.push('\t'),
                    b'r' => s.push('\r'),
                    b'"' => s.push('"'),
                    b'\\' => s.push('\\'),
                    _ => {
                        s.push('\\');
                        s.push(c as char);
                    }
                }
            }
            o => s.push(o as char),
        }
        i += 1;
    }
    None
}

fn extract_notes_long_bracket(inner: &str) -> Option<String> {
    let re = Regex::new(r#"(?s)\["notes"\]\s*=\s*\[=*\[(.*?)\]=*\]"#).ok()?;
    let cap = re.captures(inner)?;
    let s = cap.get(1)?.as_str().trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Парсит сырой Lua `Module:*AugmentData/data` (тело страницы с `return { ... }`).
pub fn parse_lua_augment_module(lua: &str, pool: &str) -> Vec<BundledAugmentEntry> {
    let lower = lua.to_ascii_lowercase();
    let start = lower.find("return").unwrap_or(0);
    let slice = lua.get(start..).unwrap_or(lua);
    let mut out = Vec::new();
    for (title, inner) in extract_augment_inner_tables(slice) {
        if matches!(
            title.as_str(),
            "documentation" | "doc" | "description" | "tier" | "notes"
        ) {
            continue;
        }
        if !inner.contains("[\"description\"]") && !inner.contains("[\"tier\"]") {
            continue;
        }
        let tier = extract_field_string(&inner, "tier").unwrap_or_default();
        let set_label = extract_field_string(&inner, "set").unwrap_or_default();
        let description_html = extract_field_string(&inner, "description").unwrap_or_default();
        let notes_html = extract_notes_long_bracket(&inner);
        out.push(BundledAugmentEntry {
            title,
            tier,
            set_label,
            description_html,
            notes_html,
            icon_url: None,
            pool: pool.to_string(),
            riot_augment_id: None,
        });
    }
    out
}

fn stem_from_augment_filename(fname: &str, pool: &str) -> Option<String> {
    let decoded = percent_decode_filename(fname);
    let base = decoded.rsplit('/').next().unwrap_or(decoded.as_str());
    let base = base.strip_prefix("File:").unwrap_or(base);
    let lower = base.to_lowercase();
    let stem = if pool == "mayhem" {
        let i = lower.rfind("_mayhem_augment.")?;
        &base[..i]
    } else if pool == "arena" {
        if lower.contains("_mayhem_augment") {
            return None;
        }
        if let Some(i) = lower.rfind("_arena_augment.") {
            &base[..i]
        } else if let Some(i) = lower.rfind("_augment.") {
            &base[..i]
        } else {
            return None;
        }
    } else {
        return None;
    };
    Some(stem.replace('_', " ").trim().to_string())
}

/// Парсит одну HTML-страницу категории (галерея). `pool`: `arena` | `mayhem` — суффиксы имён файлов различаются.
pub fn parse_category_gallery_page(html: &str, pool: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let doc = Html::parse_document(html);
    let Ok(li_sel) = Selector::parse("ul.gallery li.gallerybox") else {
        return map;
    };
    let Ok(img_sel) = Selector::parse("img") else {
        return map;
    };
    for li in doc.select(&li_sel) {
        let img = li.select(&img_sel).next();
        let Some(img_el) = img else {
            continue;
        };
        let src = img_el
            .value()
            .attr("src")
            .or_else(|| img_el.value().attr("data-src"));
        let Some(src) = src else {
            continue;
        };
        let href = li
            .select(&Selector::parse("a.mw-file-description").unwrap())
            .next()
            .and_then(|a| a.value().attr("href"));
        let fname = href
            .and_then(|h| h.rsplit('/').next())
            .unwrap_or("");
        let Some(stem_title) = stem_from_augment_filename(fname, pool) else {
            continue;
        };
        let key = normalize_augment_lookup_key(&stem_title);
        if key.len() < 2 {
            continue;
        }
        let url = clean_wiki_asset_url(&resolve_league_wiki_asset_url(src));
        map.insert(key, url);
    }
    map
}

fn merge_icons(
    entries: &mut [BundledAugmentEntry],
    icons: &HashMap<String, String>,
) -> (usize, usize) {
    let mut matched = 0usize;
    let mut missing = 0usize;
    for e in entries.iter_mut() {
        let k = normalize_augment_lookup_key(&e.title);
        if let Some(u) = icons.get(&k) {
            e.icon_url = Some(u.clone());
            matched += 1;
        } else {
            missing += 1;
        }
    }
    (matched, missing)
}

fn cherry_name_to_pool(name: &str, path: &str) -> String {
    let p = path.to_lowercase();
    if p.contains("/cherry/") {
        return "arena".to_string();
    }
    if p.contains("/kiwi/")
        || p.contains("mayhem")
        || p.contains("aram_")
        || p.contains("/maps/particles/kiwi/")
    {
        return "mayhem".to_string();
    }
    let n = name.to_lowercase();
    if n.contains("arena") {
        return "arena".to_string();
    }
    "mayhem".to_string()
}

/// Сопоставление riot id и нормализованного EN-имени из cherry-augments.json (массив объектов).
/// Если иконки с вики нет, подставляет URL иконки из CDragon по `augmentSmallIconPath`.
pub fn attach_cherry_ids(entries: &mut [BundledAugmentEntry], cherry_json: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(cherry_json) else {
        return;
    };
    let Some(arr) = v.as_array() else {
        return;
    };
    let mut by_name: HashMap<String, (String, String, Option<String>)> = HashMap::new();
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
        let pool = cherry_name_to_pool(&name_en, path);
        let k = normalize_augment_lookup_key(&name_en);
        if k.len() < 2 {
            continue;
        }
        let cd_url = cherry_plugin_icon_url(path);
        by_name.insert(k, (id.to_string(), pool, cd_url));
    }
    for e in entries.iter_mut() {
        let k = normalize_augment_lookup_key(&e.title);
        if let Some((id, pool_hint, cd_url)) = by_name.get(&k) {
            if pool_hint == &e.pool {
                e.riot_augment_id = Some(id.clone());
                if e.icon_url.is_none() {
                    if let Some(u) = cd_url {
                        e.icon_url = Some(u.clone());
                    }
                }
            }
        }
    }
}

pub fn build_bundled(
    arena_lua: &str,
    mayhem_lua: &str,
    arena_icons: &HashMap<String, String>,
    mayhem_icons: &HashMap<String, String>,
    cherry_json: Option<&str>,
) -> AugmentsBundled {
    let mut arena = parse_lua_augment_module(arena_lua, "arena");
    let mut mayhem = parse_lua_augment_module(mayhem_lua, "mayhem");
    merge_icons(&mut arena, arena_icons);
    merge_icons(&mut mayhem, mayhem_icons);
    if let Some(cj) = cherry_json {
        attach_cherry_ids(&mut arena, cj);
        attach_cherry_ids(&mut mayhem, cj);
    }
    AugmentsBundled {
        generated_at: chrono::Utc::now().to_rfc3339(),
        arena,
        mayhem,
    }
}

static EMBEDDED_BUNDLE_JSON: &str = include_str!("../../src/data/augments-bundled.json");

static PARSED_BUNDLE: OnceLock<Option<AugmentsBundled>> = OnceLock::new();

static AUGMENT_RU_ALIASES_JSON: &str = include_str!("../../src/data/augment_ru_aliases.json");
static AUGMENT_RU_ALIASES: OnceLock<std::collections::HashMap<String, String>> = OnceLock::new();

pub fn augment_ru_to_en_aliases() -> &'static std::collections::HashMap<String, String> {
    AUGMENT_RU_ALIASES.get_or_init(|| {
        let mut m = std::collections::HashMap::new();
        let Ok(v) = serde_json::from_str::<serde_json::Value>(AUGMENT_RU_ALIASES_JSON) else {
            return m;
        };
        let Some(obj) = v.get("aliases").and_then(|x| x.as_object()) else {
            return m;
        };
        for (k, val) in obj {
            let Some(s) = val.as_str() else {
                continue;
            };
            let key = normalize_augment_lookup_key(k);
            if key.len() < 2 {
                continue;
            }
            m.insert(key, s.trim().to_string());
        }
        m
    })
}

/// Русский заголовок в патче Riot → каноническое EN-имя из бандла (если есть в `augment_ru_aliases.json`).
pub fn resolve_augment_title_for_bundle_lookup(title: &str) -> String {
    let k = normalize_augment_lookup_key(title);
    if let Some(en) = augment_ru_to_en_aliases().get(&k) {
        return en.clone();
    }
    title.to_string()
}

pub fn bundled_augment_data() -> Option<&'static AugmentsBundled> {
    PARSED_BUNDLE
        .get_or_init(|| serde_json::from_str(EMBEDDED_BUNDLE_JSON).ok())
        .as_ref()
}

/// Иконка из бандла: нормализованный заголовок заметки + pool по категории патча.
pub fn bundle_icon_for_note(norm_title: &str, pool: &str) -> Option<String> {
    let b = bundled_augment_data()?;
    let list = if pool == "arena" {
        &b.arena
    } else {
        &b.mayhem
    };
    let nk = normalize_augment_lookup_key(norm_title);
    for e in list {
        if normalize_augment_lookup_key(&e.title) == nk {
            return e.icon_url.clone();
        }
    }
    None
}

/// Иконка по RU/EN заголовку через мост static_catalog: найти name_en, затем бандл.
/// Подставляет иконку и блок «League Wiki» из локального бандла (EN/RU заголовок через каталог).
pub fn enrich_patch_notes_from_bundle(notes: &mut [PatchNoteEntry], augments: &[StaticCatalogRow]) {
    let Some(b) = bundled_augment_data() else {
        return;
    };
    if b.arena.is_empty() && b.mayhem.is_empty() {
        return;
    }
    for note in notes.iter_mut() {
        if note.category != PatchCategory::ModeAramChaos && note.category != PatchCategory::ModeArena
        {
            continue;
        }
        let pool = if note.category == PatchCategory::ModeArena {
            "arena"
        } else {
            "mayhem"
        };
        let list = if pool == "arena" {
            &b.arena
        } else {
            &b.mayhem
        };
        let resolved = resolve_augment_title_for_bundle_lookup(&note.title);
        let nt_res = normalize_augment_lookup_key(&resolved);
        let nt_orig = normalize_augment_lookup_key(&note.title);
        let mut matched = list.iter().find(|e| {
            let ek = normalize_augment_lookup_key(&e.title);
            ek == nt_res || ek == nt_orig
        });
        if matched.is_none() {
            for r in augments {
                if r.kind != "augment" {
                    continue;
                }
                let en = normalize_augment_lookup_key(&r.name_en);
                let ru = normalize_augment_lookup_key(&r.name_ru);
                if nt_res != en && nt_res != ru && nt_orig != en && nt_orig != ru {
                    continue;
                }
                let meta_pool = r
                    .cd_meta
                    .as_ref()
                    .and_then(|m| m.get("pool"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                if !meta_pool.is_empty() && meta_pool != pool && meta_pool != "unknown" {
                    continue;
                }
                let nk = normalize_augment_lookup_key(&r.name_en);
                matched = list.iter().find(|e| normalize_augment_lookup_key(&e.title) == nk);
                break;
            }
        }
        if matched.is_none() {
            if let Some(ref img) = note.image_url {
                for r in augments {
                    if r.kind != "augment" || !augment_row_matches_icon_url(r, img) {
                        continue;
                    }
                    let meta_pool = r
                        .cd_meta
                        .as_ref()
                        .and_then(|m| m.get("pool"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    if !meta_pool.is_empty() && meta_pool != pool && meta_pool != "unknown" {
                        continue;
                    }
                    let nk = normalize_augment_lookup_key(&r.name_en);
                    matched = list.iter().find(|e| normalize_augment_lookup_key(&e.title) == nk);
                    if matched.is_some() {
                        break;
                    }
                }
            }
        }
        let Some(entry) = matched else {
            continue;
        };
        if let Some(u) = &entry.icon_url {
            if !u.is_empty() {
                note.image_url = Some(u.clone());
            }
        }
        let wiki_text = entry.description_html.trim().to_string();
        if wiki_text.is_empty() {
            continue;
        }
        let dup = note
            .details
            .iter()
            .any(|b| b.title.as_deref() == Some(WIKI_AUGMENT_DETAIL_TITLE));
        if dup {
            continue;
        }
        let icon_url = note.image_url.clone();
        note.details.insert(
            0,
            ChangeBlock {
                title: Some(WIKI_AUGMENT_DETAIL_TITLE.to_string()),
                icon_url,
                changes: vec![wiki_text],
            },
        );
    }
}

pub fn bundle_icon_via_catalog_bridge(
    note_title: &str,
    pool: &str,
    augments: &[StaticCatalogRow],
) -> Option<String> {
    let resolved = resolve_augment_title_for_bundle_lookup(note_title);
    let nt_res = normalize_augment_lookup_key(&resolved);
    let nt_orig = normalize_augment_lookup_key(note_title);
    for r in augments {
        if r.kind != "augment" {
            continue;
        }
        let en = normalize_augment_lookup_key(&r.name_en);
        let ru = normalize_augment_lookup_key(&r.name_ru);
        if nt_res != en && nt_res != ru && nt_orig != en && nt_orig != ru {
            continue;
        }
        let meta_pool = r
            .cd_meta
            .as_ref()
            .and_then(|m| m.get("pool"))
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if !meta_pool.is_empty() && meta_pool != pool && meta_pool != "unknown" {
            continue;
        }
        return bundle_icon_for_note(&r.name_en, pool);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gallery_decodes_percent_encoded_apostrophe_in_filename() {
        let html = r##"<ul class="gallery"><li class="gallerybox"><a href="/en-us/File:Can%27t_Touch_This_augment.png" class="mw-file-description"><img src="/en-us/images/x.png"/></a></li></ul>"##;
        let m = parse_category_gallery_page(html, "arena");
        let k = normalize_augment_lookup_key("Can't Touch This");
        assert!(
            m.contains_key(&k),
            "expected key {:?}, got {:?}",
            k,
            m.keys().next()
        );
    }

    #[test]
    fn parses_small_lua_fixture() {
        let lua = r#"return { ["Test One"] = { ["description"] = "Hello {{tip|AD}}", ["tier"] = "Gold", }, ["Second"] = { ["description"] = "D", ["tier"] = "Silver", ["notes"] = [=[ * line ]=], }, }"#;
        let rows = parse_lua_augment_module(lua, "mayhem");
        assert_eq!(rows.len(), 2, "extracted rows");
        assert_eq!(rows[0].title, "Test One");
        assert_eq!(rows[0].tier, "Gold");
        assert!(rows[0].description_html.contains("{{tip|AD}}"));
        assert_eq!(rows[1].notes_html.as_deref(), Some("* line"));
    }
}
