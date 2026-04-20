import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"
import { ArrowLeft, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatAppDate } from "@/lib/format-date"
import { loadAppPreferences } from "@/lib/app-preferences"
import type { MayhemAugmentation, MayhemAugmentationsPayload } from "@/types/mayhem"
import { cleanUrl } from "@/lib/patch-utils"
import { cn } from "@/lib/utils"
import type { IconSourceEntry, StaticCatalogRow } from "@/lib/catalog-from-tauri"

function normAugKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04FF]+/g, " ")
    .trim()
    .split(/\s+/)
    .join(" ")
}

function matchStaticAugment(
  row: MayhemAugmentation,
  rows: StaticCatalogRow[],
): StaticCatalogRow | undefined {
  const k = normAugKey(row.title)
  if (!k) return undefined
  return rows.find((r) => {
    const en = normAugKey(r.name_en)
    const ru = normAugKey(r.name_ru)
    return en === k || ru === k
  })
}

function iconUrlsForRow(row: MayhemAugmentation, cat: StaticCatalogRow | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (u: string | undefined) => {
    if (!u?.trim()) return
    if (seen.has(u)) return
    seen.add(u)
    out.push(u)
  }
  if (cat?.icon_sources?.length) {
    for (const s of cat.icon_sources) {
      const src = sourceToUrl(s)
      push(src)
    }
  }
  if (row.icon_url) {
    push(cleanUrl(row.icon_url) ?? row.icon_url)
  }
  return out
}

function sourceToUrl(s: IconSourceEntry): string {
  if (!s.url) return ""
  if (s.t === "file" && isTauri()) {
    try {
      return convertFileSrc(s.url)
    } catch {
      return s.url
    }
  }
  return s.url
}

function AugmentIcon({ urls, label }: { urls: string[]; label: string }) {
  const [idx, setIdx] = useState(0)
  const u = urls[idx]
  if (!u) {
    return (
      <div
        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-xs font-medium text-muted-foreground"
        title={label}
      >
        ?
      </div>
    )
  }
  return (
    <img
      src={u}
      alt=""
      className="h-16 w-16 shrink-0 rounded-md border border-border/40 bg-muted/30 object-contain"
      loading="lazy"
      onError={() => setIdx((i) => i + 1)}
    />
  )
}

