use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PatchData {
    pub version: String,
    pub fetched_at: DateTime<Utc>,
    pub champions: Vec<ChampionStats>,
    pub patch_notes: Vec<PatchNoteEntry>,
    #[serde(default)]
    pub banner_url: Option<String>,
    /// "ru" | "en" — с какого региона Riot взяты patch_notes
    #[serde(default)]
    pub patch_notes_locale: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChampionStats {
    pub id: String,
    pub name: String,
    pub tier: String,
    pub role: LaneRole,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub ban_rate: f64,
    pub image_url: Option<String>,
    pub core_items: Vec<ItemStat>,
    pub popular_runes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ItemStat {
    pub name: String,
    pub image_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PatchNoteEntry {
    pub id: String,
    pub title: String,
    pub image_url: Option<String>,
    pub category: PatchCategory,
    pub change_type: ChangeType,
    pub summary: String,
    pub details: Vec<ChangeBlock>, // Renamed/Changed from Vec<String>
    /// Приоритетные URL иконок из static_catalog (DDragon / CD / вики); заполняется при отдаче патча.
    #[serde(default)]
    pub icon_candidates: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangeBlock {
    pub title: Option<String>, // Ability name or "Base Stats"
    pub icon_url: Option<String>,
    pub changes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Hash)]
pub enum LaneRole {
    Top,
    Jungle,
    Mid,
    Adc,
    Support,
    Unknown,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum ChangeType {
    Buff,
    Nerf,
    Adjusted,
    New,
    Removed,
    Fix,
    None,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MetaAnalysisDiff {
    pub champion_name: String,
    pub role: String,
    pub win_rate_diff: f64,
    pub pick_rate_diff: f64,
    pub predicted_change: Option<String>,
    pub champion_image_url: Option<String>,
}

/// Полная строка таблицы ARAM: Mayhem / Augments (League Wiki).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MayhemAugmentation {
    pub id: String,
    pub title: String,
    pub icon_url: Option<String>,
    /// HTML фрагмент ячейки Effect (ссылки на wiki, иконки в тексте).
    pub effect_html: String,
    pub tier: String,
    pub set_label: String,
    pub set_icon_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IconSourceEntry {
    pub t: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GameAssetsMeta {
    pub ddragon_version: Option<String>,
    pub cdragon_synced_at: Option<String>,
    pub catalog_built_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StaticCatalogRow {
    pub kind: String,
    pub stable_id: String,
    pub name_ru: String,
    pub name_en: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub riot_augment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cd_meta: Option<serde_json::Value>,
    pub icon_sources: Vec<IconSourceEntry>,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Hash)]
pub enum PatchCategory {
    Champions,
    Items,
    Runes,
    ItemsRunes, // Legacy для обратной совместимости
    ModeAramChaos,
    ModeAramAugments,
    ModeAram,
    ModeArena,
    Modes,
    Skins,
    Systems,
    BugFixes,
    NewContent,
    Cosmetics,
    UpcomingSkinsChromas,
    Unknown,
}

