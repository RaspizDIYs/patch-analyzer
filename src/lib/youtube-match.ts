import type { YoutubeFeedItem } from "@/types/youtube"
import type { ChampionListItem } from "@/types/patch"

export const YOUTUBE_LINE_MATCH_MIN_SCORE = 4

const CHROMA_HINT = /\bchroma\b|хром|цветов/i

const RU_SKIN_LINE_REPLACEMENTS: [RegExp, string][] = [
  [/Пси[-\s]?отряд/gi, "PsyOps"],
  [/Проект/gi, "PROJECT"],
  [/Космический\s+ритм/gi, "Space Groove"],
  [/\bиз\b/gi, " "],
  [/цветовые\s+схемы/gi, ""],
  [/\([^)]*хром[^)]*\)/gi, ""],
  [/\s*[|]\s*[^|]+$/g, ""],
]

function buildFallbackLatinSkinLine(title: string, champions: ChampionListItem[]): string {
  const parts: string[] = []
  const sorted = [...champions].sort((a, b) => b.name.length - a.name.length)
  for (const c of sorted) {
    const ru = c.name?.trim() ?? ""
    const en = c.name_en?.trim() ?? ""
    if (ru.length >= 2 && title.includes(ru) && en.length >= 2) {
      parts.push(en)
    }
  }
  const latin = title.match(/[A-Za-z][A-Za-z0-9:'’\u2019\s:+.-]{2,}/g) ?? []
  for (const x of latin) {
    const t = x.trim()
    if (t.length >= 3) parts.push(t)
  }
  return [...new Set(parts)].join(" ").replace(/\s+/g, " ").trim()
}

/** Запрос для YouTube Data API (search + channelId SkinSpotlights); RU/EN патчноуты дают один cacheKey при том же скине. */
export function buildSkinSpotlightYoutubeSearch(
  skinTitle: string,
  champions: ChampionListItem[],
): { cacheKey: string; searchQuery: string } | null {
  const isChroma = CHROMA_HINT.test(skinTitle)
  let line = skinTitle.trim()
  if (line.length < 2) return null

  const sorted = [...champions].sort((a, b) => b.name.length - a.name.length)
  for (const c of sorted) {
    const ru = c.name?.trim() ?? ""
    const en = c.name_en?.trim() ?? ""
    if (ru.length >= 2 && line.includes(ru) && en.length >= 2) {
      line = line.split(ru).join(en)
    }
  }

  for (const [re, rep] of RU_SKIN_LINE_REPLACEMENTS) {
    line = line.replace(re, rep)
  }

  line = line.replace(/\s+/g, " ").trim()

  if (/[\u0400-\u04FF]/.test(line)) {
    const fb = buildFallbackLatinSkinLine(skinTitle, champions)
    if (fb.length >= 4) line = fb
  }

  line = line.replace(/\s+/g, " ").trim()
  if (line.length < 3) return null

  const searchQuery = isChroma ? `${line} Chroma Skin Spotlight` : `${line} Skin Spotlight`
  const cacheKey = searchQuery.toLowerCase().split(/\s+/).join(" ").trim()
  if (cacheKey.length < 4) return null
  return { cacheKey, searchQuery }
}

const SKIN_BROWSE_RE = /\b(skin|chroma|preview|spotlight|splash)\b/i

export function preferSkinSpotlightsBrowseOrder(items: YoutubeFeedItem[]): YoutubeFeedItem[] {
  const tagged = items.filter((v) => SKIN_BROWSE_RE.test(v.title))
  const base = tagged.length > 0 ? tagged : items
  return [...base].sort((a, b) => b.published.localeCompare(a.published))
}

/** Иглы для матча RU/EN заголовков скина с англ. названиями роликов SkinSpotlights. */
export function buildSkinSpotlightMatchNeedles(
  skinTitle: string,
  champions: ChampionListItem[],
): string[] {
  const t = skinTitle.trim()
  const out = new Set<string>()
  if (t.length >= 2) out.add(t)

  const lower = t.toLowerCase()
  for (const c of champions) {
    const ru = c.name?.trim() ?? ""
    const en = c.name_en?.trim() ?? ""
    if (ru.length >= 2 && t.includes(ru)) {
      if (en.length >= 2) out.add(en)
      out.add(ru)
    }
    if (en.length >= 2 && (lower.includes(en.toLowerCase()) || t.includes(en))) {
      out.add(en)
    }
  }

  for (const part of t.split(/[|—–]/)) {
    const p = part.trim()
    if (p.length >= 3) out.add(p)
  }

  for (const m of t.match(/[A-Za-z][A-Za-z0-9:+.'’\u2019-]{2,}/g) ?? []) {
    if (m.length >= 3) out.add(m)
  }

  return [...out].map((s) => s.trim()).filter((s) => s.length >= 2)
}

/** Лучший ролик по набору игл; без достаточного совпадения не показываем embed (никакого «одного видео на всех»). */
export function pickBestVideoForNeedles(
  items: YoutubeFeedItem[],
  needles: string[],
): YoutubeFeedItem | undefined {
  const clean = needles.map((s) => s.trim()).filter((s) => s.length >= 2)
  if (clean.length === 0 || items.length === 0) return undefined
  let best: YoutubeFeedItem | undefined
  let bestScore = -1
  for (const v of items) {
    const s = scoreVideoAgainstTitles(v.title, clean)
    if (s > bestScore) {
      bestScore = s
      best = v
    }
  }
  if (!best || bestScore < YOUTUBE_LINE_MATCH_MIN_SCORE) return undefined
  return best
}

export function scoreVideoAgainstTitles(videoTitle: string, needles: string[]): number {
  if (needles.length === 0) return 0
  const t = videoTitle.toLowerCase()
  let s = 0
  for (const raw of needles) {
    const w = raw.trim().toLowerCase()
    if (w.length < 3) continue
    if (t.includes(w)) s += 4
    for (const p of w.split(/\s+/)) {
      if (p.length > 2 && t.includes(p)) s += 1
    }
  }
  return s
}

export function sortVideosByTitleMatch(items: YoutubeFeedItem[], needles: string[]): YoutubeFeedItem[] {
  if (needles.length === 0) return items
  return [...items].sort((a, b) => {
    const da = scoreVideoAgainstTitles(a.title, needles)
    const db = scoreVideoAgainstTitles(b.title, needles)
    if (db !== da) return db - da
    return b.published.localeCompare(a.published)
  })
}

export function preferRelevantFeedVideos(
  items: YoutubeFeedItem[],
  needles: string[],
  minScore: number,
): YoutubeFeedItem[] {
  if (needles.length === 0) return items
  const scored = sortVideosByTitleMatch(items, needles)
  const filtered = scored.filter((v) => scoreVideoAgainstTitles(v.title, needles) >= minScore)
  if (filtered.length > 0) return filtered
  return scored
}
