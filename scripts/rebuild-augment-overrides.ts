import { readFile, writeFile } from "node:fs/promises";
import { wikiAugmentToPlain } from "../src/lib/wiki-augment-plain";

type Pool = "arena" | "mayhem";

type BundledAugmentEntry = {
  title: string;
  tier: string;
  set_label: string;
  description_html: string;
  notes_html?: string | null;
  pool: string;
  riot_augment_id?: string | null;
};

type AugmentsBundledFile = {
  generated_at: string;
  arena: BundledAugmentEntry[];
  mayhem: BundledAugmentEntry[];
};

type OverrideEntry = {
  key: string;
  pool: Pool;
  title_en: string;
  title_ru: string;
  description_en: string;
  description_ru: string;
  notes_en: string;
  notes_ru: string;
  tier_en: string;
  tier_ru: string;
  set_en: string;
  set_ru: string;
  riot_augment_id?: string | null;
};

type CDragonCherryRow = {
  id: number;
  nameTRA: string;
};

const BUNDLE_PATH = "d:/Git/patch-analyzer/src/data/augments-bundled.json";
const OUT_PATH = "d:/Git/patch-analyzer/src/data/augments-ru-overrides.json";
const CDRAGON_RU =
  "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/ru_ru/v1/cherry-augments.json";
const CDRAGON_EN =
  "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json";

const tierMap: Record<string, string> = {
  silver: "Серебряный",
  gold: "Золотой",
  prismatic: "Призматический",
};

const glossaryPost: Array<[RegExp, string]> = [
  [/\bbonus AD\b/gi, "доп. СА"],
  [/\bAD\b/g, "СА"],
  [/\bAP\b/g, "СУ"],
  [/\bAH\b/g, "ускорения способностей"],
  [/\bAS\b/g, "скорости атаки"],
  [/\bon-hit\b/gi, "при попадании"],
  [/\bcritical strike chance\b/gi, "шанса критического удара"],
  [/\bcritical strike\b/gi, "критического удара"],
  [/\bability haste\b/gi, "ускорения способностей"],
  [/\battack speed\b/gi, "скорости атаки"],
  [/\bmovement speed\b/gi, "скорости передвижения"],
  [/\bmagic resist(?:ance)?\b/gi, "сопротивления магии"],
  [/\bphysical damage\b/gi, "физического урона"],
  [/\bmagic damage\b/gi, "магического урона"],
  [/\btrue damage\b/gi, "чистого урона"],
];

const trCache = new Map<string, string>();

function cleanEnText(raw: string): string {
  return String(raw || "")
    .replace(/\b(?:icononly|link=|formula=|label\d*=|type=)\S*/gi, " ")
    .replace(/\.{2,}/g, ". ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function applyPostGlossary(raw: string): string {
  let out = raw;
  glossaryPost.forEach(([re, replacement]) => {
    out = out.replace(re, replacement);
  });
  return out;
}

function cleanRuText(raw: string): string {
  let out = String(raw || "")
    .replace(/\.{2,}/g, ". ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  out = out
    .replace(/\bулучшени[ея]\b/gi, "аугментация")
    .replace(/\bдополнени[ея]\b/gi, "аугментация")
    .replace(/\bэтот аугментация\b/gi, "эта аугментация")
    .replace(/\bэффект пытается предоставить\b/gi, "эффект пытается выдать")
    .replace(/\bПолучите\b/g, "Получаете")
    .replace(/\bВыигрыш\b/g, "Получаете")
    .replace(/\bГранты\b/gi, "Дает")
    .replace(/\bКастинг\b/gi, "Применение")
    .replace(/\bраунд\b/g, "раунда")
    .replace(/\bфазы раундаа\b/gi, "фазы раунда");

  return applyPostGlossary(out);
}

function normalizeSetLabel(raw: string): string {
  return raw
    .replace(/\[\[File:[^\]]+\]\]\s*/gi, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function trToRu(source: string): Promise<string> {
  const input = cleanEnText(source);
  if (!input) return "";
  if (trCache.has(input)) {
    return trCache.get(input)!;
  }

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=${encodeURIComponent(input)}`;

  for (let i = 0; i < 4; i += 1) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const body = await resp.json();
      const translated = Array.isArray(body?.[0]) ? body[0].map((x: unknown[]) => x?.[0] ?? "").join("") : input;
      const cleaned = cleanRuText(translated);
      trCache.set(input, cleaned);
      return cleaned;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
    }
  }

  const fallback = cleanRuText(input);
  trCache.set(input, fallback);
  return fallback;
}

async function fetchCdragonNames(url: string): Promise<Map<string, string>> {
  const resp = await fetch(url);
  if (!resp.ok) return new Map();
  const rows = (await resp.json()) as CDragonCherryRow[];
  const out = new Map<string, string>();
  rows.forEach((row) => {
    out.set(String(row.id), String(row.nameTRA || "").trim());
  });
  return out;
}

async function main(): Promise<void> {
  const bundleRaw = await readFile(BUNDLE_PATH, "utf8");
  const bundle = JSON.parse(bundleRaw) as AugmentsBundledFile;

  const [ruById, enById] = await Promise.all([fetchCdragonNames(CDRAGON_RU), fetchCdragonNames(CDRAGON_EN)]);

  const all: Array<{ pool: Pool; row: BundledAugmentEntry }> = [
    ...bundle.arena.map((row) => ({ pool: "arena" as const, row })),
    ...bundle.mayhem.map((row) => ({ pool: "mayhem" as const, row })),
  ];

  const entries: OverrideEntry[] = [];
  let i = 0;
  for (const { pool, row } of all) {
    i += 1;
    const riotId = row.riot_augment_id ? String(row.riot_augment_id) : null;

    const titleEn = row.title || "";
    const titleRuFromRiot = riotId ? ruById.get(riotId) ?? "" : "";
    const titleEnFromRiot = riotId ? enById.get(riotId) ?? "" : "";

    const descEn = wikiAugmentToPlain(row.description_html || "", { maxChars: 1200 });
    const notesEn = wikiAugmentToPlain(row.notes_html ?? "", { maxChars: 700 });
    const tierEn = row.tier || "";
    const setEn = normalizeSetLabel(row.set_label || "");

    const titleRu = titleRuFromRiot || (await trToRu(titleEn));
    const descriptionRu = await trToRu(descEn);
    const notesRu = notesEn ? await trToRu(notesEn) : "";
    const tierRu = tierMap[tierEn.toLowerCase()] || (await trToRu(tierEn));
    const setRu = setEn ? await trToRu(setEn) : "";

    entries.push({
      key: `${pool}::${titleEn}`,
      pool,
      title_en: titleEnFromRiot || titleEn,
      title_ru: titleRu,
      description_en: descEn,
      description_ru: descriptionRu,
      notes_en: notesEn,
      notes_ru: notesRu,
      tier_en: tierEn,
      tier_ru: tierRu,
      set_en: setEn,
      set_ru: setRu,
      riot_augment_id: riotId,
    });

    if (i % 40 === 0) {
      console.log(`processed ${i}/${all.length}`);
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    source_bundle_generated_at: bundle.generated_at,
    count: entries.length,
    translation_profile: "lol-slang-v3",
    entries,
  };

  await writeFile(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`saved ${entries.length} entries to ${OUT_PATH}`);
}

void main();
