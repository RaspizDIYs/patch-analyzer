use anyhow::Result;

use crate::db::{
    augment_row_matches_icon_url, cd_meta_allows_maps, normalize_augment_lookup_key, Database,
};
use crate::models::{PatchCategory, PatchData, PatchNoteEntry, StaticCatalogRow};
use crate::wiki_augment_bundle::{
    bundle_icon_for_note, bundle_icon_via_catalog_bridge, resolve_augment_title_for_bundle_lookup,
};

fn title_match_variants(title: &str) -> Vec<String> {
    let t = title.trim();
    if t.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    let lower = t.to_lowercase();
    if !lower.is_empty() {
        out.push(lower.clone());
    }
    if let Some(idx) = t.find('(') {
        let s = t[..idx].trim();
        if !s.is_empty() {
            let sl = s.to_lowercase();
            if !out.contains(&sl) {
                out.push(sl);
            }
        }
    }
    let nk = normalize_augment_lookup_key(t);
    if nk.len() >= 2 && !out.iter().any(|x| x == &nk) {
        out.push(nk);
    }
    out
}

fn map_ids_for_category(cat: &PatchCategory) -> Vec<u32> {
    match cat {
        PatchCategory::ModeArena => vec![30],
        PatchCategory::ModeAram | PatchCategory::ModeAramChaos | PatchCategory::ModeAramAugments => {
            vec![12]
        }
        PatchCategory::Champions
        | PatchCategory::Items
        | PatchCategory::Runes
        | PatchCategory::ItemsRunes
        | PatchCategory::Systems
        | PatchCategory::Modes => vec![11],
        _ => vec![11, 12, 30],
    }
}

fn urls_from_row(r: &StaticCatalogRow) -> Vec<String> {
    r.icon_sources
        .iter()
        .filter_map(|e| e.url.clone())
        .collect()
}

fn best_item_row<'a>(
    title_lower: &str,
    wanted: &[u32],
    items: &'a [StaticCatalogRow],
) -> Option<&'a StaticCatalogRow> {
    let mut exact: Vec<&StaticCatalogRow> = items
        .iter()
        .filter(|r| {
            let ru = r.name_ru.to_lowercase();
            let en = r.name_en.to_lowercase();
            (ru == title_lower || en == title_lower)
                && r.cd_meta
                    .as_ref()
                    .map(|m| cd_meta_allows_maps(m, wanted))
                    .unwrap_or(true)
        })
        .collect();
    if exact.len() == 1 {
        return Some(exact[0]);
    }
    if exact.len() > 1 {
        exact.sort_by_key(|r| {
            if r.cd_meta.is_some() {
                0
            } else {
                1
            }
        });
        return Some(exact[0]);
    }
    items
        .iter()
        .find(|r| {
            let ru = r.name_ru.to_lowercase();
            let en = r.name_en.to_lowercase();
            let ru_ok = ru.len() >= 4 && title_lower.contains(&ru);
            let en_ok = en.len() >= 4 && title_lower.contains(&en);
            (ru_ok || en_ok)
                && r.cd_meta
                    .as_ref()
                    .map(|m| cd_meta_allows_maps(m, wanted))
                    .unwrap_or(true)
        })
}

fn augment_pool(meta: Option<&serde_json::Value>) -> Option<&str> {
    meta?.get("pool")?.as_str()
}

fn augment_row_matches_pool(row: &StaticCatalogRow, pool: &str) -> bool {
    let p = augment_pool(row.cd_meta.as_ref()).unwrap_or("");
    p.is_empty() || p == pool || p == "unknown"
}

fn best_champion_match<'a>(
    title: &str,
    champs: &'a [StaticCatalogRow],
) -> Option<&'a StaticCatalogRow> {
    let vars = title_match_variants(title);
    for v in &vars {
        if let Some(r) = champs.iter().find(|r| {
            r.name_ru.to_lowercase() == *v || r.name_en.to_lowercase() == *v
        }) {
            return Some(r);
        }
    }
    let primary = title.trim().to_lowercase();
    if primary.len() < 2 {
        return None;
    }
    champs.iter().find(|r| {
        let ru = r.name_ru.to_lowercase();
        let en = r.name_en.to_lowercase();
        if ru.len() < 2 && en.len() < 2 {
            return false;
        }
        primary.contains(&ru)
            || primary.contains(&en)
            || ru.contains(&primary)
            || en.contains(&primary)
    })
}

