use reqwest::Client;
use serde::{Deserialize, Serialize};
use anyhow::Result;

pub struct SupabaseClient {
    client: Client,
    base_url: String,
    anon_key: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChampionStatsAggregated {
    pub champion_id: String,
    pub patch_version: String,
    pub region: String,
    pub tier: String,
    pub role: Option<String>,
    pub total_matches: i32,
    pub wins: i32,
    pub losses: i32,
    pub bans: i32,
    pub picks: i32,
    pub win_rate: Option<f64>,
    pub pick_rate: Option<f64>,
    pub ban_rate: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MetaChange {
    pub champion_id: String,
    pub win_rate_diff: f64,
    pub pick_rate_diff: f64,
    pub ban_rate_diff: f64,
}

impl SupabaseClient {
    pub fn new(base_url: String, anon_key: String) -> Self {
        Self {
            client: Client::new(),
            base_url,
            anon_key,
        }
    }

    pub async fn get_champion_stats(
        &self,
        champion_id: &str,
        patch: &str,
        region: &str,
        tier: Option<&str>,
        role: Option<&str>,
    ) -> Result<Vec<ChampionStatsAggregated>> {
        let mut url = format!(
            "{}/rest/v1/champion_stats_aggregated?champion_id=eq.{}&patch_version=eq.{}&region=eq.{}",
            self.base_url, champion_id, patch, region
        );

        if let Some(t) = tier {
            url.push_str(&format!("&tier=eq.{}", t));
        }

        if let Some(r) = role {
            url.push_str(&format!("&role=eq.{}", r));
        } else {
            url.push_str("&role=is.null");
        }

        let response = self
            .client
            .get(&url)
            .header("apikey", &self.anon_key)
            .header("Authorization", format!("Bearer {}", &self.anon_key))
            .header("Content-Type", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("Failed to get champion stats: {}", response.status());
        }

        let stats: Vec<ChampionStatsAggregated> = response.json().await?;
        Ok(stats)
    }

    pub async fn get_meta_changes(
        &self,
        from_patch: &str,
        to_patch: &str,
        region: &str,
        tier: Option<&str>,
    ) -> Result<Vec<MetaChange>> {
        // Получить статистику для обоих патчей
        let from_stats = self.get_patch_stats(from_patch, region, tier).await?;
        let to_stats = self.get_patch_stats(to_patch, region, tier).await?;

        eprintln!("From patch {}: {} stats", from_patch, from_stats.len());
        eprintln!("To patch {}: {} stats", to_patch, to_stats.len());

        // Вычислить изменения
        let mut changes = Vec::new();
        
        // Если нет статистики для предыдущего патча, используем только текущий патч
        if from_stats.is_empty() {
            eprintln!("No stats for patch {}, using only current patch stats", from_patch);
            for to_stat in &to_stats {
                changes.push(MetaChange {
                    champion_id: to_stat.champion_id.clone(),
                    win_rate_diff: 0.0,
                    pick_rate_diff: 0.0,
                    ban_rate_diff: 0.0,
                });
            }
        } else {
            for to_stat in &to_stats {
                if let Some(from_stat) = from_stats
                    .iter()
                    .find(|s| s.champion_id == to_stat.champion_id && s.role == to_stat.role)
                {
                    let win_diff = to_stat.win_rate.unwrap_or(0.0) - from_stat.win_rate.unwrap_or(0.0);
                    let pick_diff = to_stat.pick_rate.unwrap_or(0.0) - from_stat.pick_rate.unwrap_or(0.0);
                    let ban_diff = to_stat.ban_rate.unwrap_or(0.0) - from_stat.ban_rate.unwrap_or(0.0);
                    
                    eprintln!("Champion {}: win_diff={}, pick_diff={}, ban_diff={}", 
                        to_stat.champion_id, win_diff, pick_diff, ban_diff);
                    
                    changes.push(MetaChange {
                        champion_id: to_stat.champion_id.clone(),
                        win_rate_diff: win_diff,
                        pick_rate_diff: pick_diff,
                        ban_rate_diff: ban_diff,
                    });
                } else {
                    // Если нет данных для предыдущего патча, все равно добавляем с нулевыми diff
                    changes.push(MetaChange {
                        champion_id: to_stat.champion_id.clone(),
                        win_rate_diff: 0.0,
                        pick_rate_diff: 0.0,
                        ban_rate_diff: 0.0,
                    });
                }
            }
        }

        eprintln!("Total changes: {}", changes.len());
        Ok(changes)
    }

    async fn get_patch_stats(
        &self,
        patch: &str,
        region: &str,
        tier: Option<&str>,
    ) -> Result<Vec<ChampionStatsAggregated>> {
        let mut url = format!(
            "{}/rest/v1/champion_stats_aggregated?patch_version=eq.{}&region=eq.{}&role=is.null",
            self.base_url, patch, region
        );

        if let Some(t) = tier {
            url.push_str(&format!("&tier=eq.{}", t));
        } else {
            url.push_str("&tier=eq.DIAMOND_PLUS");
        }

        let response = self
            .client
            .get(&url)
            .header("apikey", &self.anon_key)
            .header("Authorization", format!("Bearer {}", &self.anon_key))
            .header("Content-Type", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("Failed to get patch stats: {}", response.status());
        }

        let stats: Vec<ChampionStatsAggregated> = response.json().await?;
        Ok(stats)
    }

    pub async fn check_status(&self) -> Result<bool> {
        // Простая проверка доступности API через запрос к таблице champion_stats_aggregated
        let url = format!("{}/rest/v1/champion_stats_aggregated?limit=1", self.base_url);
        
        let response = self
            .client
            .get(&url)
            .header("apikey", &self.anon_key)
            .header("Authorization", format!("Bearer {}", &self.anon_key))
            .header("Content-Type", "application/json")
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;

        match response {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }
}

