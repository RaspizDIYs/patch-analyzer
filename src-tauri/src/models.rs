use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PatchData {
    pub version: String,
    pub fetched_at: DateTime<Utc>,
    pub champions: Vec<ChampionStats>,
    pub patch_notes: Vec<PatchNoteEntry>, // Данные с Riot сайта
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChampionStats {
    pub id: String, // Используем String имя как ID для простоты (или ключ с op.gg)
    pub name: String,
    pub tier: String,
    pub role: LaneRole,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub ban_rate: f64,
    
    // Детальные данные (парсятся со страницы чемпиона)
    pub core_items: Vec<ItemStat>,
    pub popular_runes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ItemStat {
    pub name: String,
    pub win_rate: f64,
    pub pick_rate: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PatchNoteEntry {
    pub champion_name: String,
    pub summary: String, // "Усиление Q, Ослабление R"
    pub details: Vec<String>, // ["Q: Урон 50 -> 60", "R: КД 100 -> 120"]
    pub change_type: ChangeType, // Buff, Nerf, Adjusted
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum ChangeType {
    Buff,
    Nerf,
    Adjusted,
    New,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct MetaAnalysisDiff {
    pub champion_name: String,
    pub role: LaneRole,
    pub win_rate_diff: f64,
    pub pick_rate_diff: f64,
    // Прогноз
    pub predicted_change: Option<ChangeType>, 
}
