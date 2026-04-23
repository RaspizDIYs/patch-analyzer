//! Маркетинговый номер патча на сайте LoL: сезон 2025 = 25.x (DDragon 15.x), сезон 2026 = 26.x (DDragon 16.x).
//! Смещение +10 к major для DDragon >= 15.

use std::cmp::Ordering;

pub const DD_MAJOR_OFFSET: i32 = 10;

pub const DDRAGON_MAJOR_USE_SEASON_DISPLAY_FROM: i32 = 15;

pub const DISPLAY_MAJOR_MAP_TO_DDRAGON_FROM: i32 = 25;

pub fn ddragon_pair_to_display(major: i32, minor: i32) -> String {
    let m = if major >= DDRAGON_MAJOR_USE_SEASON_DISPLAY_FROM {
        major + DD_MAJOR_OFFSET
    } else {
        major
    };
    format!("{}.{}", m, minor)
}

pub fn versions_match(a: &str, b: &str) -> bool {
    let a = a.trim();
    let b = b.trim();
    if a == b {
        return true;
    }
    match (
        display_patch_to_ddragon_major_minor(a),
        display_patch_to_ddragon_major_minor(b),
    ) {
        (Some(pa), Some(pb)) => pa == pb,
        _ => false,
    }
}

pub fn display_patch_to_ddragon_major_minor(display: &str) -> Option<(i32, i32)> {
    let mut it = display.trim().split('.');
    let maj: i32 = it.next()?.parse().ok()?;
    let min: i32 = it.next()?.parse().ok()?;
    let dd_maj = if maj >= DISPLAY_MAJOR_MAP_TO_DDRAGON_FROM {
        maj - DD_MAJOR_OFFSET
    } else {
        maj
    };
    Some((dd_maj, min))
}

/// Сравнение display-версий по игровому порядку (без привязки к времени загрузки).
/// Некорректные строки считаются минимальными.
pub fn cmp_display_patch(a: &str, b: &str) -> Ordering {
    fn key(s: &str) -> (i32, i32) {
        display_patch_to_ddragon_major_minor(s.trim())
            .unwrap_or((i32::MIN, i32::MIN))
    }
    key(a).cmp(&key(b))
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::*;

    #[test]
    fn maps_16_8_to_26_8() {
        assert_eq!(ddragon_pair_to_display(16, 8), "26.8");
    }

    #[test]
    fn maps_15_23_to_25_23() {
        assert_eq!(ddragon_pair_to_display(15, 23), "25.23");
    }

    #[test]
    fn maps_14_24_unchanged() {
        assert_eq!(ddragon_pair_to_display(14, 24), "14.24");
    }

    #[test]
    fn reverse_26_8_to_16_8() {
        assert_eq!(
            display_patch_to_ddragon_major_minor("26.8"),
            Some((16, 8))
        );
    }

    #[test]
    fn reverse_25_23_to_15_23() {
        assert_eq!(
            display_patch_to_ddragon_major_minor("25.23"),
            Some((15, 23))
        );
    }

    #[test]
    fn legacy_display_15_23_still_maps_to_ddragon_15_23() {
        assert_eq!(
            display_patch_to_ddragon_major_minor("15.23"),
            Some((15, 23))
        );
    }

    #[test]
    fn versions_match_display_and_ddragon() {
        assert!(versions_match("26.8", "16.8"));
        assert!(versions_match("16.8", "26.8"));
        assert!(versions_match("25.24", "15.24"));
        assert!(versions_match("15.24", "25.24"));
        assert!(!versions_match("26.8", "26.7"));
    }

    #[test]
    fn cmp_display_patch_newer_first_semantics() {
        assert_eq!(cmp_display_patch("26.8", "26.7"), Ordering::Greater);
        assert_eq!(cmp_display_patch("26.7", "26.8"), Ordering::Less);
        assert_eq!(cmp_display_patch("25.24", "15.24"), Ordering::Equal);
    }
}
