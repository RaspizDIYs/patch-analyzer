export interface PatchData {
  version: string
  patch_notes: PatchNoteEntry[]
  /** og:image со страницы патч-нотов (баннер статьи) */
  banner_url?: string | null
  /** "ru" | "en" — регион источника patch notes (riot ru-ru / en-gb) */
  patch_notes_locale?: string | null
}

export interface ChangeBlock {
  title: string | null
  icon_url: string | null
  changes: string[]
}

export interface PatchNoteEntry {
  id: string
  title: string
  image_url?: string
  category: string
  change_type: string
  summary: string
  details: ChangeBlock[]
  /** Приоритетные URL иконок из каталога (Rust) */
  icon_candidates?: string[]
}

export interface MetaAnalysisDiff {
  champion_name: string
  role: string
  win_rate_diff: number
  pick_rate_diff: number
  predicted_change: string | null
  champion_image_url?: string
}

export interface ChampionHistoryEntry {
  patch_version: string
  date: string
  change: PatchNoteEntry
}

export interface ChampionListItem {
  name: string
  name_en: string
  icon_url: string
  key: string
  id: string
}

export interface RuneListItem {
  id: string
  name: string
  nameEn: string
  icon_url: string
  key?: string
  style?: string
}

export interface ItemListItem {
  id: string
  name: string
  nameEn: string
  icon_url: string
}

export interface LogEntry {
  level: string
  message: string
  timestamp: string
}

export interface TierEntry {
  name: string
  category: string
  buffs: number
  nerfs: number
  adjusted: number
  icon_url?: string | null
}

export type ChangeTrend = "up" | "down" | "neutral"

export type ThemeOption = "light" | "dark" | "system"
