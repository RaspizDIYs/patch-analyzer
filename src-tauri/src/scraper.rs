use reqwest::header;
use scraper::{Html, Selector, ElementRef};
use anyhow::Result;
use crate::models::{ChampionStats, LaneRole, PatchData, PatchNoteEntry, ChangeType, ItemStat, PatchCategory, ChangeBlock};
use chrono::Utc;
use regex::Regex;

pub struct Scraper {
    client: reqwest::Client,
}

impl Scraper {
    pub fn new() -> Result<Self> {
        let mut headers = header::HeaderMap::new();
        headers.insert(header::USER_AGENT, header::HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"));
        headers.insert(header::ACCEPT, header::HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8"));
        headers.insert(header::ACCEPT_LANGUAGE, header::HeaderValue::from_static("ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"));
        
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .cookie_store(true)
            .build()?;
            
        Ok(Self { client })
    }

    pub async fn fetch_all_champions_ddragon(&self) -> Result<Vec<(String, String, String)>> {
        let ver_url = "https://ddragon.leagueoflegends.com/api/versions.json";
        let versions: Vec<String> = self.client.get(ver_url).send().await?.json().await?;
        let latest = versions.first().map(|s| s.as_str()).unwrap_or("14.23.1");

        let ru_url = format!(
            "https://ddragon.leagueoflegends.com/cdn/{}/data/ru_RU/champion.json",
            latest
        );
        let en_url = format!(
            "https://ddragon.leagueoflegends.com/cdn/{}/data/en_US/champion.json",
            latest
        );

        let (ru_resp, en_resp) = tokio::try_join!(
            self.client.get(&ru_url).send(),
            self.client.get(&en_url).send(),
        )?;

        let ru_json: serde_json::Value = ru_resp.json().await?;
        let en_json: serde_json::Value = en_resp.json().await?;

        let mut champs = Vec::new();
        if let Some(data_ru) = ru_json.get("data").and_then(|d| d.as_object()) {
            if let Some(data_en) = en_json.get("data").and_then(|d| d.as_object()) {
                for (key, val_ru) in data_ru {
                    let val_en = data_en.get(key).cloned().unwrap_or(serde_json::Value::Null);
                    let name_ru = val_ru
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name_en = val_en
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let id = val_ru
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let icon_url = format!(
                        "https://ddragon.leagueoflegends.com/cdn/{}/img/champion/{}.png",
                        latest, id
                    );
                    champs.push((name_ru, name_en, icon_url));
                }
            }
        }
        champs.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(champs)
    }

    pub async fn fetch_latest_ddragon_version(&self) -> Result<Option<String>> {
        let url = "https://ddragon.leagueoflegends.com/api/versions.json";
        match self.client.get(url).send().await {
            Ok(resp) => {
                if let Ok(versions) = resp.json::<Vec<String>>().await {
                    if let Some(latest) = versions.first() {
                        return Ok(Some(latest.clone()));
                    }
                }
                Ok(None)
            },
            Err(_) => Ok(None)
        }
    }

    pub async fn check_patch_notes_exists(&self, version: &str) -> bool {
        // Проверяем на русской странице тегов патч-нотов
        let ru_url = "https://www.leagueoflegends.com/ru-ru/news/tags/patch-notes/";
        if let Ok(resp) = self.client.get(ru_url).send().await {
            if let Ok(text) = resp.text().await {
                let document = Html::parse_document(&text);
                let link_selector = Selector::parse("a[href*='patch-']").unwrap();
                let re = Regex::new(r"patch-(\d+)-(\d+)-notes").unwrap();
                
                for link in document.select(&link_selector) {
                    if let Some(href) = link.value().attr("href") {
                        if let Some(caps) = re.captures(href) {
                            let patch_version = format!("{}.{}", &caps[1], &caps[2]);
                            if patch_version == version {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        
        // Проверяем на английской странице тегов патч-нотов
        let en_url = "https://www.leagueoflegends.com/en-us/news/tags/patch-notes/";
        if let Ok(resp) = self.client.get(en_url).send().await {
            if let Ok(text) = resp.text().await {
                let document = Html::parse_document(&text);
                let link_selector = Selector::parse("a[href*='patch-']").unwrap();
                let re = Regex::new(r"patch-(\d+)-(\d+)-notes").unwrap();
                
                for link in document.select(&link_selector) {
                    if let Some(href) = link.value().attr("href") {
                        if let Some(caps) = re.captures(href) {
                            let patch_version = format!("{}.{}", &caps[1], &caps[2]);
                            if patch_version == version {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        
        false
    }

    pub async fn fetch_available_patches(&self) -> Result<Vec<String>> {
        let mut patches = Vec::new();
        let mut seen = std::collections::HashSet::new();
        
        // Парсим русскую страницу патч-нотов
        let ru_url = "https://www.leagueoflegends.com/ru-ru/news/tags/patch-notes/";
        if let Ok(resp) = self.client.get(ru_url).send().await {
            if let Ok(text) = resp.text().await {
                let document = Html::parse_document(&text);
                let link_selector = Selector::parse("a[href*='patch-']").unwrap();
                let re = Regex::new(r"patch-(\d+)-(\d+)-notes").unwrap();
                
                for link in document.select(&link_selector) {
                    if let Some(href) = link.value().attr("href") {
                        if let Some(caps) = re.captures(href) {
                            let version = format!("{}.{}", &caps[1], &caps[2]);
                            if !seen.contains(&version) {
                                seen.insert(version.clone());
                                patches.push(version);
                            }
                        }
                    }
                }
            }
        }
        
        // Парсим английскую страницу патч-нотов (для полноты)
        let en_url = "https://www.leagueoflegends.com/en-us/news/tags/patch-notes/";
        if let Ok(resp) = self.client.get(en_url).send().await {
            if let Ok(text) = resp.text().await {
                let document = Html::parse_document(&text);
                let link_selector = Selector::parse("a[href*='patch-']").unwrap();
                let re = Regex::new(r"patch-(\d+)-(\d+)-notes").unwrap();
                
                for link in document.select(&link_selector) {
                    if let Some(href) = link.value().attr("href") {
                        if let Some(caps) = re.captures(href) {
                            let version = format!("{}.{}", &caps[1], &caps[2]);
                            if !seen.contains(&version) {
                                seen.insert(version.clone());
                                patches.push(version);
                            }
                        }
                    }
                }
            }
        }
        
        let fallback_patches = vec![
            "25.23", "25.22", "25.21", "25.20", "25.19", 
            "25.18", "25.17", "25.16", "25.15", "25.14", 
            "25.13", "25.12", "25.11", "25.10", "25.09", 
            "25.08", "25.07", "25.06", "25.05", "25.04"
        ];

        for p in fallback_patches {
            if !seen.contains(&p.to_string()) {
                seen.insert(p.to_string());
                patches.push(p.to_string());
            }
        }

        patches.sort_by(|a, b| {
            let parts_a: Vec<&str> = a.split('.').collect();
            let parts_b: Vec<&str> = b.split('.').collect();
            let major_a = parts_a.get(0).unwrap_or(&"0").parse::<i32>().unwrap_or(0);
            let minor_a = parts_a.get(1).unwrap_or(&"0").parse::<i32>().unwrap_or(0);
            let major_b = parts_b.get(0).unwrap_or(&"0").parse::<i32>().unwrap_or(0);
            let minor_b = parts_b.get(1).unwrap_or(&"0").parse::<i32>().unwrap_or(0);

            if major_a != major_b { major_b.cmp(&major_a) } else { minor_b.cmp(&minor_a) }
        });

        Ok(patches)
    }

    pub async fn fetch_current_meta(&self, patch_version: &str) -> Result<PatchData> {
        let mut champions = match self.scrape_leagueofgraphs().await {
            Ok(c) if !c.is_empty() => c,
            _ => vec![]
        };
        
        if champions.is_empty() {
             if let Ok(c) = self.scrape_metasrc().await {
                 if !c.is_empty() { champions = c; }
             }
        }

        let patch_notes = self.scrape_riot_patch_notes(patch_version).await.unwrap_or_default();

        if champions.is_empty() && !patch_notes.is_empty() {
            for note in &patch_notes {
                if note.category == PatchCategory::Champions {
                    champions.push(ChampionStats {
                        id: note.title.clone(),
                        name: note.title.clone(),
                        tier: "?".to_string(),
                        role: LaneRole::Mid, 
                        win_rate: 50.0,
                        pick_rate: 0.0,
                        ban_rate: 0.0,
                        image_url: note.image_url.clone(),
                        core_items: vec![],
                        popular_runes: vec![],
                    });
                }
            }
        }

        Ok(PatchData {
            version: patch_version.to_string(),
            fetched_at: Utc::now(),
            champions,
            patch_notes,
        })
    }

    async fn scrape_riot_patch_notes(&self, version: &str) -> Result<Vec<PatchNoteEntry>> {
        let url_suffix = format!("patch-{}-notes", version.replace(".", "-"));
        let url = format!("https://www.leagueoflegends.com/ru-ru/news/game-updates/{}/", url_suffix);
        
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            return Ok(vec![]);
        }
        
        let text = resp.text().await?;
        let document = Html::parse_document(&text);
        let mut notes = Vec::new();
        
        let container_sel = Selector::parse("#patch-notes-container").unwrap();
        
        if let Some(container) = document.select(&container_sel).next() {
            let mut current_category = PatchCategory::Unknown;
            
            let h2_sel = Selector::parse("h2").unwrap();
            let change_block_sel = Selector::parse(".patch-change-block").unwrap();
            let img_sel = Selector::parse("img").unwrap();
            let li_sel = Selector::parse("li").unwrap();
            let ul_sel = Selector::parse("ul").unwrap();

            for child in container.children() {
                if let Some(el) = ElementRef::wrap(child) {
                    let h2_el = el.select(&h2_sel).next();
                    if let Some(h2) = h2_el {
                        let id = h2.value().id().unwrap_or("").to_lowercase();
                        if id.contains("champion") { current_category = PatchCategory::Champions; }
                        else if id.contains("item") && !id.contains("rune") { current_category = PatchCategory::Items; }
                        else if id.contains("rune") && !id.contains("item") { current_category = PatchCategory::Runes; }
                        else if id.contains("item") || id.contains("rune") { current_category = PatchCategory::ItemsRunes; } // Fallback для legacy
                        else if id.contains("skin") || id.contains("chroma") { current_category = PatchCategory::Skins; }
                        else if id.contains("bug") { current_category = PatchCategory::BugFixes; }
                        else if id.contains("aram") || id.contains("arena") || id.contains("mode") { current_category = PatchCategory::Modes; }
                        else if id.contains("system") || id.contains("qol") { current_category = PatchCategory::Systems; }
                        else if id.contains("highlight") { current_category = PatchCategory::NewContent; }
                        else { current_category = PatchCategory::Unknown; }
                    }
                    
                    // Helper to clean URLs from Riot's proxy
                    let clean_url = |url: Option<String>| -> Option<String> {
                        url.map(|u| {
                            if u.contains("akamaihd.net") && u.contains("?f=") {
                                if let Some(pos) = u.find("?f=") {
                                    return u[pos + 3..].to_string();
                                }
                            }
                            u
                        })
                    };
                    
                    // Iterate over ALL patch-change-blocks, not just the first one
                    for block_el in el.select(&change_block_sel) {
                        let mut wrapper = block_el;
                        // Try to find inner div if it exists (common Riot structure)
                        for child_node in block_el.children() {
                            if let Some(child_el) = ElementRef::wrap(child_node) {
                                if child_el.value().name() == "div" {
                                    wrapper = child_el;
                                    break;
                                }
                            }
                        }

                        // State Machine for parsing potentially multiple champions in one block
                        let mut pending_icon: Option<String> = None;
                        let mut current_entry: Option<PatchNoteEntry> = None;

                        for child in wrapper.children() {
                            if let Some(child_el) = ElementRef::wrap(child) {
                                let tag = child_el.value().name();
                                let classes = child_el.value().classes().collect::<Vec<_>>().join(" ");

                                // Case 1: Avatar / Reference Link (comes before Title)
                                if tag == "a" && classes.contains("reference-link") {
                                    pending_icon = clean_url(child_el.select(&img_sel).next()
                                        .and_then(|img| img.value().attr("src").or(img.value().attr("data-src")))
                                        .map(|s| s.to_string()));
                                }
                                // Case 2: Title (H3 or .change-title) -> New Entry
                                else if (tag == "h3" || tag == "h4" || classes.contains("change-title")) && 
                                        !classes.contains("change-detail-title") && !classes.contains("ability-title") {
                                    
                                    // If we have a completed entry, save it
                                    if let Some(entry) = current_entry.take() {
                                        notes.push(entry);
                                    }

                                    let title_text = child_el.text().collect::<String>().trim().to_string();
                                    if !title_text.is_empty() {
                                        current_entry = Some(PatchNoteEntry {
                                            id: title_text.clone(),
                                            title: title_text,
                                            image_url: pending_icon.take(), // Use and clear pending icon
                                            category: current_category.clone(),
                                            change_type: ChangeType::Adjusted, // Will calculate later
                                            summary: String::new(),
                                            details: Vec::new(),
                                        });
                                    }
                                }
                                // Case 3: Summary (blockquote)
                                else if tag == "blockquote" {
                                    if let Some(entry) = current_entry.as_mut() {
                                        entry.summary = child_el.text().collect::<String>().trim().to_string();
                                    }
                                }
                                // Case 4: Ability Title (H4)
                                else if (tag == "h4") && (classes.contains("change-detail-title") || classes.contains("ability-title")) {
                                    if let Some(entry) = current_entry.as_mut() {
                                        let detail_title = child_el.text().collect::<String>().trim().to_string();
                                        let detail_icon = clean_url(child_el.select(&img_sel).next()
                                            .and_then(|i| i.value().attr("src").or(i.value().attr("data-src")))
                                            .map(|s| s.to_string()));
                                        
                                        entry.details.push(ChangeBlock {
                                            title: Some(detail_title),
                                            icon_url: detail_icon,
                                            changes: Vec::new(),
                                        });
                                    }
                                }
                                // Case 5: Changes List (UL)
                                else if tag == "ul" {
                                    if let Some(entry) = current_entry.as_mut() {
                                        let mut changes = Vec::new();
                                        for li in child_el.select(&li_sel) {
                                            let text = li.text().collect::<String>().trim().to_string();
                                            if !text.is_empty() { changes.push(text); }
                                        }
                                        
                                        if !changes.is_empty() {
                                            // Attach to last block, or create new nameless block
                                            if let Some(last_block) = entry.details.last_mut() {
                                                last_block.changes.extend(changes);
                                            } else {
                                                entry.details.push(ChangeBlock {
                                                    title: None,
                                                    icon_url: None,
                                                    changes,
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        // Push the final entry from this block
                        if let Some(mut entry) = current_entry {
                            // Calculate ChangeType based on all text
                            let all_text = entry.details.iter().flat_map(|b| b.changes.clone()).collect::<Vec<_>>().join(" ");
                            entry.change_type = self.determine_change_type(&all_text);
                            notes.push(entry);
                        }
                    }

                    if el.value().has_class("content-border", scraper::CaseSensitivity::CaseSensitive) {
                         if current_category == PatchCategory::BugFixes {
                             for ul in el.select(&ul_sel) {
                                 for li in ul.select(&li_sel) {
                                     let text = li.text().collect::<String>().trim().to_string();
                                     if text.is_empty() { continue; }
                                     notes.push(PatchNoteEntry {
                                         id: format!("fix_{}", notes.len()),
                                         title: "Исправление ошибки".to_string(),
                                         image_url: None,
                                         category: current_category.clone(),
                                         change_type: ChangeType::Fix,
                                         summary: text.clone(),
                                         details: vec![ChangeBlock { title: None, icon_url: None, changes: vec![text] }],
                                     });
                                 }
                             }
                         }
                    }
                }
            }
        }
        Ok(notes)
    }
    
    async fn scrape_leagueofgraphs(&self) -> Result<Vec<ChampionStats>> {
        let url = "https://www.leagueofgraphs.com/ru/champions/tier-list";
        if let Ok(resp) = self.client.get(url).send().await {
            if let Ok(text) = resp.text().await {
                let _document = Html::parse_document(&text);
                return Ok(vec![]); 
            }
        }
        Ok(vec![])
    }

    async fn scrape_metasrc(&self) -> Result<Vec<ChampionStats>> { Ok(vec![]) }

    fn determine_change_type(&self, text: &str) -> ChangeType {
        let buff_re = Regex::new(r"(?i)(увеличен|усилен|added|increased|дополнительный урон)").unwrap();
        let nerf_re = Regex::new(r"(?i)(уменьшен|ослаблен|removed|decreased)").unwrap();
        if buff_re.is_match(text) { ChangeType::Buff }
        else if nerf_re.is_match(text) { ChangeType::Nerf }
        else { ChangeType::Adjusted }
    }
    
    pub async fn scrape_champion_details(&self, _name: &str, _role: &LaneRole) -> Result<(Vec<ItemStat>, Vec<String>)> {
        Ok((vec![], vec![]))
    }
}
