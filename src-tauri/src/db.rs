use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::ChampionHistoryEntry;
use crate::models::{
    ChampionStats, ChangeBlock, GameAssetsMeta, IconSourceEntry, MayhemAugmentation, PatchCategory,
    PatchData, PatchNoteEntry, StaticCatalogRow,
};
use crate::patch_version::{
    cmp_display_patch, display_patch_to_ddragon_major_minor, versions_match,
    DISPLAY_MAJOR_MAP_TO_DDRAGON_FROM,
};
use serde::{Deserialize, Serialize};
use serde_json;

pub const AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_EN: &str = "aram_mayhem_en";
pub const AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_RU: &str = "aram_mayhem_ru";
pub const MAYHEM_AUG_PAGE_KEY_EN: &str = "mayhem_aug_page_en";
pub const MAYHEM_AUG_PAGE_KEY_RU: &str = "mayhem_aug_page_ru";

pub fn cd_meta_allows_maps(meta: &serde_json::Value, wanted: &[u32]) -> bool {
    if wanted.is_empty() {
        return true;
    }
    if let Some(arr) = meta.get("mapIds").and_then(|x| x.as_array()) {
        let have: Vec<u32> = arr
            .iter()
            .filter_map(|v| v.as_u64().map(|u| u as u32))
            .collect();
        if have.is_empty() {
            return true;
        }
        return wanted.iter().any(|w| have.contains(w));
    }
    if let Some(m) = meta.get("mapId").and_then(|x| x.as_u64()) {
        let m = m as u32;
        return wanted.contains(&m);
    }
    true
}

fn html_escape_min(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn split_tier_set_from_summary(summary: &str) -> (String, String) {
    let parts: Vec<&str> = summary
        .split(" · ")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        (String::new(), String::new())
    } else if parts.len() == 1 {
        (parts[0].to_string(), String::new())
    } else {
        (parts[0].to_string(), parts[1..].join(" · "))
    }
}

fn normalize_patch_locale(locale: &str) -> &'static str {
    if locale.eq_ignore_ascii_case("en") {
        "en"
    } else {
        "ru"
    }
}

fn patch_note_to_effect_html(note: &PatchNoteEntry) -> String {
    let mut parts: Vec<String> = Vec::new();
    for b in &note.details {
        for c in &b.changes {
            let t = c.trim();
            if !t.is_empty() {
                parts.push(html_escape_min(t));
            }
        }
    }
    if parts.is_empty() {
        let s = note.summary.trim();
        if s.is_empty() {
            return String::new();
        }
        return format!("<p>{}</p>", html_escape_min(s));
    }
    parts.join("<br/>")
}

/// Fallback для UI: из каталога augments (PatchNoteEntry) в строки таблицы Mayhem.
pub fn mayhem_rows_from_patch_notes(notes: &[PatchNoteEntry]) -> Vec<MayhemAugmentation> {
    notes
        .iter()
        .filter(|n| n.category == PatchCategory::ModeAramAugments)
        .map(|n| {
            let (tier, set_label) = split_tier_set_from_summary(&n.summary);
            MayhemAugmentation {
                id: n.id.clone(),
                title: n.title.clone(),
                icon_url: n.image_url.clone(),
                effect_html: patch_note_to_effect_html(n),
                tier,
                set_label,
                set_icon_url: None,
            }
        })
        .collect()
}

pub fn augments_catalog_should_refresh(
    last_fetched: Option<chrono::DateTime<chrono::Utc>>,
    force: bool,
) -> bool {
    if force {
        return true;
    }
    match last_fetched {
        None => true,
        Some(t) => chrono::Utc::now().signed_duration_since(t).num_hours() >= 24,
    }
}

/// Маркер заголовка блока с полным текстом аугмента с вики; на фронте мапится в i18n.
pub const WIKI_AUGMENT_DETAIL_TITLE: &str = "League Wiki";

