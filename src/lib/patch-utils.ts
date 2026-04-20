import type { TFunction } from "i18next";

/** Совпадает с db::WIKI_AUGMENT_DETAIL_TITLE (Rust). */
export const WIKI_AUGMENT_DETAIL_TITLE = "League Wiki"

export const PATCH_NOTE_CATEGORY_TAB_ORDER: readonly string[] = [
  "NewContent",
  "UpcomingSkinsChromas",
  "Champions",
  "Items",
  "Runes",
  "ItemsRunes",
  "ModeAramChaos",
  "ModeAram",
  "ModeArena",
  "Modes",
  "Systems",
  "Skins",
  "Cosmetics",
  "BugFixes",
  "Unknown",
]

export function patchNoteCategoryLabel(category: string, t: TFunction): string {
  return String(t(`patchCategory.${category}`, { defaultValue: category }));
}

/** DDragon major.minor → маркетинг: 15.x→25.x, 16.x→26.x (major +10 при major >= 15) */
export function ddragonPairToDisplayLabel(major: number, minor: number): string {
  const m = major >= 15 ? major + 10 : major
  return `${m}.${minor}`
}

/** Обратно: 25.x→15.x, 26.x→16.x (при major >= 25 вычитаем 10) */
export function displayPatchToDdragonMajorMinor(display: string): { major: number; minor: number } | null {
  const [a, b] = display.trim().split(".")
  const maj = parseInt(a, 10)
  const min = parseInt(b, 10)
  if (Number.isNaN(maj) || Number.isNaN(min)) return null
  const ddMaj = maj >= 25 ? maj - 10 : maj
  return { major: ddMaj, minor: min }
}

export function cleanUrl(url?: string | null) {
  if (!url) return undefined
  const u = url.trim()
  if (u.startsWith("//")) {
    return `https:${u}`
  }
  if (u.startsWith("/") && u.length > 1) {
    return `https://wiki.leagueoflegends.com${u}`
  }
  if (u.includes("akamaihd.net") && u.includes("?f=")) {
    try {
      return u.split("?f=")[1]
    } catch {
      return u
    }
  }
  return u
}

export function highlightSpecialTags(text: string): string {
  text = text.replace(
    /(НОВОЕ|Новое|NEW)/g,
    '<span class="inline px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold text-[11px] align-middle dark:bg-emerald-950 dark:text-emerald-300">$1</span>'
  )
  text = text.replace(
    /(УДАЛЕНО|Удалено|REMOVED)/g,
    '<span class="inline px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold text-[11px] align-middle dark:bg-red-950 dark:text-red-300">$1</span>'
  )
  return text
}

export function analyzeChangeTrend(text: string): "up" | "down" | "neutral" {
  const lower = text.toLowerCase()

  if (
    lower.includes("удалено") ||
    lower.includes("removed") ||
    (lower.includes("больше не") &&
      !lower.includes("больше не уменьшается") &&
      !lower.includes("no longer reduced"))
  ) {
    return "down"
  }

  if (lower.includes("больше не уменьшается") || lower.includes("no longer reduced"))
    return "up"

  const isInverse =
    lower.includes("перезарядка") ||
    lower.includes("cooldown") ||
    lower.includes("стоимость") ||
    lower.includes("cost") ||
    lower.includes("mana") ||
    lower.includes("маны") ||
    lower.includes("energy") ||
    lower.includes("энергии") ||
    lower.includes("затраты") ||
    lower.includes("время") ||
    lower.includes("time")

  const parts = text.split(/\s*(?:→|⇒|->)\s*/)
  if (parts.length === 2) {
    const parseVal = (str: string) => {
      const nums = (str.match(/[-+]?\d+(?:[.,]\d+)?/g) || []).map((s) =>
        parseFloat(s.replace(",", "."))
      )
      if (nums.length === 0) return NaN
      return nums.reduce((a, b) => a + b, 0)
    }

    const from = parseVal(parts[0])
    const to = parseVal(parts[1])

    if (!isNaN(from) && !isNaN(to)) {
      if (to > from) return isInverse ? "down" : "up"
      if (to < from) return isInverse ? "up" : "down"
    }
  }

  if (
    lower.includes("увеличен") ||
    lower.includes("усилен") ||
    lower.includes("increased") ||
    lower.includes("buffed") ||
    lower.includes("new effect") ||
    lower.includes("новый эффект")
  )
    return "up"
  if (
    lower.includes("уменьшен") ||
    lower.includes("ослаблен") ||
    lower.includes("decreased") ||
    lower.includes("nerfed") ||
    lower.includes("removed") ||
    lower.includes("удалено")
  )
    return "down"

  return "neutral"
}

export function compareVersions(v1: string, v2: string) {
  const parse = (v: string) =>
    v.split(".").map((n) => parseInt(n, 10)).filter((n) => !isNaN(n))
  const p1 = parse(v1)
  const p2 = parse(v2)
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const n1 = p1[i] || 0
    const n2 = p2[i] || 0
    if (n1 !== n2) return n1 - n2
  }
  return 0
}
