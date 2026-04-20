import { useCallback, useEffect, useMemo, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import type { YoutubeFeedItem } from "@/types/youtube"
import { cn } from "@/lib/utils"
import {
  preferRelevantFeedVideos,
  preferSkinSpotlightsBrowseOrder,
  scoreVideoAgainstTitles,
  YOUTUBE_LINE_MATCH_MIN_SCORE,
} from "@/lib/youtube-match"
import { YOUTUBE_CHANNEL_SKINSPOTLIGHTS } from "@/lib/youtube-channels"

async function openUrlSafe(url: string) {
  if (isTauri()) {
    try {
      await openUrl(url)
      return
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer")
}

export function YoutubeChannelPanel({
  channelId,
  channelPageUrl,
  heading,
  matchTitles,
  feedItems: feedItemsProp,
  className,
}: {
  channelId: string
  channelPageUrl: string
  heading?: string
  matchTitles?: string[]
  /** Если задан — не дергаем RSS, используем готовый фид (например из родителя). */
  feedItems?: YoutubeFeedItem[]
  className?: string
}) {
  const { t } = useTranslation()
  const [items, setItems] = useState<YoutubeFeedItem[]>([])
  const [loading, setLoading] = useState(() => feedItemsProp === undefined)
  const [err, setErr] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (feedItemsProp !== undefined) {
      setItems(feedItemsProp)
      setLoading(false)
      setErr(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setErr(null)
    if (!isTauri()) {
      setLoading(false)
      setErr("__WEB_ONLY__")
      return () => {
        cancelled = true
      }
    }
    void invoke<YoutubeFeedItem[]>("fetch_youtube_feed", { channelId })
      .then((list) => {
        if (!cancelled) {
          setItems(list)
          setSelectedId(list[0]?.video_id ?? null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channelId, feedItemsProp])

  const sorted = useMemo(() => {
    const needles = matchTitles ?? []
    let base = items
    if (needles.length === 0 && channelId === YOUTUBE_CHANNEL_SKINSPOTLIGHTS) {
      base = preferSkinSpotlightsBrowseOrder(base)
    }
    return preferRelevantFeedVideos(base, needles, YOUTUBE_LINE_MATCH_MIN_SCORE)
  }, [items, matchTitles, channelId])

  useEffect(() => {
    if (sorted.length === 0) {
      setSelectedId(null)
      return
    }
    setSelectedId((prev) => {
      if (prev && sorted.some((x) => x.video_id === prev)) return prev
      return sorted[0].video_id
    })
  }, [sorted])

  const selected = sorted.find((x) => x.video_id === selectedId) ?? sorted[0]

  const openWatch = useCallback(async (videoId: string) => {
    await openUrlSafe(`https://www.youtube.com/watch?v=${videoId}`)
  }, [])

  return (
    <Card className={cn("overflow-hidden border-border/60", className)}>
      {(heading || channelPageUrl) && (
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
          {heading ? <CardTitle className="text-base font-semibold">{heading}</CardTitle> : <div />}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void openUrlSafe(channelPageUrl)}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            {t("community.openChannel")}
          </Button>
        </CardHeader>
      )}
      <CardContent className="space-y-4 pt-0">
        {loading && (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <Skeleton className="aspect-video w-full rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        )}
        {!loading && err && (
          <p className="text-sm text-destructive">
            {err === "__WEB_ONLY__" ? t("community.youtubeTauriOnly") : err}
          </p>
        )}
        {!loading && !err && sorted.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("community.noVideos")}</p>
        )}
        {!loading && !err && sorted.length > 0 && selected && (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
              <div className="relative aspect-video w-full">
                <iframe
                  title={selected.title}
                  className="absolute inset-0 h-full w-full"
                  src={`https://www.youtube.com/embed/${selected.video_id}`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              </div>
            </div>
            <ScrollArea className="h-[min(52vh,420px)] pr-3">
              <ul className="space-y-1.5">
                {sorted.map((v) => {
                  const matchScore = matchTitles?.length
                    ? scoreVideoAgainstTitles(v.title, matchTitles)
                    : 0
                  return (
                    <li key={v.video_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(v.video_id)}
                        className={cn(
                          "flex w-full gap-3 rounded-lg border p-2 text-left transition-colors",
                          v.video_id === selected.video_id
                            ? "border-primary/50 bg-primary/5"
                            : "border-transparent hover:bg-muted/50",
                        )}
                      >
                        <img
                          src={v.thumbnail_url}
                          alt=""
                          className="h-14 w-24 shrink-0 rounded object-cover"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-sm font-medium leading-snug">{v.title}</span>
                          {matchScore > 0 && (
                            <span className="mt-0.5 block text-[10px] text-muted-foreground">
                              {t("community.matchHint")}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
          </div>
        )}
        {!loading && !err && selected && (
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => void openWatch(selected.video_id)}>
              {t("community.openInBrowser")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
