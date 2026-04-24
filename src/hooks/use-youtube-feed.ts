import { useEffect, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import type { YoutubeFeedItem } from "@/types/youtube"

export function useYoutubeFeed(channelId: string | null) {
  const [items, setItems] = useState<YoutubeFeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!channelId) {
      setItems([])
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
        if (!cancelled) setItems(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setItems([])
          setErr(String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channelId])

  return { items, loading, err }
}
