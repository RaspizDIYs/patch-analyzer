use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct YoutubeFeedItem {
    pub video_id: String,
    pub title: String,
    pub published: String,
    pub thumbnail_url: String,
}

pub async fn fetch_youtube_feed_async(channel_id: &str) -> Result<Vec<YoutubeFeedItem>, String> {
    let url = format!(
        "https://www.youtube.com/feeds/videos.xml?channel_id={}",
        channel_id.trim()
    );
    let client = reqwest::Client::builder()
        .user_agent("PatchAnalyzer/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("YouTube RSS HTTP {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_youtube_atom(&text))
}

fn parse_youtube_atom(xml: &str) -> Vec<YoutubeFeedItem> {
    let thumb_re = Regex::new(r#"media:thumbnail[^>]*url="([^"]+)""#).unwrap();
    let mut out = Vec::new();
    for chunk in xml.split("<entry>") {
        let Some(end) = chunk.find("</entry>") else {
            continue;
        };
        let e = &chunk[..end];
        let Some(vid) = extract_simple_tag(e, "yt:videoId") else {
            continue;
        };
        let title = extract_simple_tag(e, "title").unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let published = extract_simple_tag(e, "published").unwrap_or_default();
        let thumbnail_url = thumb_re
            .captures(e)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{vid}/hqdefault.jpg"));
        out.push(YoutubeFeedItem {
            video_id: vid,
            title,
            published,
            thumbnail_url,
        });
    }
    out
}

fn extract_simple_tag(fragment: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = fragment.find(&open)? + open.len();
    let rest = &fragment[start..];
    let end = rest.find(&close)?;
    Some(rest[..end].trim().to_string())
}
