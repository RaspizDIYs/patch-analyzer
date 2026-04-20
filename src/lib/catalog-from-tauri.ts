import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type { ItemListItem, RuneListItem } from "@/types/patch";

export interface IconSourceEntry {
  t: string;
  url?: string;
}

export interface StaticCatalogRow {
  kind: string;
  stable_id: string;
  name_ru: string;
  name_en: string;
  riot_augment_id?: string | null;
  cd_meta?: Record<string, unknown> | null;
  icon_sources: IconSourceEntry[];
  source: string;
}

function sourceDisplayUrl(s: IconSourceEntry): string {
  if (!s.url) return "";
  if (s.t === "file" && isTauri()) {
    try {
      return convertFileSrc(s.url);
    } catch {
      return s.url;
    }
  }
  return s.url;
}

function firstUrl(sources: IconSourceEntry[]): string {
  for (const s of sources) {
    const u = sourceDisplayUrl(s);
    if (u) return u;
  }
  return "";
}

export async function fetchItemListFromCatalog(): Promise<ItemListItem[] | null> {
  if (!isTauri()) return null;
  try {
    const rows = await invoke<StaticCatalogRow[]>("get_static_catalog_rows", { kind: "item" });
    if (!rows?.length) return null;
    return rows.map((r) => ({
      id: r.stable_id,
      name: r.name_ru,
      nameEn: r.name_en,
      icon_url: firstUrl(r.icon_sources),
    }));
  } catch {
    return null;
  }
}

export async function fetchItemListForMaps(mapIds: number[]): Promise<ItemListItem[] | null> {
  if (!isTauri()) return null;
  try {
    const rows = await invoke<StaticCatalogRow[]>("get_static_catalog_items_for_maps", {
      map_ids: mapIds,
    });
    if (!rows?.length) return null;
    return rows.map((r) => ({
      id: r.stable_id,
      name: r.name_ru,
      nameEn: r.name_en,
      icon_url: firstUrl(r.icon_sources),
    }));
  } catch {
    return null;
  }
}

export async function fetchRuneListFromCatalog(): Promise<RuneListItem[] | null> {
  if (!isTauri()) return null;
  try {
    const rows = await invoke<StaticCatalogRow[]>("get_static_catalog_rows", { kind: "rune" });
    if (!rows?.length) return null;
    return rows.map((r) => {
      const m = (r.cd_meta ?? {}) as { style?: string; key?: string; id?: number };
      return {
        id: String(m.id ?? r.stable_id),
        name: r.name_ru,
        nameEn: r.name_en,
        icon_url: firstUrl(r.icon_sources),
        key: typeof m.key === "string" ? m.key : "",
        style: typeof m.style === "string" ? m.style : "",
      };
    });
  } catch {
    return null;
  }
}

export async function ensureCatalogLoaded(): Promise<void> {
  if (!isTauri()) return;
  try {
    const meta = await invoke<{ catalog_built_at?: string } | null>("get_game_assets_meta");
    if (!meta?.catalog_built_at) {
      await invoke("refresh_game_assets", { force: false });
    }
  } catch {
    /* ignore */
  }
}

async function fetchItemsRunesFromDDragon(options?: {
  itemsSrPurchasableOnly?: boolean;
}): Promise<{ items: ItemListItem[]; runes: RuneListItem[] }> {
  const verResp = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  const versions: string[] = await verResp.json();
  const latest = versions[0] || "15.23.1";

  const [itemsRuResp, itemsEnResp] = await Promise.all([
    fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/ru_RU/item.json`),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/item.json`),
  ]);
  const itemsRuJson = (await itemsRuResp.json()) as { data?: Record<string, Record<string, unknown>> };
  const itemsEnJson = (await itemsEnResp.json()) as { data?: Record<string, { name?: string }> };

  let entries = Object.entries(itemsRuJson.data ?? {});
  if (options?.itemsSrPurchasableOnly) {
    entries = entries.filter(([, ru]) => {
      const maps = (ru.maps as Record<string, boolean> | undefined) || {};
      const gold = (ru.gold as { purchasable?: boolean } | undefined) || {};
      return maps["11"] && gold.purchasable !== false;
    });
  }

  const items: ItemListItem[] = entries.map(([id, ru]) => {
    const en = itemsEnJson.data?.[id] ?? {};
    return {
      id,
      name: (ru.name as string) ?? "",
      nameEn: (typeof en.name === "string" ? en.name : "") || (ru.name as string) || "",
      icon_url: `https://ddragon.leagueoflegends.com/cdn/${latest}/img/item/${id}.png`,
    };
  });

  const [runesRuResp, runesEnResp] = await Promise.all([
    fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/ru_RU/runesReforged.json`),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/runesReforged.json`),
  ]);
  const runesRuJson = (await runesRuResp.json()) as {
    key?: string;
    slots?: { runes?: { id?: number; name?: string; icon?: string; key?: string }[] }[];
  }[];
  const runesEnJson = (await runesEnResp.json()) as {
    slots?: { runes?: { name?: string }[] }[];
  }[];

  const runes: RuneListItem[] = [];
  runesRuJson.forEach((treeRu, treeIndex) => {
    const treeEn = runesEnJson[treeIndex] || {};
    const styleKey = treeRu.key || "";
    (treeRu.slots || []).forEach((slot, slotIndex) => {
      (slot.runes || []).forEach((runeRu, runeIndex) => {
        const runeEn = (((treeEn.slots || [])[slotIndex] || {}).runes || [])[runeIndex] || {};
        const runeId = runeRu.id ?? `${treeIndex}-${slotIndex}-${runeIndex}`;
        runes.push({
          id: String(runeId),
          name: runeRu.name ?? "",
          nameEn: runeEn.name ?? runeRu.name ?? "",
          icon_url: `https://ddragon.leagueoflegends.com/cdn/img/${runeRu.icon ?? ""}`,
          key: runeRu.key ?? "",
          style: styleKey,
        });
      });
    });
  });

  return { items, runes };
}

export async function loadItemsRunesHybrid(options?: {
  itemsSrPurchasableOnly?: boolean;
}): Promise<{ items: ItemListItem[]; runes: RuneListItem[] }> {
  const fromItems = await fetchItemListFromCatalog();
  const fromRunes = await fetchRuneListFromCatalog();
  if (fromItems?.length && fromRunes?.length) {
    return { items: fromItems, runes: fromRunes };
  }
  const fb = await fetchItemsRunesFromDDragon(options);
  return {
    items: fromItems?.length ? fromItems : fb.items,
    runes: fromRunes?.length ? fromRunes : fb.runes,
  };
}
