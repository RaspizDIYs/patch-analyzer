use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PatchData {
    pub version: String,
    pub fetched_at: DateTime<Utc>,
    pub champions: Vec<ChampionStats>,
    pub patch_notes: Vec<PatchNoteEntry>,
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
    Fix,
    None,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Hash)]
pub enum PatchCategory {
    Champions,
    ItemsRunes,
    Modes,
    Skins,
    Systems,
    BugFixes,
    NewContent,
    Cosmetics,
    Unknown,
}

#[derive(Debug, Serialize, Clone)]
pub struct MetaAnalysisDiff {
    pub champion_name: String,
    pub role: LaneRole,
    pub win_rate_diff: f64,
    pub pick_rate_diff: f64,
    pub predicted_change: Option<ChangeType>,
    pub champion_image_url: Option<String>,
}
