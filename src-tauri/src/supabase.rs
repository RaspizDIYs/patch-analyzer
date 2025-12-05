use serde::{Deserialize, Serialize};
use reqwest::Client;
use anyhow::Result;
use std::time::Duration;

const DEFAULT_SUPABASE_URL: &str = "https://pnrixpwwjasjizuamuwu.supabase.co";
const COMPILED_SUPABASE_URL: Option<&str> = option_env!("SUPABASE_URL");
const COMPILED_SUPABASE_KEY: Option<&str> = option_env!("SUPABASE_KEY");

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
    base_url: String,
    api_key: String,
}

impl SupabaseClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();

        let url_candidate = std::env::var("SUPABASE_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| COMPILED_SUPABASE_URL.map(|v| v.to_string()))
            .unwrap_or_else(|| DEFAULT_SUPABASE_URL.to_string());

        let base_url = normalize_url(&url_candidate).unwrap_or_else(|| DEFAULT_SUPABASE_URL.to_string());

        let api_key = std::env::var("SUPABASE_KEY")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| COMPILED_SUPABASE_KEY.map(|v| v.to_string()))
            .unwrap_or_default();

        Self { client, base_url, api_key }
    }

    pub async fn get_champion_stats(&self, patch: &str) -> Result<Vec<SupabaseChampionStatsRaw>> {
        let url = format!("{}/rest/v1/champion_stats_aggregated?patch_version=eq.{}&select=*&order=win_rate.desc", self.base_url, patch);
        
        let resp = self.client
            .get(&url)
            .header("apikey", &self.api_key)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Network error: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let error_text = resp.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(anyhow::anyhow!("Supabase request failed ({}): {}", status, error_text));
        }

        let stats: Vec<SupabaseChampionStatsRaw> = resp.json().await
            .map_err(|e| anyhow::anyhow!("Failed to parse response: {}", e))?;
        Ok(stats)
    }

    pub async fn get_available_patches_stats(&self) -> Result<Vec<String>> {
        // 1) Пытаемся RPC, если есть
        let rpc_url = format!("{}/rest/v1/rpc/get_stats_patches", self.base_url);
        let rpc_resp = self.client
            .post(&rpc_url)
            .header("apikey", &self.api_key)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .header("Prefer", "return=representation")
            .json(&serde_json::json!({}))
            .send()
            .await;

        let mut rpc_not_found = false;
        if let Ok(resp) = rpc_resp {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        let mut patches: Vec<String> = Vec::new();
                        if let Some(arr) = val.as_array() {
                            for v in arr {
                                if let Some(s) = v.as_str() {
                                    patches.push(s.to_string());
                                } else if let Some(p) = v.get("patch_version").and_then(|p| p.as_str()) {
                                    patches.push(p.to_string());
                                }
                            }
                        }
                        patches.retain(|p| !p.trim().is_empty());
                        patches.sort();
                        patches.dedup();
                        patches.reverse();
                        if !patches.is_empty() {
                            return Ok(patches);
                        }
                    }
                }
            } else if resp.status().as_u16() == 404 {
                rpc_not_found = true;
            }
        }

        // 2) Fallback: distinct patch_version из таблицы champion_stats_aggregated
        let url = format!(
            "{}/rest/v1/champion_stats_aggregated?select=patch_version&distinct=exact&order=patch_version.desc",
            self.base_url
        );
        let resp = self.client
            .get(&url)
            .header("apikey", &self.api_key)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Network error: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let error_text = resp.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            let rpc_hint = if rpc_not_found { "RPC missing; fallback also failed. " } else { "" };
            return Err(anyhow::anyhow!("{}Supabase request failed ({}): {}", rpc_hint, status, error_text));
        }

        // Ответ вида [{\"patch_version\":\"15.24\"}, ...]
        let json: serde_json::Value = resp.json().await
            .map_err(|e| anyhow::anyhow!("Failed to parse response: {}", e))?;

        let mut patches: Vec<String> = json.as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .filter_map(|v| v.get("patch_version").and_then(|p| p.as_str()).map(|s| s.to_string()))
            .collect();

        patches.sort();
        patches.dedup();
        patches.reverse(); // чтобы последние шли первыми

        if patches.is_empty() && rpc_not_found {
            return Err(anyhow::anyhow!("RPC 'get_stats_patches' отсутствует и fallback не вернул данных. Добавьте RPC или заполните champion_stats_aggregated."));
        }

        Ok(patches)
    }
}

fn normalize_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let prefixed = if trimmed.starts_with("http") { trimmed.to_string() } else { format!("https://{}", trimmed) };
    reqwest::Url::parse(&prefixed)
        .ok()
        .and_then(|mut u| {
            let host = u.host_str()?;
            let project = host.split('.').next().unwrap_or("");
            if project.len() != 20 {
                return None;
            }
            u.set_path("");
            Some(u.as_str().trim_end_matches('/').to_string())
        })
}