fn best_rune_match<'a>(
    title: &str,
    runes: &'a [StaticCatalogRow],
) -> Option<&'a StaticCatalogRow> {
    let vars = title_match_variants(title);
    for v in &vars {
        if let Some(r) = runes.iter().find(|r| {
            r.name_ru.to_lowercase() == *v || r.name_en.to_lowercase() == *v
        }) {
            return Some(r);
        }
    }
    let primary = title.trim().to_lowercase();
    if primary.len() < 2 {
        return None;
    }
    runes.iter().find(|r| {
        let ru = r.name_ru.to_lowercase();
        let en = r.name_en.to_lowercase();
        if ru.len() < 2 && en.len() < 2 {
            return false;
        }
        primary.contains(&ru)
            || primary.contains(&en)
            || ru.contains(&primary)
            || en.contains(&primary)
    })
}

fn push_item_icons_for_title(
    title: &str,
    maps: &[u32],
    items: &[StaticCatalogRow],
    candidates: &mut Vec<String>,
) {
    for v in title_match_variants(title) {
        if let Some(row) = best_item_row(&v, maps, items) {
            for u in urls_from_row(row) {
                push_unique(candidates, u);
            }
            return;
        }
    }
}

fn push_mode_catalog_fallbacks(
    title: &str,
    maps: &[u32],
    items: &[StaticCatalogRow],
    champs: &[StaticCatalogRow],
    runes: &[StaticCatalogRow],
    candidates: &mut Vec<String>,
) {
    let before_items = candidates.len();
    push_item_icons_for_title(title, maps, items, candidates);

    // In mode notes, prefer item/rune matches first. Champion fallback is last resort.
    if candidates.len() == before_items {
        if let Some(row) = best_champion_match(title, champs) {
            for u in urls_from_row(row) {
                push_unique(candidates, u);
            }
        }
    }

    if let Some(row) = best_rune_match(title, runes) {
        for u in urls_from_row(row) {
            push_unique(candidates, u);
        }
    }
}

fn best_augment_row<'a>(
    norm: &str,
    wanted: &[u32],
    augments: &'a [StaticCatalogRow],
) -> Option<&'a StaticCatalogRow> {
    let pool: Vec<&StaticCatalogRow> = augments
        .iter()
        .filter(|r| {
            let en = normalize_augment_lookup_key(&r.name_en);
            let ru = normalize_augment_lookup_key(&r.name_ru);
            let sid = normalize_augment_lookup_key(&r.stable_id);
            norm == en || norm == ru || norm == sid || en.starts_with(norm) || norm.starts_with(&en)
        })
        .collect();
    if pool.is_empty() {
        return None;
    }
    if wanted.contains(&30) {
        if let Some(a) = pool.iter().find(|r| augment_pool(r.cd_meta.as_ref()) == Some("arena")) {
            return Some(*a);
        }
    }
    if wanted.contains(&12) {
        if let Some(a) = pool
            .iter()
            .find(|r| augment_pool(r.cd_meta.as_ref()) == Some("mayhem"))
        {
            return Some(*a);
        }
        if let Some(a) = pool
            .iter()
            .find(|r| augment_pool(r.cd_meta.as_ref()) == Some("unknown"))
        {
            return Some(*a);
        }
    }
    if wanted.contains(&30) {
        if let Some(a) = pool
            .iter()
            .find(|r| augment_pool(r.cd_meta.as_ref()) == Some("unknown"))
        {
            return Some(*a);
        }
    }
    Some(pool[0])
}

pub async fn enrich_patch_data_icons(db: &Database, patch: &mut PatchData) -> Result<()> {
    let items = db.get_static_catalog_kind("item").await.unwrap_or_default();
    let augments = db.get_static_catalog_kind("augment").await.unwrap_or_default();
    let champs = db.get_static_catalog_kind("champion").await.unwrap_or_default();
    let runes = db.get_static_catalog_kind("rune").await.unwrap_or_default();
    let abilities = db
        .get_static_catalog_kind("champion_ability")
        .await
        .unwrap_or_default();
    if items.is_empty() && augments.is_empty() && champs.is_empty() && runes.is_empty() && abilities.is_empty() {
        return Ok(());
    }

    for note in &mut patch.patch_notes {
        enrich_one_note(note, &items, &augments, &champs, &runes, &abilities);
    }
    Ok(())
}

fn push_unique(out: &mut Vec<String>, u: String) {
    if u.is_empty() {
        return;
    }
    if !out.contains(&u) {
        out.push(u);
    }
}