pub fn normalize_augment_lookup_key(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn augment_row_matches_icon_url(row: &StaticCatalogRow, image_url: &str) -> bool {
    if row.kind != "augment" {
        return false;
    }
    let needle = image_url.trim();
    if needle.is_empty() {
        return false;
    }
    let needle_lc = needle.to_lowercase();
    let needle_nop = needle_lc.split('?').next().unwrap_or("");
    for e in &row.icon_sources {
        let Some(u) = e.url.as_ref() else {
            continue;
        };
        let hay = u.trim().to_lowercase();
        let hay_nop = hay.split('?').next().unwrap_or("");
        if needle_nop == hay_nop {
            return true;
        }
        let ns = needle_nop.rsplit('/').next().unwrap_or("");
        let hs = hay_nop.rsplit('/').next().unwrap_or("");
        if !ns.is_empty() && ns == hs {
            return true;
        }
    }
    false
}

fn wiki_catalog_effect_text(entry: &PatchNoteEntry) -> String {
    let mut parts: Vec<String> = Vec::new();
    let sum = entry.summary.trim();
    if !sum.is_empty() {
        parts.push(sum.to_string());
    }
    for b in &entry.details {
        for c in &b.changes {
            let t = c.trim();
            if !t.is_empty() {
                parts.push(t.to_string());
            }
        }
    }
    parts.join(" ")
}

fn wiki_augment_lookup_map(
    wiki_catalog: &[PatchNoteEntry],
) -> HashMap<String, (Option<String>, String)> {
    let mut map = HashMap::new();
    for w in wiki_catalog {
        if w.category != PatchCategory::ModeAramAugments {
            continue;
        }
        let k = normalize_augment_lookup_key(&w.title);
        if k.len() < 2 {
            continue;
        }
        let text = wiki_catalog_effect_text(w);
        map.insert(k, (w.image_url.clone(), text));
    }
    map
}

fn wiki_augment_lookup_map_merged(
    wiki_catalog_en: &[PatchNoteEntry],
    wiki_catalog_ru: &[PatchNoteEntry],
) -> HashMap<String, (Option<String>, String)> {
    let mut map = wiki_augment_lookup_map(wiki_catalog_en);
    for ru in wiki_catalog_ru.iter() {
        if ru.category != PatchCategory::ModeAramAugments {
            continue;
        }
        let k = normalize_augment_lookup_key(&ru.title);
        if k.len() < 2 {
            continue;
        }
        let ru_text = wiki_catalog_effect_text(ru);
        let prev = map.get(&k).cloned();
        let text = if ru_text.trim().is_empty() {
            prev.as_ref().map(|(_, t)| t.clone()).unwrap_or_default()
        } else {
            ru_text
        };
        let img = ru
            .image_url
            .clone()
            .or_else(|| prev.and_then(|(i, _)| i));
        map.insert(k, (img, text));
    }
    map
}

fn match_wiki_augment_row(
    note_title_norm: &str,
    map: &HashMap<String, (Option<String>, String)>,
) -> Option<(Option<String>, String)> {
    if note_title_norm.len() < 2 {
        return None;
    }
    if let Some(v) = map.get(note_title_norm) {
        return Some(v.clone());
    }
    let mut best_len = 0usize;
    let mut best: Option<(Option<String>, String)> = None;
    for (k, v) in map.iter() {
        if k.len() < 3 {
            continue;
        }
        if note_title_norm.starts_with(k.as_str()) {
            if k.len() > best_len {
                best_len = k.len();
                best = Some(v.clone());
            }
        } else if k.starts_with(note_title_norm) && note_title_norm.len() >= 3 {
            if k.len() > best_len {
                best_len = k.len();
                best = Some(v.clone());
            }
        }
    }
    best
}

fn enrich_patch_notes_with_wiki_augments(
    notes: &mut [PatchNoteEntry],
    wiki_catalog_en: &[PatchNoteEntry],
    wiki_catalog_ru: &[PatchNoteEntry],
) {
    if wiki_catalog_en.is_empty() {
        return;
    }
    let map = wiki_augment_lookup_map_merged(wiki_catalog_en, wiki_catalog_ru);
    if map.is_empty() {
        return;
    }

    for note in notes.iter_mut() {
        if note.category != PatchCategory::ModeAramChaos && note.category != PatchCategory::ModeArena {
            continue;
        }
        let nt = normalize_augment_lookup_key(&note.title);
        let Some((img, wiki_text)) = match_wiki_augment_row(&nt, &map) else {
            continue;
        };

        if let Some(u) = img {
            if !u.is_empty() {
                note.image_url = Some(u);
            }
        }

        let wiki_text = wiki_text.trim().to_string();
        if wiki_text.is_empty() {
            continue;
        }

        let dup = note.details.iter().any(|b| b.title.as_deref() == Some(WIKI_AUGMENT_DETAIL_TITLE));
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

pub struct Database {
    pool: SqlitePool,
}

#[derive(Serialize, Deserialize)]
struct PatchJsonContent {
    champions: Vec<ChampionStats>,
    patch_notes: Vec<PatchNoteEntry>,
    #[serde(default)]
    banner_url: Option<String>,
    #[serde(default)]
    patch_notes_locale: Option<String>,
}

fn deserialize_stored_json(data: &str) -> Option<PatchJsonContent> {
    if let Ok(c) = serde_json::from_str::<PatchJsonContent>(data) {
        return Some(c);
    }
    if let Ok(champions) = serde_json::from_str::<Vec<ChampionStats>>(data) {
        return Some(PatchJsonContent {
            champions,
            patch_notes: vec![],
            banner_url: None,
            patch_notes_locale: None,
        });
    }
    None
}

fn patch_data_from_stored_row(
    ver: String,
    data: &str,
    date_str: &str,
    locale: Option<&str>,
) -> Result<PatchData> {
    let content: PatchJsonContent = match serde_json::from_str(data) {
        Ok(c) => c,
        Err(_) => {
            let champions: Vec<ChampionStats> = serde_json::from_str(data).unwrap_or_default();
            PatchJsonContent {
                champions,
                patch_notes: vec![],
                banner_url: None,
                patch_notes_locale: None,
            }
        }
    };
    let date = chrono::DateTime::parse_from_rfc3339(date_str)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    Ok(PatchData {
        version: ver,
        fetched_at: date,
        champions: content.champions,
        patch_notes: content.patch_notes,
        banner_url: content.banner_url,
        patch_notes_locale: content
            .patch_notes_locale
            .or_else(|| locale.map(|s| normalize_patch_locale(s).to_string())),
    })
}

impl Database {
    pub async fn new() -> Result<Self> {
        Self::open(Path::new("patches.db")).await
    }

    pub async fn open(path: &Path) -> Result<Self> {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS patches (
                version TEXT NOT NULL,
                patch_notes_locale TEXT NOT NULL DEFAULT 'ru',
                fetched_at TEXT NOT NULL,
                data_json TEXT NOT NULL,
                PRIMARY KEY (version, patch_notes_locale)
            );
            "#,
        )
        .execute(&pool)
        .await?;

        Self::ensure_patches_schema(&pool).await?;

        sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_patches_fetched_at ON patches (fetched_at DESC);"#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS augments_catalog (
                key TEXT PRIMARY KEY NOT NULL,
                data_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS skin_spotlight_cache (
                cache_key TEXT PRIMARY KEY NOT NULL,
                video_id TEXT NOT NULL,
                video_title TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS game_assets_meta (
                key TEXT PRIMARY KEY NOT NULL,
                ddragon_version TEXT,
                cdragon_synced_at TEXT,
                catalog_built_at TEXT NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS static_catalog (
                kind TEXT NOT NULL,
                stable_id TEXT NOT NULL,
                name_ru TEXT NOT NULL DEFAULT '',
                name_en TEXT NOT NULL DEFAULT '',
                riot_augment_id TEXT,
                cd_meta TEXT,
                icon_sources TEXT NOT NULL DEFAULT '[]',
                source TEXT NOT NULL DEFAULT 'ddragon',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (kind, stable_id)
            );
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_static_kind_name_en ON static_catalog (kind, name_en);"#,
        )
        .execute(&pool)
        .await?;

        Ok(Self { pool })
    }

    async fn ensure_patches_schema(pool: &SqlitePool) -> Result<()> {
        let columns: Vec<String> = sqlx::query_as::<_, (i64, String, String, i64, Option<String>, i64)>(
            "PRAGMA table_info(patches)",
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(_, name, _, _, _, _)| name)
        .collect();
        let has_locale = columns.iter().any(|c| c == "patch_notes_locale");
        let has_id = columns.iter().any(|c| c == "id");
        if has_locale && !has_id {
            return Ok(());
        }

        sqlx::query("DROP TABLE IF EXISTS patches_new")
            .execute(pool)
            .await?;
        sqlx::query("DROP TABLE IF EXISTS patches_legacy")
            .execute(pool)
            .await?;

        sqlx::query(
            r#"
            CREATE TABLE patches_new (
                version TEXT NOT NULL,
                patch_notes_locale TEXT NOT NULL DEFAULT 'ru',
                fetched_at TEXT NOT NULL,
                data_json TEXT NOT NULL,
                PRIMARY KEY (version, patch_notes_locale)
            );
            "#,
        )
        .execute(pool)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO patches_new (version, patch_notes_locale, fetched_at, data_json)
            SELECT
                version,
                COALESCE(
                    NULLIF(json_extract(data_json, '$.patch_notes_locale'), ''),
                    'ru'
                ) AS patch_notes_locale,
                fetched_at,
                data_json
            FROM patches
            "#,
        )
        .execute(pool)
        .await?;

        sqlx::query("ALTER TABLE patches RENAME TO patches_legacy")
            .execute(pool)
            .await?;
        sqlx::query("ALTER TABLE patches_new RENAME TO patches")
            .execute(pool)
            .await?;
        sqlx::query("DROP TABLE patches_legacy")
            .execute(pool)
            .await?;
        Ok(())
    }

    fn prefers_modern_display_patch(version: &str) -> bool {
        version
            .split('.')
            .next()
            .and_then(|m| m.parse::<i32>().ok())
            .map(|major| major >= DISPLAY_MAJOR_MAP_TO_DDRAGON_FROM)
            .unwrap_or(false)
    }

    fn is_better_equivalent_patch_row(
        candidate: &(String, String, String, String),
        current: &(String, String, String, String),
    ) -> bool {
        let candidate_modern = Self::prefers_modern_display_patch(&candidate.0);
        let current_modern = Self::prefers_modern_display_patch(&current.0);
        if candidate_modern != current_modern {
            return candidate_modern;
        }
        if candidate.3 != current.3 {
            return candidate.3 > current.3;
        }
        cmp_display_patch(&candidate.0, &current.0).is_gt()
    }

    /// Строки патчей в порядке **убывания игровой версии** (не по времени загрузки),
    /// с дедупликацией эквивалентных отображений одной версии (например, 16.8 и 26.8).
    async fn fetch_version_ordered_rows(
        &self,
        limit: Option<i64>,
    ) -> Result<Vec<(String, String, String, String)>> {
        let all_rows: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT version, patch_notes_locale, data_json, fetched_at FROM patches",
        )
            .fetch_all(&self.pool)
            .await?;

        let mut by_equivalent: HashMap<(i32, i32), (String, String, String, String)> =
            HashMap::new();
        let mut passthrough = Vec::new();

        for row in all_rows {
            if let Some(key) = display_patch_to_ddragon_major_minor(&row.0) {
                match by_equivalent.get(&key) {
                    Some(existing) => {
                        if Self::is_better_equivalent_patch_row(&row, existing) {
                            by_equivalent.insert(key, row);
                        }
                    }
                    None => {
                        by_equivalent.insert(key, row);
                    }
                }
            } else {
                passthrough.push(row);
            }
        }

        let mut out: Vec<(String, String, String, String)> = by_equivalent.into_values().collect();
        out.extend(passthrough);
        out.sort_by(|a, b| cmp_display_patch(&b.0, &a.0).then_with(|| b.3.cmp(&a.3)));
        if let Some(limit) = limit {
            if limit > 0 && (out.len() as i64) > limit {
                out.truncate(limit as usize);
            }
        }
        Ok(out)
    }

    pub async fn clear_database(&self) -> Result<()> {
        sqlx::query("DELETE FROM patches").execute(&self.pool).await?;
        sqlx::query("DELETE FROM skin_spotlight_cache")
            .execute(&self.pool)
            .await?;
        sqlx::query("VACUUM").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn clear_all_cached_data(&self) -> Result<()> {
        sqlx::query("DELETE FROM patches").execute(&self.pool).await?;
        sqlx::query("DELETE FROM skin_spotlight_cache")
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM static_catalog")
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM augments_catalog")
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM game_assets_meta")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_cached_patch_locales(&self) -> Result<Vec<String>> {
        let mut locales: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT patch_notes_locale FROM patches ORDER BY patch_notes_locale ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        locales.retain(|l| !l.trim().is_empty());
        Ok(locales)
    }

    pub async fn get_game_assets_meta(&self) -> Result<Option<GameAssetsMeta>> {
        let row: Option<(Option<String>, Option<String>, String)> = sqlx::query_as(
            "SELECT ddragon_version, cdragon_synced_at, catalog_built_at FROM game_assets_meta WHERE key = 'default'",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(ddragon_version, cdragon_synced_at, catalog_built_at)| GameAssetsMeta {
            ddragon_version,
            cdragon_synced_at,
            catalog_built_at,
        }))
    }

    pub async fn set_game_assets_meta(
        &self,
        ddragon_version: Option<&str>,
        cdragon_synced_at: Option<&str>,
    ) -> Result<()> {
        let catalog_built_at = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO game_assets_meta (key, ddragon_version, cdragon_synced_at, catalog_built_at)
            VALUES ('default', ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                ddragon_version = excluded.ddragon_version,
                cdragon_synced_at = excluded.cdragon_synced_at,
                catalog_built_at = excluded.catalog_built_at
            "#,
        )
        .bind(ddragon_version)
        .bind(cdragon_synced_at)
        .bind(&catalog_built_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_seed_game_assets_meta(&self, ddragon_version: &str) -> Result<()> {
        sqlx::query(
            r#"
            INSERT OR IGNORE INTO game_assets_meta (key, ddragon_version, cdragon_synced_at, catalog_built_at)
            VALUES ('default', ?, NULL, ?)
            "#,
        )
        .bind(ddragon_version)
        .bind("1970-01-01T00:00:00+00:00")
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn clear_static_catalog(&self) -> Result<()> {
        sqlx::query("DELETE FROM static_catalog")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn upsert_static_rows(&self, rows: &[StaticCatalogRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let updated = chrono::Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await?;
        for r in rows {
            let icon_json = serde_json::to_string(&r.icon_sources)?;
            let cd = r
                .cd_meta
                .as_ref()
                .map(|v| serde_json::to_string(v))
                .transpose()?;
            sqlx::query(
                r#"
                INSERT INTO static_catalog (
                    kind, stable_id, name_ru, name_en, riot_augment_id, cd_meta, icon_sources, source, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind, stable_id) DO UPDATE SET
                    name_ru = excluded.name_ru,
                    name_en = excluded.name_en,
                    riot_augment_id = excluded.riot_augment_id,
                    cd_meta = excluded.cd_meta,
                    icon_sources = excluded.icon_sources,
                    source = excluded.source,
                    updated_at = excluded.updated_at
                "#,
            )
            .bind(&r.kind)
            .bind(&r.stable_id)
            .bind(&r.name_ru)
            .bind(&r.name_en)
            .bind(&r.riot_augment_id)
            .bind(cd)
            .bind(&icon_json)
            .bind(&r.source)
            .bind(&updated)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn get_static_catalog_kind(&self, kind: &str) -> Result<Vec<StaticCatalogRow>> {
        let rows: Vec<(
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
        )> = sqlx::query_as(
            "SELECT kind, stable_id, name_ru, name_en, riot_augment_id, cd_meta, icon_sources, source FROM static_catalog WHERE kind = ?",
        )
        .bind(kind)
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for (kind, stable_id, name_ru, name_en, riot_augment_id, cd_meta, icon_sources, source) in
            rows
        {
            let icon_sources: Vec<IconSourceEntry> = serde_json::from_str(&icon_sources)?;
            let cd_meta = cd_meta
                .map(|s| serde_json::from_str(&s))
                .transpose()?;
            out.push(StaticCatalogRow {
                kind,
                stable_id,
                name_ru,
                name_en,
                riot_augment_id,
                cd_meta,
                icon_sources,
                source,
            });
        }
        Ok(out)
    }

    pub async fn filter_static_catalog_items_by_maps(
        &self,
        map_ids: &[u32],
    ) -> Result<Vec<StaticCatalogRow>> {
        let items = self.get_static_catalog_kind("item").await?;
        Ok(items
            .into_iter()
            .filter(|r| {
                r.cd_meta
                    .as_ref()
                    .map(|m| cd_meta_allows_maps(m, map_ids))
                    .unwrap_or(true)
            })
            .collect())
    }

    pub async fn static_catalog_count(&self) -> Result<i64> {
        let c: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM static_catalog")
            .fetch_one(&self.pool)
            .await?;
        Ok(c.0)
    }

    pub async fn get_skin_spotlight_cached(
        &self,
        cache_key: &str,
    ) -> Result<Option<(String, String)>, anyhow::Error> {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT video_id, video_title FROM skin_spotlight_cache WHERE cache_key = ?",
        )
        .bind(cache_key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn save_skin_spotlight_cached(
        &self,
        cache_key: &str,
        video_id: &str,
        video_title: &str,
    ) -> Result<(), anyhow::Error> {
        let updated = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO skin_spotlight_cache (cache_key, video_id, video_title, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                video_id = excluded.video_id,
                video_title = excluded.video_title,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(cache_key)
        .bind(video_id)
        .bind(video_title)
        .bind(updated)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_augments_catalog(
        &self,
        key: &str,
    ) -> Result<Option<(Vec<PatchNoteEntry>, chrono::DateTime<chrono::Utc>)>> {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT data_json, fetched_at FROM augments_catalog WHERE key = ?",
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((json, date_str)) = row {
            let entries: Vec<PatchNoteEntry> = serde_json::from_str(&json)?;
            let date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());
            return Ok(Some((entries, date)));
        }
        Ok(None)
    }

    pub async fn save_augments_catalog(&self, key: &str, entries: &[PatchNoteEntry]) -> Result<()> {
        let json = serde_json::to_string(entries)?;
        let date_str = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO augments_catalog (key, data_json, fetched_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                data_json = excluded.data_json,
                fetched_at = excluded.fetched_at
            "#,
        )
        .bind(key)
        .bind(json)
        .bind(date_str)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn save_mayhem_augmentations_page(
        &self,
        key: &str,
        entries: &[MayhemAugmentation],
    ) -> Result<()> {
        let json = serde_json::to_string(entries)?;
        let date_str = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO augments_catalog (key, data_json, fetched_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                data_json = excluded.data_json,
                fetched_at = excluded.fetched_at
            "#,
        )
        .bind(key)
        .bind(json)
        .bind(date_str)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_mayhem_augmentations_page(
        &self,
        key: &str,
    ) -> Result<Option<(Vec<MayhemAugmentation>, chrono::DateTime<chrono::Utc>)>> {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT data_json, fetched_at FROM augments_catalog WHERE key = ?",
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((json, date_str)) = row {
            let entries: Vec<MayhemAugmentation> = serde_json::from_str(&json)?;
            let date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());
            return Ok(Some((entries, date)));
        }
        Ok(None)
    }

    pub async fn patch_with_wiki_augment_enrichment(&self, mut patch: PatchData) -> Result<PatchData> {
        patch
            .patch_notes
            .retain(|n| n.category != PatchCategory::ModeAramAugments);
        let augments = self
            .get_static_catalog_kind("augment")
            .await
            .unwrap_or_default();
        let use_bundle = crate::wiki_augment_bundle::bundled_augment_data()
            .map(|b| !b.arena.is_empty() || !b.mayhem.is_empty())
            .unwrap_or(false);
        if use_bundle {
            crate::wiki_augment_bundle::enrich_patch_notes_from_bundle(
                &mut patch.patch_notes,
                &augments,
            );
        } else if let Some((entries_en, _)) = self
            .get_augments_catalog(AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_EN)
            .await?
        {
            let entries_ru = self
                .get_augments_catalog(AUGMENTS_CATALOG_KEY_ARAM_MAYHEM_RU)
                .await?
                .map(|(e, _)| e)
                .unwrap_or_default();
            enrich_patch_notes_with_wiki_augments(&mut patch.patch_notes, &entries_en, &entries_ru);
        }
        let _ = crate::patch_icons::enrich_patch_data_icons(self, &mut patch).await;
        Ok(patch)
    }

    pub async fn save_patch(&self, patch: &PatchData) -> Result<()> {
        let locale = normalize_patch_locale(patch.patch_notes_locale.as_deref().unwrap_or("ru"));
        let patch_notes: Vec<PatchNoteEntry> = patch
            .patch_notes
            .iter()
            .filter(|n| n.category != PatchCategory::ModeAramAugments)
            .cloned()
            .collect();
        let content = PatchJsonContent {
            champions: patch.champions.clone(),
            patch_notes,
            banner_url: patch.banner_url.clone(),
            patch_notes_locale: patch.patch_notes_locale.clone(),
        };
        let json_data = serde_json::to_string(&content)?;
        let date_str = patch.fetched_at.to_rfc3339();

        sqlx::query(
            r#"
            INSERT INTO patches (version, patch_notes_locale, fetched_at, data_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(version, patch_notes_locale) DO UPDATE SET
                fetched_at = excluded.fetched_at,
                data_json = excluded.data_json
            "#,
        )
        .bind(&patch.version)
        .bind(locale)
        .bind(date_str)
        .bind(json_data)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn get_patch_for_locale(&self, version: &str, locale: &str) -> Result<Option<PatchData>> {
        let locale = normalize_patch_locale(locale);
        let row: Option<(String, String, String, String)> = sqlx::query_as(
            "SELECT version, patch_notes_locale, data_json, fetched_at FROM patches WHERE version = ? AND patch_notes_locale = ?",
        )
        .bind(version)
        .bind(locale)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((ver, loc, data, date_str)) = row {
            return Ok(Some(patch_data_from_stored_row(
                ver,
                &data,
                &date_str,
                Some(&loc),
            )?));
        }
        Ok(None)
    }

    pub async fn get_patch(&self, version: &str) -> Result<Option<PatchData>> {
        let row: Option<(String, String, String, String)> = sqlx::query_as(
            r#"
            SELECT version, patch_notes_locale, data_json, fetched_at
            FROM patches
            WHERE version = ?
            ORDER BY CASE patch_notes_locale WHEN 'ru' THEN 0 WHEN 'en' THEN 1 ELSE 2 END, fetched_at DESC
            LIMIT 1
            "#,
        )
        .bind(version)
        .fetch_optional(&self.pool)
        .await?;
        if let Some((ver, loc, data, date_str)) = row {
            return Ok(Some(patch_data_from_stored_row(
                ver,
                &data,
                &date_str,
                Some(&loc),
            )?));
        }
        Ok(None)
    }

    pub async fn patch_exists_resolving(&self, version: &str) -> Result<bool> {
        if self.get_patch(version).await?.is_some() {
            return Ok(true);
        }
        let all: Vec<String> = sqlx::query_scalar("SELECT DISTINCT version FROM patches")
            .fetch_all(&self.pool)
            .await?;
        Ok(all.iter().any(|v| versions_match(v, version)))
    }

    pub async fn patch_exists_resolving_with_locale(&self, version: &str, locale: &str) -> Result<bool> {
        Ok(self
            .get_patch_resolving_with_locale(version, locale)
            .await?
            .is_some())
    }

    pub async fn get_patch_resolving(&self, version: &str) -> Result<Option<PatchData>> {
        if let Some(p) = self.get_patch(version).await? {
            return Ok(Some(p));
        }
        let all: Vec<String> = sqlx::query_scalar("SELECT DISTINCT version FROM patches")
            .fetch_all(&self.pool)
            .await?;
        for v in &all {
            if versions_match(v, version) {
                let mut p = match self.get_patch(v).await? {
                    Some(p) => p,
                    None => continue,
                };
                p.version = version.to_string();
                return Ok(Some(p));
            }
        }
        Ok(None)
    }

    pub async fn get_patch_resolving_with_locale(
        &self,
        version: &str,
        locale: &str,
    ) -> Result<Option<PatchData>> {
        let locale = normalize_patch_locale(locale);
        if let Some(p) = self.get_patch_for_locale(version, locale).await? {
            return Ok(Some(p));
        }
        let all: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT version FROM patches WHERE patch_notes_locale = ?",
        )
        .bind(locale)
        .fetch_all(&self.pool)
        .await?;
        for v in &all {
            if versions_match(v, version) {
                let mut p = match self.get_patch_for_locale(v, locale).await? {
                    Some(p) => p,
                    None => continue,
                };
                p.version = version.to_string();
                return Ok(Some(p));
            }
        }
        Ok(None)
    }

    /// Все версии из кэша, от новой к старой (тот же порядок, что и у `get_patches_newest_versions_first`).
    pub async fn list_cached_patch_versions(&self) -> Result<Vec<String>> {
        let all_versions: Vec<String> = sqlx::query_scalar("SELECT DISTINCT version FROM patches")
            .fetch_all(&self.pool)
            .await?;
        let mut vers: Vec<String> = HashSet::<String>::from_iter(all_versions.into_iter())
            .into_iter()
            .collect();
        vers.sort_by(|a, b| cmp_display_patch(b, a));
        Ok(vers)
    }

    /// Последние `limit` патчей по **номеру версии** (самый новый игровой патч первым).
    pub async fn get_patches_newest_versions_first(&self, limit: i64) -> Result<Vec<PatchData>> {
        let rows = self.fetch_version_ordered_rows(Some(limit)).await?;
        let mut result = Vec::with_capacity(rows.len());
        for (ver, loc, data, date_str) in rows {
            result.push(patch_data_from_stored_row(ver, &data, &date_str, Some(&loc))?);
        }
        Ok(result)
    }

    pub async fn get_recent_patches(&self, limit: i64) -> Result<Vec<PatchData>> {
        self.get_patches_newest_versions_first(limit).await
    }

    fn collect_note_history<F>(
        rows: Vec<(String, String, String, String)>,
        filter: F,
    ) -> Result<Vec<ChampionHistoryEntry>>
    where
        F: Fn(&PatchNoteEntry, &str) -> bool,
    {
        let mut history = Vec::new();
        for (ver, _loc, data, date_str) in rows {
            let content = match deserialize_stored_json(&data) {
                Some(c) => c,
                None => continue,
            };
            let date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());

            for note in content.patch_notes {
                if filter(&note, &ver) {
                    history.push(ChampionHistoryEntry {
                        patch_version: ver.clone(),
                        date,
                        change: note,
                    });
                }
            }
        }
        history.sort_by(|a, b| a.date.cmp(&b.date));
        Ok(history)
    }

    async fn get_history_for_category(
        &self,
        name: &str,
        category: PatchCategory,
    ) -> Result<Vec<ChampionHistoryEntry>> {
        let rows = self.fetch_version_ordered_rows(None).await?;
        let search = name.to_lowercase();
        Self::collect_note_history(rows, move |note, _ver| {
            note.category == category
                && (note.id.to_lowercase() == search || note.title.to_lowercase() == search)
        })
    }

    pub async fn get_champion_history(&self, champion_name: &str) -> Result<Vec<ChampionHistoryEntry>> {
        self.get_history_for_category(champion_name, PatchCategory::Champions)
            .await
    }

    pub async fn get_item_history(&self, item_name: &str) -> Result<Vec<ChampionHistoryEntry>> {
        let rows = self.fetch_version_ordered_rows(None).await?;
        let search = item_name.to_lowercase();
        Self::collect_note_history(rows, move |note, _ver| {
            (note.category == PatchCategory::Items || note.category == PatchCategory::ItemsRunes)
                && (note.id.to_lowercase() == search || note.title.to_lowercase() == search)
        })
    }

    pub async fn get_rune_history(&self, rune_name: &str) -> Result<Vec<ChampionHistoryEntry>> {
        let rows = self.fetch_version_ordered_rows(None).await?;
        let search = rune_name.to_lowercase();
        Self::collect_note_history(rows, move |note, _ver| {
            (note.category == PatchCategory::Runes || note.category == PatchCategory::ItemsRunes)
                && (note.id.to_lowercase() == search || note.title.to_lowercase() == search)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ChangeType;

    #[test]
    fn enrich_aram_note_with_wiki_icon_and_description() {
        let wiki = vec![PatchNoteEntry {
            id: "w1".into(),
            title: "Fan the Hammer".into(),
            image_url: Some("https://wiki.example/fth.png".into()),
            category: PatchCategory::ModeAramAugments,
            change_type: ChangeType::None,
            summary: "Gold · Set 1".into(),
            details: vec![ChangeBlock {
                title: None,
                icon_url: None,
                changes: vec!["Full wiki effect text.".into()],
            }],
            icon_candidates: None,
        }];
        let mut notes = vec![PatchNoteEntry {
            id: "n1".into(),
            title: "Fan the Hammer".into(),
            image_url: None,
            category: PatchCategory::ModeAramChaos,
            change_type: ChangeType::Nerf,
            summary: String::new(),
            details: vec![ChangeBlock {
                title: None,
                icon_url: None,
                changes: vec!["Damage 10 ⇒ 8".into()],
            }],
            icon_candidates: None,
        }];
        enrich_patch_notes_with_wiki_augments(&mut notes, &wiki, &[]);
        assert_eq!(
            notes[0].image_url.as_deref(),
            Some("https://wiki.example/fth.png")
        );
        assert_eq!(notes[0].details.len(), 2);
        assert_eq!(notes[0].details[0].title.as_deref(), Some(WIKI_AUGMENT_DETAIL_TITLE));
        assert_eq!(
            notes[0].details[0].icon_url.as_deref(),
            Some("https://wiki.example/fth.png")
        );
        assert!(notes[0].details[0].changes[0].contains("Full wiki"));
        assert!(notes[0].details[1].changes[0].contains("Damage"));
    }

    #[test]
    fn augment_row_matches_icon_url_query_and_filename() {
        use crate::models::{IconSourceEntry, StaticCatalogRow};
        let row = StaticCatalogRow {
            kind: "augment".into(),
            stable_id: "1_arena".into(),
            name_ru: "Can't Touch This".into(),
            name_en: "Can't Touch This".into(),
            riot_augment_id: None,
            cd_meta: None,
            icon_sources: vec![IconSourceEntry {
                t: "cdragon".into(),
                url: Some(
                    "https://raw.communitydragon.org/p/CantTouchThis_small.png".into(),
                ),
            }],
            source: "cdragon".into(),
        };
        assert!(augment_row_matches_icon_url(
            &row,
            "https://raw.communitydragon.org/p/CantTouchThis_small.png?v=1",
        ));
        assert!(augment_row_matches_icon_url(
            &row,
            "https://cdn.example/x/CantTouchThis_small.png",
        ));
        assert!(!augment_row_matches_icon_url(
            &row,
            "https://raw.communitydragon.org/p/Other_small.png",
        ));
        let item = StaticCatalogRow {
            kind: "item".into(),
            ..row.clone()
        };
        assert!(!augment_row_matches_icon_url(&item, "https://raw.communitydragon.org/p/CantTouchThis_small.png"));
    }
}
