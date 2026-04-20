export interface MayhemAugmentation {
  id: string
  title: string
  icon_url: string | null
  effect_html: string
  tier: string
  set_label: string
  set_icon_url: string | null
}

export interface MayhemAugmentationsPayload {
  entries: MayhemAugmentation[]
  fetched_at: string | null
}
