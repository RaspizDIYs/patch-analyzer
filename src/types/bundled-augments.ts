export interface BundledAugmentEntry {
  title: string
  tier: string
  set_label: string
  description_html: string
  notes_html?: string | null
  icon_url?: string | null
  pool: string
  riot_augment_id?: string | null
}

export interface AugmentsBundledFile {
  generated_at: string
  arena: BundledAugmentEntry[]
  mayhem: BundledAugmentEntry[]
}
