use reqwest::Url;

pub async fn search_first_video_in_channel(
    client: &reqwest::Client,
    api_key: &str,
    channel_id: &str,
    q: &str,
) -> Result<Option<(String, String)>, String> {
    let url = Url::parse_with_params(
        "https://www.googleapis.com/youtube/v3/search",
        &[
            ("part", "snippet"),
            ("type", "video"),
            ("maxResults", "1"),
            ("channelId", channel_id.trim()),
            ("q", q),
            ("key", api_key.trim()),
        ],
    )
    .map_err(|e| e.to_string())?;

    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "YouTube Data API {}: {}",
            status,
            text.chars().take(280).collect::<String>()
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let items = v["items"].as_array().cloned().unwrap_or_default();
    let first = items.first();
    let Some(item) = first else {
        return Ok(None);
    };
    let vid = item["id"]["videoId"].as_str().map(str::to_string);
    let title = item["snippet"]["title"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_default();
    match vid {
        Some(id) if !id.is_empty() => Ok(Some((id, title))),
        _ => Ok(None),
    }
}