fn enrich_one_note(
    note: &mut PatchNoteEntry,
    items: &[StaticCatalogRow],
    augments: &[StaticCatalogRow],
    champs: &[StaticCatalogRow],
    runes: &[StaticCatalogRow],
    abilities: &[StaticCatalogRow],
) {
    let title_lower = note.title.to_lowercase();
    let maps = map_ids_for_category(&note.category);
    let mut candidates: Vec<String> = Vec::new();

    match note.category {
        PatchCategory::ModeArena
        | PatchCategory::ModeAramChaos
        | PatchCategory::ModeAramAugments => {
            let resolved = resolve_augment_title_for_bundle_lookup(&note.title);
            let norm = normalize_augment_lookup_key(&resolved);
            let pool = if matches!(note.category, PatchCategory::ModeArena) {
                "arena"
            } else {
                "mayhem"
            };
            if let Some(ref img) = note.image_url {
                if let Some(row) = augments.iter().find(|r| {
                    augment_row_matches_icon_url(r, img)
                        && augment_row_matches_pool(r, pool)
                        && r.cd_meta
                            .as_ref()
                            .map(|m| cd_meta_allows_maps(m, &maps))
                            .unwrap_or(true)
                }) {
                    if let Some(u) = bundle_icon_for_note(&row.name_en, pool) {
                        push_unique(&mut candidates, u);
                    }
                    for u in urls_from_row(row) {
                        push_unique(&mut candidates, u);
                    }
                }
            }
            if let Some(u) = bundle_icon_via_catalog_bridge(&note.title, pool, augments) {
                push_unique(&mut candidates, u);
            } else if let Some(u) = bundle_icon_for_note(&resolved, pool) {
                push_unique(&mut candidates, u);
            }
            if let Some(row) = best_augment_row(&norm, &maps, augments) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            }
            // Avoid injecting unrelated champion/item/rune icons when augment match already exists.
            if candidates.is_empty() {
                push_mode_catalog_fallbacks(
                    &note.title,
                    &maps,
                    items,
                    champs,
                    runes,
                    &mut candidates,
                );
            }
        }
        PatchCategory::Champions => {
            if let Some(row) = best_champion_match(&note.title, champs) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
                let champion_id = row.stable_id.clone();
                for block in &mut note.details {
                    if block.icon_url.as_deref().is_some_and(|u| !u.trim().is_empty()) {
                        continue;
                    }
                    let Some(title) = block.title.as_deref() else {
                        continue;
                    };
                    if let Some(ability_row) = best_ability_match(abilities, &champion_id, title) {
                        block.icon_url = ability_row
                            .icon_sources
                            .iter()
                            .find_map(|s| s.url.clone());
                    }
                }
            }
        }
        PatchCategory::Runes => {
            if let Some(row) = best_rune_match(&note.title, runes) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            }
        }
        PatchCategory::ItemsRunes => {
            if let Some(row) = best_rune_match(&note.title, runes) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            } else {
                push_item_icons_for_title(&note.title, &maps, items, &mut candidates);
            }
        }
        PatchCategory::ModeAram => {
            push_item_icons_for_title(&note.title, &maps, items, &mut candidates);
            push_mode_catalog_fallbacks(
                &note.title,
                &maps,
                items,
                champs,
                runes,
                &mut candidates,
            );
        }
        PatchCategory::Items | PatchCategory::Modes => {
            if let Some(row) = best_item_row(&title_lower, &maps, items) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            }
        }
        _ => {}
    }

    if let Some(ref u) = note.image_url {
        if !u.is_empty() {
            push_unique(&mut candidates, u.clone());
        }
    }
    if !candidates.is_empty() {
        note.icon_candidates = Some(candidates);
    }
}

fn best_ability_match<'a>(
    abilities: &'a [StaticCatalogRow],
    champion_id: &str,
    title: &str,
) -> Option<&'a StaticCatalogRow> {
    let variants = title_match_variants(title);
    if variants.is_empty() {
        return None;
    }
    abilities.iter().find(|row| {
        let Some(meta_champ) = row
            .cd_meta
            .as_ref()
            .and_then(|m| m.get("champion_id"))
            .and_then(|v| v.as_str())
        else {
            return false;
        };
        if !meta_champ.eq_ignore_ascii_case(champion_id) {
            return false;
        }
        let ru = row.name_ru.to_lowercase();
        let en = row.name_en.to_lowercase();
        variants.iter().any(|v| v == &ru || v == &en)
    })
}
