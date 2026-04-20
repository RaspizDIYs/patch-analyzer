use anyhow::Result;

use crate::db::{cd_meta_allows_maps, normalize_augment_lookup_key, Database};
use crate::models::{PatchCategory, PatchData, PatchNoteEntry, StaticCatalogRow};

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
            (title_lower.contains(&ru) || title_lower.contains(&en) || ru.contains(title_lower) || en.contains(title_lower))
                && r.cd_meta
                    .as_ref()
                    .map(|m| cd_meta_allows_maps(m, wanted))
                    .unwrap_or(true)
        })
}

fn augment_pool(meta: Option<&serde_json::Value>) -> Option<&str> {
    meta?.get("pool")?.as_str()
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
    if items.is_empty() && augments.is_empty() && champs.is_empty() && runes.is_empty() {
        return Ok(());
    }

    for note in &mut patch.patch_notes {
        enrich_one_note(note, &items, &augments, &champs, &runes);
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
) {
    let title_lower = note.title.to_lowercase();
    let maps = map_ids_for_category(&note.category);
    let mut candidates: Vec<String> = Vec::new();

    match note.category {
        PatchCategory::ModeArena
        | PatchCategory::ModeAramChaos
        | PatchCategory::ModeAramAugments => {
            let norm = normalize_augment_lookup_key(&note.title);
            if let Some(row) = best_augment_row(&norm, &maps, augments) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            }
        }
        PatchCategory::Champions => {
            if let Some(row) = champs.iter().find(|r| {
                r.name_ru.to_lowercase() == title_lower || r.name_en.to_lowercase() == title_lower
            }) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            }
        }
        PatchCategory::Runes => {
            if let Some(row) = runes.iter().find(|r| {
                r.name_ru.to_lowercase() == title_lower || r.name_en.to_lowercase() == title_lower
            }) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            }
        }
        PatchCategory::ItemsRunes => {
            if let Some(row) = runes.iter().find(|r| {
                r.name_ru.to_lowercase() == title_lower || r.name_en.to_lowercase() == title_lower
            }) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            } else if let Some(row) = best_item_row(&title_lower, &maps, items) {
                for u in urls_from_row(row) {
                    push_unique(&mut candidates, u);
                }
            }
        }
        PatchCategory::ModeAram
        | PatchCategory::Items
        | PatchCategory::Modes => {
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
