use crate::models::{ChampionStats, MetaAnalysisDiff, PatchData, ChangeType, PatchCategory};
use std::collections::HashMap;

pub struct Analyzer;

impl Analyzer {
    pub fn compare_patches(current: &PatchData, previous: &PatchData) -> Vec<MetaAnalysisDiff> {
        let mut diffs = Vec::new();
        
        // Create a map of previous stats
        let mut prev_map: HashMap<(String, crate::models::LaneRole), &ChampionStats> = HashMap::new();
        for champ in &previous.champions {
            prev_map.insert((champ.name.clone(), champ.role.clone()), champ);
        }

        // Create a map of patch notes for quick lookup
        // Only look at Champions category for meta analysis
        let mut patch_notes_map: HashMap<String, (ChangeType, Option<String>)> = HashMap::new();
        for note in &current.patch_notes {
            if note.category == PatchCategory::Champions {
                patch_notes_map.insert(note.title.clone(), (note.change_type.clone(), note.image_url.clone()));
            }
        }

        for curr_champ in &current.champions {
            let key = (curr_champ.name.clone(), curr_champ.role.clone());
            
            let (win_rate_diff, pick_rate_diff) = if let Some(prev_champ) = prev_map.get(&key) {
                (
                    curr_champ.win_rate - prev_champ.win_rate,
                    curr_champ.pick_rate - prev_champ.pick_rate,
                )
            } else {
                (0.0, 0.0) 
            };
            
            // Determine predicted change
            // Try matching by exact name or partial match if needed
            let (predicted, note_image) = patch_notes_map.get(&curr_champ.name)
                .map(|(c, i)| (Some(c.clone()), i.clone()))
                .unwrap_or((None, None));

            let image_url = curr_champ.image_url.clone().or(note_image);

            // Filter interesting changes
            if win_rate_diff.abs() > 0.5 || pick_rate_diff.abs() > 0.5 || predicted.is_some() {
                diffs.push(MetaAnalysisDiff {
                    champion_name: curr_champ.name.clone(),
                    role: curr_champ.role.clone(),
                    win_rate_diff: (win_rate_diff * 10.0).round() / 10.0,
                    pick_rate_diff: (pick_rate_diff * 10.0).round() / 10.0,
                    predicted_change: predicted,
                    champion_image_url: image_url,
                });
            }
        }

        // Sort
        diffs.sort_by(|a, b| {
            let a_has_pred = a.predicted_change.is_some();
            let b_has_pred = b.predicted_change.is_some();
            
            if a_has_pred && !b_has_pred {
                std::cmp::Ordering::Less
            } else if !a_has_pred && b_has_pred {
                std::cmp::Ordering::Greater
            } else {
                b.win_rate_diff.abs().partial_cmp(&a.win_rate_diff.abs()).unwrap_or(std::cmp::Ordering::Equal)
            }
        });

        diffs
    }
}
