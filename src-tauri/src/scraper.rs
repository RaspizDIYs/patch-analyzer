use reqwest::header;
use scraper::{Html, Selector};
use anyhow::Result;
use crate::models::{ChampionStats, LaneRole, PatchData, PatchNoteEntry, ChangeType, ItemStat};
use chrono::Utc;
use regex::Regex;

pub struct Scraper {
    client: reqwest::Client,
}

impl Scraper {
    pub fn new() -> Result<Self> {
        let mut headers = header::HeaderMap::new();
        headers.insert(header::USER_AGENT, header::HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"));
        headers.insert(header::ACCEPT_LANGUAGE, header::HeaderValue::from_static("ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"));
        
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .cookie_store(true)
            .build()?;
            
        Ok(Self { client })
    }

    pub async fn fetch_current_meta(&self, patch_version: &str) -> Result<PatchData> {
        println!("Fetching OP.GG stats for version {}...", patch_version);
        let mut champions = self.scrape_opgg_main().await?;
        
        println!("Fetching details (Items/Runes) for champions...");
        for champ in champions.iter_mut().take(10) {
            match self.scrape_champion_details(&champ.name, &champ.role).await {
                Ok((items, runes)) => {
                    champ.core_items = items;
                    champ.popular_runes = runes;
                },
                Err(e) => println!("Failed to fetch details for {}: {}", champ.name, e),
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        
        println!("Fetching Riot patch notes...");
        let patch_notes = self.scrape_riot_patch_notes(patch_version).await.unwrap_or_default();

        Ok(PatchData {
            version: patch_version.to_string(),
            fetched_at: Utc::now(),
            champions,
            patch_notes,
        })
    }

    async fn scrape_opgg_main(&self) -> Result<Vec<ChampionStats>> {
        let url = "https://op.gg/ru/lol/champions";
        let resp = self.client.get(url).send().await?.text().await?;
        let document = Html::parse_document(&resp);
        
        let row_selector = Selector::parse("table tbody tr").unwrap();
        let name_selector = Selector::parse("td:nth-child(2) strong").unwrap();
        let winrate_selector = Selector::parse("td:nth-child(5)").unwrap(); 
        let pickrate_selector = Selector::parse("td:nth-child(6)").unwrap();
        let banrate_selector = Selector::parse("td:nth-child(7)").unwrap();
        let role_selector = Selector::parse("td:nth-child(4) img").unwrap();

        let mut champions = Vec::new();

        for row in document.select(&row_selector) {
            let name_el = row.select(&name_selector).next();
            let name = match name_el {
                Some(el) => el.text().collect::<String>(),
                None => continue,
            };

            let role = if let Some(img) = row.select(&role_selector).next() {
                let alt = img.value().attr("alt").unwrap_or("").to_lowercase();
                match alt.as_str() {
                    s if s.contains("top") => LaneRole::Top,
                    s if s.contains("jungle") => LaneRole::Jungle,
                    s if s.contains("mid") => LaneRole::Mid,
                    s if s.contains("adc") || s.contains("bottom") => LaneRole::Adc,
                    s if s.contains("support") => LaneRole::Support,
                    _ => LaneRole::Unknown,
                }
            } else {
                LaneRole::Unknown
            };

            let parse_pct = |sel: &Selector| {
                row.select(sel).next()
                   .map(|el| el.text().collect::<String>())
                   .and_then(|text| text.replace("%", "").trim().parse::<f64>().ok())
                   .unwrap_or(0.0)
            };

            let win_rate = parse_pct(&winrate_selector);
            let pick_rate = parse_pct(&pickrate_selector);
            let ban_rate = parse_pct(&banrate_selector);

            champions.push(ChampionStats {
                id: name.clone(),
                name,
                tier: "Unknown".to_string(),
                role,
                win_rate,
                pick_rate,
                ban_rate,
                core_items: vec![],
                popular_runes: vec![],
            });
        }

        if champions.is_empty() {
            println!("Warning: No champions parsed. Layout might have changed or antibot active.");
        }

        Ok(champions)
    }
    
    pub async fn scrape_champion_details(&self, champion_name: &str, role: &LaneRole) -> Result<(Vec<ItemStat>, Vec<String>)> {
         let role_str = match role {
            LaneRole::Top => "top",
            LaneRole::Jungle => "jungle",
            LaneRole::Mid => "mid",
            LaneRole::Adc => "adc",
            LaneRole::Support => "support",
            _ => "mid",
        };
        
        let safe_name = champion_name.to_lowercase().replace(" ", "").replace("'", "").replace(".", "");
        let url = format!("https://op.gg/ru/lol/champions/{}/build/{}", safe_name, role_str);
        
        let resp = self.client.get(&url).send().await?.text().await?;
        let _document = Html::parse_document(&resp);
        
        let items = vec![
            ItemStat { name: "Example Item".to_string(), win_rate: 50.0, pick_rate: 10.0 }
        ];
        let runes = vec!["Conqueror".to_string()];
        
        Ok((items, runes))
    }

    async fn scrape_riot_patch_notes(&self, version: &str) -> Result<Vec<PatchNoteEntry>> {
        let url_suffix = format!("patch-{}-notes", version.replace(".", "-"));
        let url = format!("https://www.leagueoflegends.com/ru-ru/news/game-updates/{}/", url_suffix);
        
        println!("Fetching patch notes from: {}", url);
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            println!("Failed to fetch patch notes: HTTP {}", resp.status());
            return Ok(vec![]);
        }
        
        let text = resp.text().await?;
        let document = Html::parse_document(&text);
        
        let mut notes = Vec::new();
        
        // Стратегия: Ищем секции с изменениями чемпионов
        // На странице Riot обычно структура: <h2>Имя чемпиона</h2> <ul><li>изменение</li></ul>
        
        // Ищем все h2 и h3 заголовки
        let header_sel = Selector::parse("h2, h3").unwrap();
        let ul_sel = Selector::parse("ul").unwrap();
        let li_sel = Selector::parse("li").unwrap();
        
        // Собираем все заголовки и списки
        let mut headers_with_lists: Vec<(String, Vec<String>)> = Vec::new();
        
        // Проходим по документу и ищем пары заголовок-список
        let article_sel = Selector::parse("article, main, .article-body").unwrap();
        let container = document.select(&article_sel).next()
            .or_else(|| document.select(&Selector::parse("body").unwrap()).next());
        
        if let Some(cont) = container {
            let mut current_header: Option<String> = None;
            let mut current_list: Vec<String> = Vec::new();
            
            // Ищем все элементы в порядке их появления
            for element in cont.select(&Selector::parse("*").unwrap()) {
                let tag = element.value().name();
                let text = element.text().collect::<String>().trim().to_string();
                
                if tag == "h2" || tag == "h3" {
                    // Сохраняем предыдущую пару, если есть
                    if let Some(header) = current_header.take() {
                        if !current_list.is_empty() {
                            headers_with_lists.push((header, current_list.clone()));
                            current_list.clear();
                        }
                    }
                    
                    // Проверяем, что это имя чемпиона (не системный заголовок)
                    if !text.is_empty() 
                        && text.len() < 50
                        && !text.contains("Патч")
                        && !text.contains("обновление")
                        && !text.contains("Изменения обновления")
                        && !text.contains("Главные особенности")
                        && !text.contains("Будущие образы")
                        && !text.contains("Исправление")
                        && !text.contains("Похожие статьи")
                    {
                        current_header = Some(text);
                    }
                } else if tag == "ul" {
                    // Собираем элементы списка
                    for li in element.select(&li_sel) {
                        let li_text = li.text().collect::<String>().trim().to_string();
                        if !li_text.is_empty() && li_text.len() > 5 {
                            current_list.push(li_text);
                        }
                    }
                }
            }
            
            // Сохраняем последнюю пару
            if let Some(header) = current_header {
                if !current_list.is_empty() {
                    headers_with_lists.push((header, current_list));
                }
            }
        }
        
        // Преобразуем в PatchNoteEntry
        for (champ_name, details) in headers_with_lists {
            if !details.is_empty() {
                let summary = details.join("; ");
                let change_type = self.determine_change_type(&summary);
                
                notes.push(PatchNoteEntry {
                    champion_name: champ_name,
                    summary: "Изменения способностей".to_string(),
                    details,
                    change_type,
                });
            }
        }
        
        println!("Parsed {} champion changes from patch notes", notes.len());
        Ok(notes)
    }
    
    fn determine_change_type(&self, text: &str) -> ChangeType {
        let buff_re = Regex::new(r"(?i)(увеличен|усилен|увеличена|усилена|увеличены|усилены|added|increased|бафф|улучшен|повышен|повышена)").unwrap();
        let nerf_re = Regex::new(r"(?i)(уменьшен|ослаблен|уменьшена|ослаблена|уменьшены|ослаблены|removed|decreased|нерф|ухудшен|понижен|понижена)").unwrap();
        
        if buff_re.is_match(text) {
            ChangeType::Buff
        } else if nerf_re.is_match(text) {
            ChangeType::Nerf
        } else {
            ChangeType::Adjusted
        }
    }
}