export function AugmentsPage() {
  const { t, i18n } = useTranslation()
  const dateFmt = loadAppPreferences().dateFormat
  const locale = i18n.language?.startsWith("en") ? "en" : "ru"
  const [data, setData] = useState<MayhemAugmentationsPayload | null>(null)
  const [staticAugments, setStaticAugments] = useState<StaticCatalogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const autoRefreshTried = useRef(false)

  const load = useCallback(async () => {
    if (!isTauri()) {
      setLoading(false)
      setErr("__WEB_ONLY__")
      return
    }
    setErr(null)
    try {
      const [p, augRows] = await Promise.all([
        invoke<MayhemAugmentationsPayload>("get_mayhem_augmentations_page", {
          locale,
        }),
        invoke<StaticCatalogRow[]>("get_static_catalog_rows", { kind: "augment" }).catch(() => [] as StaticCatalogRow[]),
      ])
      setData(p)
      setStaticAugments(Array.isArray(augRows) ? augRows : [])
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [locale])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!isTauri() || loading || refreshing || autoRefreshTried.current) return
    if (data == null) return
    if (data.entries.length !== 0) return
    autoRefreshTried.current = true
    setRefreshing(true)
    setErr(null)
    invoke("refresh_mayhem_augmentations_from_wiki")
      .then(() => load())
      .catch((e) => setErr(String(e)))
      .finally(() => setRefreshing(false))
  }, [loading, data, load, refreshing])

  async function onRefresh() {
    if (!isTauri()) return
    setRefreshing(true)
    setErr(null)
    try {
      await invoke("refresh_mayhem_augmentations_from_wiki")
      await load()
    } catch (e) {
      setErr(String(e))
    } finally {
      setRefreshing(false)
    }
  }

  const filtered = useMemo(() => {
    const entries = data?.entries ?? []
    const s = q.trim().toLowerCase()
    if (!s) return entries
    return entries.filter((row) => {
      const tier = row.tier.toLowerCase()
      const setL = row.set_label.toLowerCase()
      const title = row.title.toLowerCase()
      const effect = row.effect_html.replace(/<[^>]+>/g, " ").toLowerCase()
      return (
        title.includes(s) ||
        tier.includes(s) ||
        setL.includes(s) ||
        effect.includes(s)
      )
    })
  }, [data?.entries, q])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button type="button" variant="ghost" size="sm" className="mb-2 gap-2 px-0" asChild>
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
              {t("settings.back")}
            </Link>
          </Button>
          <h2 className="text-xl font-semibold tracking-tight">{t("augments.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("augments.subtitle")}</p>
          {data?.fetched_at ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("augments.updated", {
                date: formatAppDate(data.fetched_at, dateFmt, i18n.language),
              })}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={!isTauri() || refreshing}
          onClick={() => void onRefresh()}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden />
          {t("augments.refreshWiki")}
        </Button>
      </div>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="text-base">{t("augments.tableTitle")}</CardTitle>
          <CardDescription>{t("augments.tableHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {!loading && err === "__WEB_ONLY__" && (
            <p className="text-sm text-muted-foreground">{t("augments.tauriOnly")}</p>
          )}
          {!loading && err && err !== "__WEB_ONLY__" && (
            <p className="text-sm text-destructive">{err}</p>
          )}
          {!loading && !err && data && data.entries.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("augments.empty")}</p>
          )}
          {!loading && !err && data && data.entries.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative max-w-md flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("augments.searchPlaceholder")}
                    className="pl-9"
                    aria-label={t("augments.searchPlaceholder")}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("augments.shownCount", { n: filtered.length, total: data.entries.length })}
                </p>
              </div>
              <div className="overflow-x-auto rounded-md border border-border/50">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[88px]">{t("augments.colIcon")}</TableHead>
                      <TableHead className="min-w-[160px]">{t("augments.colName")}</TableHead>
                      <TableHead className="min-w-[280px]">{t("augments.colEffect")}</TableHead>
                      <TableHead className="w-[120px]">{t("augments.colTier")}</TableHead>
                      <TableHead className="min-w-[160px]">{t("augments.colSet")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((row: MayhemAugmentation) => {
                      const cat = matchStaticAugment(row, staticAugments)
                      const iconUrls = iconUrlsForRow(row, cat)
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="align-top">
                            <AugmentIcon urls={iconUrls} label={row.title} />
                          </TableCell>
                          <TableCell className="align-top">
                            <span className="font-medium leading-snug text-foreground">{row.title}</span>
                          </TableCell>
                          <TableCell className="align-top text-sm">
                            {row.effect_html.trim() ? (
                              <div
                                className="max-w-none text-sm leading-relaxed text-foreground [&_a]:text-primary [&_a]:underline [&_img]:inline [&_img]:max-h-8 [&_img]:align-middle"
                                dangerouslySetInnerHTML={{ __html: row.effect_html }}
                              />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            {row.tier.trim() ? (
                              <Badge variant="secondary" className="whitespace-nowrap font-normal">
                                {row.tier}
                              </Badge>
                            ) : (
                              <span className="text-sm text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex items-center gap-2 text-sm">
                              {row.set_icon_url ? (
                                <img
                                  src={cleanUrl(row.set_icon_url) ?? row.set_icon_url}
                                  alt=""
                                  className="h-8 w-8 shrink-0 rounded object-contain"
                                  loading="lazy"
                                />
                              ) : null}
                              <span className={cn(!row.set_label.trim() && "text-muted-foreground")}>
                                {row.set_label.trim() || "—"}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              {filtered.length === 0 && q.trim() && (
                <p className="text-sm text-muted-foreground">{t("augments.noSearchResults")}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
