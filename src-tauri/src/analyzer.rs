use crate::models::{ChampionStats, MetaAnalysisDiff, PatchData, ChangeType, LaneRole};
use std::collections::HashMap;

pub struct Analyzer;

impl Analyzer {
    pub fn compare_patches(current: &PatchData, previous: &PatchData) -> Vec<MetaAnalysisDiff> {
        let mut diffs = Vec::new();
        
        let prev_map: HashMap<(String, LaneRole), &ChampionStats> = previous.champions.iter()
            .map(|c| ((c.name.clone(), c.role.clone()), c))
            .collect();

        // Карта патч-нотов для быстрого поиска изменений
        let patch_notes_map: HashMap<String, ChangeType> = current.patch_notes.iter()
            .map(|n| (n.champion_name.clone(), n.change_type.clone()))
            .collect();

        for curr in &current.champions {
            let key = (curr.name.clone(), curr.role.clone());
            
            let mut win_diff = 0.0;
            let mut pick_diff = 0.0;
            
            if let Some(prev) = prev_map.get(&key) {
                win_diff = curr.win_rate - prev.win_rate;
                pick_diff = curr.pick_rate - prev.pick_rate;
            }

            // Логика предсказания (пункт 6)
            let predicted = if let Some(change) = patch_notes_map.get(&curr.name) {
                // Если есть изменения в патче, предсказываем влияние
                Some(change.clone())
            } else {
                None
            };
            
            // Добавляем в список только если есть изменения статистики ИЛИ есть запись в патч-нотах
            if win_diff.abs() > 0.01 || pick_diff.abs() > 0.01 || predicted.is_some() {
                diffs.push(MetaAnalysisDiff {
                    champion_name: curr.name.clone(),
                    role: curr.role.clone(),
                    win_rate_diff: (win_diff * 100.0).round() / 100.0,
                    pick_rate_diff: (pick_diff * 100.0).round() / 100.0,
                    predicted_change: predicted,
                });
            }
        }
        
        // Сортируем: Сначала те, у кого есть предсказания (изменения в патче), потом по винрейту
        diffs.sort_by(|a, b| {
            let a_has_note = a.predicted_change.is_some();
            let b_has_note = b.predicted_change.is_some();
            
            if a_has_note && !b_has_note {
                std::cmp::Ordering::Less // A выше
            } else if !a_has_note && b_has_note {
                std::cmp::Ordering::Greater
            } else {
                b.win_rate_diff.partial_cmp(&a.win_rate_diff).unwrap_or(std::cmp::Ordering::Equal)
            }
        });
        
        diffs
    }
}
