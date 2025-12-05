use serde::{Deserialize, Serialize};
use reqwest::Client;
use anyhow::Result;
use std::collections::HashMap;

const SUPABASE_URL: &str = env!("SUPABASE_URL");
const SUPABASE_KEY: &str = env!("SUPABASE_KEY");

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SupabaseChampionStatsRaw {
    pub id: i64,
    pub champion_id: String,
    pub patch_version: String,
    pub region: String,
    pub tier: String,
    pub role: Option<String>,
    pub win_rate: Option<f64>,
    pub pick_rate: Option<f64>,
    pub ban_rate: Option<f64>,
    pub total_matches: Option<i32>,
}

#[derive(Clone)]
pub struct SupabaseClient {
    client: Client,
}

impl SupabaseClient {
    pub fn new() -> Self {
        let client = Client::new();
        Self { client }
    }

    pub async fn get_champion_stats(&self, patch: &str) -> Result<Vec<SupabaseChampionStatsRaw>> {
        let url = format!("{}/rest/v1/champion_stats_aggregated?patch_version=eq.{}&select=*&order=win_rate.desc", SUPABASE_URL, patch);
        
        let resp = self.client
            .get(&url)
            .header("apikey", SUPABASE_KEY)
            .header("Authorization", format!("Bearer {}", SUPABASE_KEY))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("Supabase request failed: {}", resp.status()));
        }

        let stats: Vec<SupabaseChampionStatsRaw> = resp.json().await?;
        Ok(stats)
    }

    pub async fn get_available_patches_stats(&self) -> Result<Vec<String>> {
        let url = format!("{}/rest/v1/rpc/get_stats_patches", SUPABASE_URL);
        
        let resp = self.client
            .post(&url)
            .header("apikey", SUPABASE_KEY)
            .header("Authorization", format!("Bearer {}", SUPABASE_KEY))
            .send()
            .await?;

        if !resp.status().is_success() {
            // Fallback for old method if RPC fails or not exists (though we just created it)
            // But better to return error to debug
            return Err(anyhow::anyhow!("Supabase RPC request failed: {}", resp.status()));
        }

        let patches: Vec<String> = resp.json().await?;
        Ok(patches)
    }
}

