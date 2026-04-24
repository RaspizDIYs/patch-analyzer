use regex::Regex;

pub fn analyze_change_trend(text: &str) -> i32 {
    let lower = text.to_lowercase();

    if lower.contains("удалено")
        || lower.contains("removed")
        || (lower.contains("больше не")
            && !lower.contains("больше не уменьшается")
            && !lower.contains("no longer reduced"))
    {
        return -1;
    }

    if lower.contains("больше не уменьшается") || lower.contains("no longer reduced") {
        return 1;
    }

    let is_inverse = lower.contains("перезарядка")
        || lower.contains("cooldown")
        || lower.contains("стоимость")
        || lower.contains("cost")
        || lower.contains("mana")
        || lower.contains("маны")
        || lower.contains("energy")
        || lower.contains("энергии")
        || lower.contains("затраты")
        || lower.contains("время")
        || lower.contains("time")
        || lower.contains("расход маны");

    let arrow_re = Regex::new(r"\s*(?:→|⇒|->)\s*").unwrap();
    let parts: Vec<&str> = arrow_re.split(text).collect();
    if parts.len() == 2 {
        let parse_val = |s: &str| -> f64 {
            let num_re = Regex::new(r"[-+]?\d+(?:[.,]\d+)?").unwrap();
            let nums: Vec<f64> = num_re
                .find_iter(s)
                .filter_map(|m| m.as_str().replace(',', ".").parse::<f64>().ok())
                .collect();
            if nums.is_empty() {
                f64::NAN
            } else {
                nums.iter().sum()
            }
        };

        let from = parse_val(parts[0]);
        let to = parse_val(parts[1]);

        if from.is_finite() && to.is_finite() {
            if to > from {
                return if is_inverse { -1 } else { 1 };
            }
            if to < from {
                return if is_inverse { 1 } else { -1 };
            }
        }
    }

    let buff_re = Regex::new(r"(увеличен|усилен|increased|buffed|new effect|новый эффект)").unwrap();
    if buff_re.is_match(&lower) {
        return 1;
    }

    let nerf_re = Regex::new(r"(уменьшен|ослаблен|decreased|nerfed|removed|удалено)").unwrap();
    if nerf_re.is_match(&lower) {
        return -1;
    }

    0
}
