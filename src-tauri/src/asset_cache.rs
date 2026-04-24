use anyhow::Result;
use reqwest::Client;
use std::path::{Path, PathBuf};

use crate::models::PatchData;

#[derive(Default)]
pub struct AssetCacheStats {
    pub cached_new: usize,
    pub reused_existing: usize,
    pub failed: usize,
}

fn sanitize_key(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn fnv1a32(input: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for b in input.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn extension_from_url(url: &str) -> &'static str {
    let base = url.split('?').next().unwrap_or(url);
    let lower = base.to_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "jpg"
    } else if lower.ends_with(".webp") {
        "webp"
    } else if lower.ends_with(".gif") {
        "gif"
    } else if lower.ends_with(".svg") {
        "svg"
    } else {
        "png"
    }
}

fn local_path_for_url(root: &Path, bucket: &str, url: &str) -> PathBuf {
    let ext = extension_from_url(url);
    let hash = fnv1a32(url);
    root.join(bucket).join(format!("{hash:08x}.{ext}"))
}

async fn cache_remote_url(
    client: &Client,
    root: &Path,
    bucket: &str,
    raw_url: &str,
    stats: &mut AssetCacheStats,
) -> Option<String> {
    let url = raw_url.trim();
    if url.is_empty() {
        return None;
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Some(url.to_string());
    }
    let path = local_path_for_url(root, bucket, url);
    if path.exists() {
        stats.reused_existing += 1;
        return Some(path.to_string_lossy().into_owned());
    }
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(_) => {
            stats.failed += 1;
            return Some(url.to_string());
        }
    };
    if !resp.status().is_success() {
        stats.failed += 1;
        return Some(url.to_string());
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => {
            stats.failed += 1;
            return Some(url.to_string());
        }
    };
    if std::fs::create_dir_all(path.parent().unwrap_or(root)).is_err() {
        stats.failed += 1;
        return Some(url.to_string());
    }
    if std::fs::write(&path, &bytes).is_err() {
        stats.failed += 1;
        return Some(url.to_string());
    }
    stats.cached_new += 1;
    Some(path.to_string_lossy().into_owned())
}

pub async fn localize_patch_assets(
    client: &Client,
    root: &Path,
    patch: &mut PatchData,
) -> Result<AssetCacheStats> {
    let mut stats = AssetCacheStats::default();

    if let Some(u) = patch.banner_url.clone() {
        patch.banner_url = cache_remote_url(client, root, "patch_banners", &u, &mut stats).await;
    }

    for ch in &mut patch.champions {
        if let Some(u) = ch.image_url.clone() {
            let bucket = format!("champions/{}", sanitize_key(&ch.id));
            ch.image_url = cache_remote_url(client, root, &bucket, &u, &mut stats).await;
        }
        for it in &mut ch.core_items {
            if let Some(u) = it.image_url.clone() {
                it.image_url = cache_remote_url(client, root, "champion_core_items", &u, &mut stats).await;
            }
        }
    }

    for note in &mut patch.patch_notes {
        if let Some(u) = note.image_url.clone() {
            note.image_url =
                cache_remote_url(client, root, "patch_notes/images", &u, &mut stats).await;
        }
        if let Some(candidates) = note.icon_candidates.as_mut() {
            for cand in candidates.iter_mut() {
                if let Some(local) =
                    cache_remote_url(client, root, "patch_notes/icon_candidates", cand, &mut stats)
                        .await
                {
                    *cand = local;
                }
            }
        }
        for block in &mut note.details {
            if let Some(u) = block.icon_url.clone() {
                let bucket = format!("patch_notes/blocks/{}", sanitize_key(&note.id));
                block.icon_url = cache_remote_url(client, root, &bucket, &u, &mut stats).await;
            }
        }
    }
    Ok(stats)
}
