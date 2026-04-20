use crate::models::{ChampionStats, MetaAnalysisDiff, PatchCategory, PatchData};

pub struct Analyzer;

impl Analyzer {
    pub fn compare_patches(current: &PatchData, previous: &PatchData) -> Vec<MetaAnalysisDiff> {
        let role_key = |c: &ChampionStats| -> String { format!("{:?}", c.role) };

        let mut prev_map: std::collections::HashMap<(String, String), &ChampionStats> =
            std::collections::HashMap::new();
        for c in &previous.champions {
            prev_map.insert((c.id.clone(), role_key(c)), c);
        }

        let prediction_for = |name: &str| -> Option<String> {
            for note in &current.patch_notes {
                if note.category != PatchCategory::Champions {
                    continue;
                }
                if note.title.eq_ignore_ascii_case(name) || note.title == name {
                    return Some(format!("{:?}", note.change_type));
                }
            }
            None
        };

        let mut out: Vec<MetaAnalysisDiff> = Vec::new();
        for c in &current.champions {
            let key = (c.id.clone(), role_key(c));
            let Some(p) = prev_map.get(&key) else {
                continue;
            };
            let win_rate_diff = (c.win_rate - p.win_rate).round();
            let pick_rate_diff = (c.pick_rate - p.pick_rate).round();
            if win_rate_diff == 0.0 && pick_rate_diff == 0.0 {
                continue;
            }
            out.push(MetaAnalysisDiff {
                champion_name: c.name.clone(),
                role: role_key(c),
                win_rate_diff,
                pick_rate_diff,
                predicted_change: prediction_for(&c.name),
                champion_image_url: c.image_url.clone(),
            });
        }

        out.sort_by(|a, b| {
            b.win_rate_diff
                .abs()
                .partial_cmp(&a.win_rate_diff.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }
}
