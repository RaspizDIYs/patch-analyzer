use serde::{Deserialize, Serialize};
use reqwest::Client;
use anyhow::Result;
use tauri::AppHandle;

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

    pub async fn get_raw_matches_count(&self, patch: &str, app: Option<&AppHandle>) -> Result<i64> {
        let url = format!("{}/rest/v1/match_participants_stats?patch_version=eq.{}&select=id", SUPABASE_URL, patch);
        if let Some(app) = app {
            super::log(app, "INFO", &format!("Checking raw matches count for patch: {}", patch), "SUPABASE");
        }
        
        let resp = self.client
            .get(&url)
            .header("apikey", SUPABASE_KEY)
            .header("Authorization", format!("Bearer {}", SUPABASE_KEY))
            .header("Prefer", "count=exact")
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Network error: {}", e))?;

        if resp.status().is_success() {
            if let Some(count_header) = resp.headers().get("content-range") {
                if let Some(count_str) = count_header.to_str().ok().and_then(|s| s.split('/').last()) {
                    if let Ok(count) = count_str.parse::<i64>() {
                        if let Some(app) = app {
                            super::log(app, "INFO", &format!("Raw matches count: {}", count), "SUPABASE");
                        }
                        return Ok(count);
                    }
                }
            }
        }
        Ok(0)
    }

    pub async fn get_champion_stats(&self, patch: &str, app: Option<&AppHandle>) -> Result<Vec<SupabaseChampionStatsRaw>> {
        let url = format!("{}/rest/v1/champion_stats_aggregated?patch_version=eq.{}&select=*&order=win_rate.desc&limit=10000", SUPABASE_URL, patch);
        if let Some(app) = app {
            super::log(app, "INFO", &format!("Fetching stats from Supabase for patch: {} (limit: 10000)", patch), "SUPABASE");
        }
        
        let resp = self.client
            .get(&url)
            .header("apikey", SUPABASE_KEY)
            .header("Authorization", format!("Bearer {}", SUPABASE_KEY))
            .header("Prefer", "count=exact")
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Network error: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let error_text = resp.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            if let Some(app) = app {
                super::log(app, "ERROR", &format!("Stats request failed: {} - {}", status, error_text), "SUPABASE");
            }
            return Err(anyhow::anyhow!("Supabase request failed ({}): {}", status, error_text));
        }

        let response_text = resp.text().await.unwrap_or_default();
        if let Some(app) = app {
            super::log(app, "INFO", &format!("Stats response received: {} bytes", response_text.len()), "SUPABASE");
        }
        
        let stats: Vec<SupabaseChampionStatsRaw> = serde_json::from_str(&response_text)
            .map_err(|e| {
                let preview = &response_text[..response_text.len().min(500)];
                if let Some(app) = app {
                    super::log(app, "ERROR", &format!("Failed to parse stats JSON: {} - Response preview: {}", e, preview), "SUPABASE");
                }
                anyhow::anyhow!("Failed to parse response: {}", e)
            })?;
        
        if let Some(app) = app {
            let total_matches: i64 = stats.iter().map(|s| s.total_matches.unwrap_or(0) as i64).sum();
            let mut tiers: Vec<String> = stats.iter().map(|s| s.tier.clone()).collect::<std::collections::HashSet<_>>().into_iter().collect();
            tiers.sort();
            let mut regions: Vec<String> = stats.iter().map(|s| s.region.clone()).collect::<std::collections::HashSet<_>>().into_iter().collect();
            regions.sort();
            
            if let Some(first) = stats.first() {
                super::log(app, "INFO", &format!("Sample record: champion={}, tier={}, region={}, matches={}, win_rate={:?}", 
                    first.champion_id, first.tier, first.region, first.total_matches.unwrap_or(0), first.win_rate), "SUPABASE");
            }
            
            let raw_count = self.get_raw_matches_count(patch, Some(app)).await.unwrap_or(0);
            super::log(app, "SUCCESS", &format!("Parsed {} stats records, total matches: {}, raw matches: {}, tiers: {:?}, regions: {:?}", 
                stats.len(), total_matches, raw_count, tiers, regions), "SUPABASE");
            
            if raw_count > total_matches && raw_count > 0 {
                let diff = raw_count - total_matches;
                let percentage = (total_matches as f64 / raw_count as f64 * 100.0) as i64;
                super::log(app, "WARN", &format!("Aggregation incomplete: {} raw matches vs {} aggregated matches ({}% coverage). {} matches missing.", 
                    raw_count, total_matches, percentage, diff), "SUPABASE");
            }
        }
        Ok(stats)
    }

    pub async fn get_available_patches_stats(&self, app: Option<&AppHandle>) -> Result<Vec<String>> {
        // 1) Пытаемся RPC, если есть
        let rpc_url = format!("{}/rest/v1/rpc/get_stats_patches", SUPABASE_URL);
        if let Some(app) = app {
            super::log(app, "INFO", "Trying RPC get_stats_patches...", "SUPABASE");
        }
        
        let rpc_resp = self.client
            .post(&rpc_url)
            .header("apikey", SUPABASE_KEY)
            .header("Authorization", format!("Bearer {}", SUPABASE_KEY))
            .header("Content-Type", "application/json")
            .header("Prefer", "return=representation")
            .json(&serde_json::json!({}))
            .send()
            .await;

        let mut rpc_not_found = false;
        if let Ok(resp) = rpc_resp {
            let status = resp.status();
            if status.is_success() {
                let response_text = resp.text().await.unwrap_or_default();
                if let Some(app) = app {
                    super::log(app, "INFO", &format!("RPC response received: {} bytes", response_text.len()), "SUPABASE");
                }
                
                if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&response_text) {
                    if let Some(array) = json_value.as_array() {
                        let patches: Vec<String> = array
                            .iter()
                            .filter_map(|v| {
                                if let Some(s) = v.as_str() {
                                    Some(s.to_string())
                                } else if let Some(obj) = v.as_object() {
                                    obj.get("patch_version")
                                        .and_then(|p| p.as_str())
                                        .map(|s| s.to_string())
                                } else {
                                    None
                                }
                            })
                            .collect();
                        if !patches.is_empty() {
                            if let Some(app) = app {
                                super::log(app, "SUCCESS", &format!("RPC returned {} patches", patches.len()), "SUPABASE");
                            }
                            return Ok(patches);
                        }
                    } else {
                        if let Some(app) = app {
                            super::log(app, "WARN", &format!("RPC response is not an array: {:?}", json_value), "SUPABASE");
                        }
                    }
                } else {
                    if let Some(app) = app {
                        super::log(app, "WARN", &format!("Failed to parse RPC response as JSON, using fallback"), "SUPABASE");
                    }
                }
            } else if status.as_u16() == 404 {
                rpc_not_found = true;
                if let Some(app) = app {
                    super::log(app, "INFO", "RPC function not found (404), using fallback", "SUPABASE");
                }
            } else {
                let error_text = resp.text().await.unwrap_or_default();
                if let Some(app) = app {
                    super::log(app, "WARN", &format!("RPC returned error status {}: {}, using fallback", status, error_text), "SUPABASE");
                }
            }
        } else {
            if let Some(app) = app {
                super::log(app, "WARN", "RPC request failed, using fallback", "SUPABASE");
            }
        }

        // 2) Fallback: distinct patch_version из таблицы champion_stats_aggregated
        if let Some(app) = app {
            super::log(app, "INFO", "Using fallback method: distinct patch_version from champion_stats_aggregated", "SUPABASE");
        }
        
        let url = format!(
            "{}/rest/v1/champion_stats_aggregated?select=patch_version&distinct=exact&order=patch_version.desc",
            SUPABASE_URL
        );
        let resp = self.client
            .get(&url)
            .header("apikey", SUPABASE_KEY)
            .header("Authorization", format!("Bearer {}", SUPABASE_KEY))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Network error: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let error_text = resp.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            let rpc_hint = if rpc_not_found { "RPC missing; fallback also failed. " } else { "" };
            if let Some(app) = app {
                super::log(app, "ERROR", &format!("Fallback request failed: {} - {}", status, error_text), "SUPABASE");
            }
            return Err(anyhow::anyhow!("{}Supabase request failed ({}): {}", rpc_hint, status, error_text));
        }

        // Ответ вида [{\"patch_version\":\"15.24\"}, ...]
        let json: serde_json::Value = resp.json().await
            .map_err(|e| {
                if let Some(app) = app {
                    super::log(app, "ERROR", &format!("Failed to parse fallback response: {}", e), "SUPABASE");
                }
                anyhow::anyhow!("Failed to parse response: {}", e)
            })?;

        let mut patches: Vec<String> = json.as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .filter_map(|v| v.get("patch_version").and_then(|p| p.as_str()).map(|s| s.to_string()))
            .collect();

        patches.sort();
        patches.dedup();
        patches.reverse(); // чтобы последние шли первыми

        if patches.is_empty() && rpc_not_found {
            if let Some(app) = app {
                super::log(app, "ERROR", "RPC 'get_stats_patches' отсутствует и fallback не вернул данных", "SUPABASE");
            }
            return Err(anyhow::anyhow!("RPC 'get_stats_patches' отсутствует и fallback не вернул данных. Добавьте RPC или заполните champion_stats_aggregated."));
        }

        if let Some(app) = app {
            super::log(app, "SUCCESS", &format!("Fallback returned {} patches", patches.len()), "SUPABASE");
        }
        Ok(patches)
    }
}

