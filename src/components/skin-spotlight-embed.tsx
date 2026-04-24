import { useEffect, useMemo, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import type { YoutubeFeedItem } from "@/types/youtube"
import type { ChampionListItem } from "@/types/patch"
import type { SkinSpotlightResolveResult } from "@/types/youtube"
import {
  buildSkinSpotlightMatchNeedles,
  buildSkinSpotlightYoutubeSearch,
  pickBestVideoForNeedles,
} from "@/lib/youtube-match"
import { YOUTUBE_CHANNEL_SKINSPOTLIGHTS } from "@/lib/youtube-channels"
import { Skeleton } from "@/components/ui/skeleton"

export function SkinSpotlightEmbed({
  feed,
  noteTitle,
  champions,
  searchUrl,
  searchLabel,
}: {
  feed: YoutubeFeedItem[]
  noteTitle: string
  champions: ChampionListItem[]
  searchUrl: string
  searchLabel: string
}) {
  const needles = useMemo(
    () => buildSkinSpotlightMatchNeedles(noteTitle, champions),
    [noteTitle, champions],
  )
  const rssBest = useMemo(
    () => pickBestVideoForNeedles(feed, needles),
    [feed, needles],
  )
  const ytSearch = useMemo(
    () => buildSkinSpotlightYoutubeSearch(noteTitle, champions),
    [noteTitle, champions],
  )

  const [api, setApi] = useState<{ id: string; title: string } | null>(null)
  const [resolved, setResolved] = useState(() => !isTauri())

  useEffect(() => {
    if (!isTauri() || !ytSearch) {
      setResolved(true)
      setApi(null)
      return
    }
    let cancelled = false
    setResolved(false)
    setApi(null)
    void invoke<SkinSpotlightResolveResult>("resolve_skin_spotlight_video", {
      cacheKey: ytSearch.cacheKey,
      searchQuery: ytSearch.searchQuery,
      channelId: YOUTUBE_CHANNEL_SKINSPOTLIGHTS,
    })
      .then((r) => {
        if (cancelled) return
        const bad = r.source.startsWith("error")
        if (r.video_id && !bad) {
          setApi({ id: r.video_id, title: r.video_title ?? "" })
        }
      })
      .catch(() => {
        /* RSS fallback */
      })
      .finally(() => {
        if (!cancelled) setResolved(true)
      })
    return () => {
      cancelled = true
    }
  }, [ytSearch])

  const videoId = api?.id ?? (resolved ? rssBest?.video_id : undefined)
  const videoUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : searchUrl

  if (!resolved) {
    return (
      <div className="mt-4 max-w-xl space-y-2">
        <Skeleton className="aspect-video w-full rounded-lg" />
      </div>
    )
  }

  if (!videoId) {
    return (
      <p className="text-xs text-muted-foreground">
        <a href={searchUrl} target="_blank" rel="noopener noreferrer" className="underline">
          {searchLabel}
        </a>
      </p>
    )
  }

  return (
    <div className="mt-4 max-w-xl rounded-lg border border-border/50 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="truncate">{api?.title ?? rssBest?.title ?? noteTitle}</span>
        <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="underline">
          {searchLabel}
        </a>
      </div>
    </div>
  )
}
