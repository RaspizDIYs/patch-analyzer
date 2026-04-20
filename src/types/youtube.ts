export interface YoutubeFeedItem {
  video_id: string
  title: string
  published: string
  thumbnail_url: string
}

export interface SkinSpotlightResolveResult {
  video_id: string | null
  video_title: string | null
  source: string
}
