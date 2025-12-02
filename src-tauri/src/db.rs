use sqlx::{migrate::MigrateDatabase, Sqlite, SqlitePool};
use anyhow::Result;
use crate::models::{ChampionStats, PatchData, PatchNoteEntry};
use serde::{Serialize, Deserialize};
use serde_json;

const DB_URL: &str = "sqlite://patches.db";

pub struct Database {
    pool: SqlitePool,
}

#[derive(Serialize, Deserialize)]
struct PatchJsonContent {
    champions: Vec<ChampionStats>,
    patch_notes: Vec<PatchNoteEntry>,
}

impl Database {
    pub async fn new() -> Result<Self> {
        if !Sqlite::database_exists(DB_URL).await.unwrap_or(false) {
            Sqlite::create_database(DB_URL).await?;
        }
        
        let pool = SqlitePool::connect(DB_URL).await?;
        
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS patches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version TEXT NOT NULL UNIQUE,
                fetched_at TEXT NOT NULL,
                data_json TEXT NOT NULL
            );
            "#
        ).execute(&pool).await?;

        Ok(Self { pool })
    }

    pub async fn clear_database(&self) -> Result<()> {
        sqlx::query("DELETE FROM patches").execute(&self.pool).await?;
        sqlx::query("VACUUM").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn save_patch(&self, patch: &PatchData) -> Result<()> {
        let content = PatchJsonContent {
            champions: patch.champions.clone(),
            patch_notes: patch.patch_notes.clone(),
        };
        let json_data = serde_json::to_string(&content)?;
        
        let date_str = patch.fetched_at.to_rfc3339();
        
        sqlx::query(
            r#"
            INSERT INTO patches (version, fetched_at, data_json)
            VALUES (?, ?, ?)
            ON CONFLICT(version) DO UPDATE SET
                fetched_at = excluded.fetched_at,
                data_json = excluded.data_json
            "#
        )
        .bind(&patch.version)
        .bind(date_str)
        .bind(json_data)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn get_patch(&self, version: &str) -> Result<Option<PatchData>> {
        let row: Option<(String, String, String)> = sqlx::query_as(
            "SELECT version, data_json, fetched_at FROM patches WHERE version = ?"
        )
        .bind(version)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((ver, data, date_str)) = row {
            let content: PatchJsonContent = match serde_json::from_str(&data) {
                Ok(c) => c,
                Err(_) => {
                    let champions: Vec<ChampionStats> = serde_json::from_str(&data)?;
                    PatchJsonContent {
                        champions,
                        patch_notes: vec![],
                    }
                }
            };

            let date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());

            Ok(Some(PatchData {
                version: ver,
                fetched_at: date,
                champions: content.champions,
                patch_notes: content.patch_notes,
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn get_recent_patches(&self, limit: i64) -> Result<Vec<PatchData>> {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT version, data_json, fetched_at FROM patches ORDER BY fetched_at DESC LIMIT ?"
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut result = Vec::new();
        for (ver, data, date_str) in rows {
            let content: PatchJsonContent = match serde_json::from_str(&data) {
                Ok(c) => c,
                Err(_) => {
                    let champions: Vec<ChampionStats> = serde_json::from_str(&data).unwrap_or_default();
                    PatchJsonContent {
                        champions,
                        patch_notes: vec![],
                    }
                }
            };

            let date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());

            result.push(PatchData {
                version: ver,
                fetched_at: date,
                champions: content.champions,
                patch_notes: content.patch_notes,
            });
        }
        Ok(result)
    }

    async fn get_history_for_category(
        &self,
        name: &str,
        category: crate::models::PatchCategory,
    ) -> Result<Vec<crate::ChampionHistoryEntry>> {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT version, data_json, fetched_at FROM patches ORDER BY fetched_at DESC LIMIT 20",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut history = Vec::new();
        let search = name.to_lowercase();

        for (ver, data, date_str) in rows {
            let content: PatchJsonContent = match serde_json::from_str(&data) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());

            for note in content.patch_notes {
                if note.category == category
                    && (note.id.to_lowercase() == search || note.title.to_lowercase() == search)
                {
                    history.push(crate::ChampionHistoryEntry {
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

    pub async fn get_champion_history(&self, champion_name: &str) -> Result<Vec<crate::ChampionHistoryEntry>> {
        self
            .get_history_for_category(champion_name, crate::models::PatchCategory::Champions)
            .await
    }

    pub async fn get_item_history(&self, item_name: &str) -> Result<Vec<crate::ChampionHistoryEntry>> {
        let mut history = Vec::new();
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT version, data_json, fetched_at FROM patches ORDER BY fetched_at DESC LIMIT 20",
        )
        .fetch_all(&self.pool)
        .await?;

        let search = item_name.to_lowercase();
        for (ver, data, date_str) in rows {
            let content: PatchJsonContent = match serde_json::from_str(&data) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());

            for note in content.patch_notes {
                if (note.category == crate::models::PatchCategory::Items || note.category == crate::models::PatchCategory::ItemsRunes)
                    && (note.id.to_lowercase() == search || note.title.to_lowercase() == search)
                {
                    history.push(crate::ChampionHistoryEntry {
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

    pub async fn get_rune_history(&self, rune_name: &str) -> Result<Vec<crate::ChampionHistoryEntry>> {
        let mut history = Vec::new();
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT version, data_json, fetched_at FROM patches ORDER BY fetched_at DESC LIMIT 20",
        )
        .fetch_all(&self.pool)
        .await?;

        let search = rune_name.to_lowercase();
        for (ver, data, date_str) in rows {
            let content: PatchJsonContent = match serde_json::from_str(&data) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());

            for note in content.patch_notes {
                if (note.category == crate::models::PatchCategory::Runes || note.category == crate::models::PatchCategory::ItemsRunes)
                    && (note.id.to_lowercase() == search || note.title.to_lowercase() == search)
                {
                    history.push(crate::ChampionHistoryEntry {
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
}
