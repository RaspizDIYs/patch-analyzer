import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"
import { ArrowLeft, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { cleanUrl } from "@/lib/patch-utils"
import { wikiAugmentToPlain } from "@/lib/wiki-augment-plain"
import { cn } from "@/lib/utils"
import type { IconSourceEntry, StaticCatalogRow } from "@/lib/catalog-from-tauri"
import type { AugmentsBundledFile, BundledAugmentEntry } from "@/types/bundled-augments"

type BundleLoad = "loading" | "ready" | "error"

type PoolTab = "arena" | "mayhem"
type SortField = "name" | "tier" | null
type SortDirection = "asc" | "desc"

function augmentSetOneChunk(s: string): string {
  let t = s.trim()
  if (!t || t === "-") return ""
  t = t.replace(/\[\[File:[^\]]+\]\]\s*/gi, "")
  const piped = t.match(/\[\[[^\]]*\|([^\]]+)\]\]/)
  if (piped?.[1]) {
    return piped[1].replace(/_/g, " ").trim()
  }
  const simple = t.match(/\[\[([^\]]+)\]\]/)
  if (simple?.[1]) {
    const tail = simple[1].split("|").pop() ?? simple[1]
    return tail.replace(/_/g, " ").trim()
  }
  return t
}

function augmentSetDisplay(raw: string): string {
  const s = raw.trim()
  if (!s || s === "-") return ""
  const chunks = s.split(/<br\s*\/?>/i)
  const parts = chunks.map((c) => augmentSetOneChunk(c)).filter(Boolean)
  return parts.length ? parts.join(" · ") : augmentSetOneChunk(s)
}

function normAugKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04FF]+/g, " ")
    .trim()
    .split(/\s+/)
    .join(" ")
}

function augmentTierRank(tier: string): number {
  const key = tier.trim().toLowerCase()
  if (key === "prismatic") return 3
  if (key === "gold") return 2
  if (key === "silver") return 1
  return 0
}

function matchStaticAugment(
  row: BundledAugmentEntry,
  pool: PoolTab,
  rows: StaticCatalogRow[],
): StaticCatalogRow | undefined {
  const k = normAugKey(row.title)
  if (!k) return undefined
  return rows.find((r) => {
    const en = normAugKey(r.name_en)
    const ru = normAugKey(r.name_ru)
    if (en !== k && ru !== k) return false
    const raw = r.cd_meta?.pool
    const metaPool = typeof raw === "string" ? raw : ""
    if (metaPool && metaPool !== "unknown" && metaPool !== pool) {
      return false
    }
    return true
  })
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

function iconUrlsForRow(row: BundledAugmentEntry, cat: StaticCatalogRow | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (u: string | undefined) => {
    if (!u?.trim()) return
    if (seen.has(u)) return
    seen.add(u)
    out.push(u)
  }
  if (row.icon_url) {
    push(cleanUrl(row.icon_url) ?? row.icon_url)
  }
  if (cat?.icon_sources?.length) {
    for (const s of cat.icon_sources) {
      push(sourceToUrl(s))
    }
  }
  return out
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
  const [bundle, setBundle] = useState<AugmentsBundledFile | null>(null)
  const [bundleStatus, setBundleStatus] = useState<BundleLoad>("loading")
  const [pool, setPool] = useState<PoolTab>("arena")
  const [staticAugments, setStaticAugments] = useState<StaticCatalogRow[]>([])
  const [q, setQ] = useState("")
  const [sortField, setSortField] = useState<SortField>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc")
  const showSetColumn = pool === "mayhem"
  const nameCollator = useMemo(
    () =>
      new Intl.Collator(i18n.resolvedLanguage === "ru" ? "ru" : "en", {
        sensitivity: "base",
        numeric: true,
      }),
    [i18n.resolvedLanguage],
  )

  const loadCatalog = useCallback(async () => {
    if (!isTauri()) return
    try {
      const augRows = await invoke<StaticCatalogRow[]>("get_static_catalog_rows", {
        kind: "augment",
      })
      setStaticAugments(Array.isArray(augRows) ? augRows : [])
    } catch {
      setStaticAugments([])
    }
  }, [])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  useEffect(() => {
    let cancelled = false
    setBundleStatus("loading")
    void import("@/data/augments-bundled.json")
      .then((m: { default: AugmentsBundledFile }) => {
        if (cancelled) return
        setBundle(m.default)
        setBundleStatus("ready")
      })
      .catch(() => {
        if (cancelled) return
        setBundleStatus("error")
      })
    return () => {
      cancelled = true
    }
  }, [])

  const entries = useMemo(() => {
    if (!bundle) return []
    return pool === "arena" ? bundle.arena : bundle.mayhem
  }, [bundle, pool])

  const filteredSorted = useMemo(() => {
    const rows = entries.map((row) => {
      const cat = matchStaticAugment(row, pool, staticAugments)
      const localizedTitle =
        i18n.resolvedLanguage === "ru" && cat?.name_ru.trim() ? cat.name_ru : row.title
      return {
        row,
        cat,
        localizedTitle,
        titleRu: cat?.name_ru.toLowerCase() ?? "",
        titleEn: cat?.name_en.toLowerCase() ?? "",
      }
    })

    const s = q.trim().toLowerCase()
    const filtered = s
      ? rows.filter(({ row, titleRu, titleEn }) => {
        const tier = row.tier.toLowerCase()
        const setL = showSetColumn
          ? `${augmentSetDisplay(row.set_label)} ${row.set_label}`.toLowerCase()
          : ""
        const title = row.title.toLowerCase()
        const effect = wikiAugmentToPlain(row.description_html).toLowerCase()
        const notes = wikiAugmentToPlain(row.notes_html ?? "").toLowerCase()
        return (
          title.includes(s) ||
          titleRu.includes(s) ||
          titleEn.includes(s) ||
          tier.includes(s) ||
          (showSetColumn && setL.includes(s)) ||
          effect.includes(s) ||
          notes.includes(s)
        )
      })
      : rows

    if (!sortField) return filtered
    return [...filtered].sort((a, b) => {
      if (sortField === "name") {
        const cmp = nameCollator.compare(a.localizedTitle, b.localizedTitle)
        return sortDirection === "asc" ? cmp : -cmp
      }
      const tierA = augmentTierRank(a.row.tier)
      const tierB = augmentTierRank(b.row.tier)
      if (tierA !== tierB) {
        return sortDirection === "asc" ? tierA - tierB : tierB - tierA
      }
      const tieBreak = nameCollator.compare(a.localizedTitle, b.localizedTitle)
      return sortDirection === "asc" ? tieBreak : -tieBreak
    })
  }, [
    entries,
    i18n.resolvedLanguage,
    nameCollator,
    pool,
    q,
    showSetColumn,
    sortDirection,
    sortField,
    staticAugments,
  ])

  const toggleSort = useCallback(
    (field: Exclude<SortField, null>) => {
      const defaultDirection: SortDirection = field === "tier" ? "desc" : "asc"
      const oppositeDirection: SortDirection = defaultDirection === "asc" ? "desc" : "asc"

      if (sortField !== field) {
        setSortField(field)
        setSortDirection(defaultDirection)
        return
      }

      if (sortDirection === defaultDirection) {
        setSortDirection(oppositeDirection)
        return
      }

      setSortField(null)
      setSortDirection(defaultDirection)
    },
    [sortDirection, sortField],
  )

  const sortSuffix = useCallback(
    (field: Exclude<SortField, null>) => {
      if (sortField !== field) {
        return field === "name" ? "(A-Я)" : "(3-1)"
      }
      if (field === "name") {
        return sortDirection === "asc" ? "(A-Я)" : "(Я-A)"
      }
      return sortDirection === "asc" ? "(1-3)" : "(3-1)"
    },
    [sortDirection, sortField],
  )

  const emptyBundle = bundle
    ? bundle.arena.length === 0 && bundle.mayhem.length === 0
    : false

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
        </div>
      </div>

      <Tabs
        value={pool}
        onValueChange={(v) => setPool(v as PoolTab)}
        className="w-full max-w-md"
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="arena">{t("augments.tabArena")}</TabsTrigger>
          <TabsTrigger value="mayhem">{t("augments.tabMayhem")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="text-base">{t("augments.tableTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {bundleStatus === "loading" && (
            <div className="space-y-3" aria-busy>
              <div className="flex flex-wrap items-center gap-3">
                <Skeleton className="h-9 w-full max-w-md flex-1" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-48 w-full" />
            </div>
          )}
          {bundleStatus === "error" && (
            <p className="text-sm text-destructive">{t("augments.bundleLoadError")}</p>
          )}
          {bundleStatus === "ready" && emptyBundle && (
            <p className="text-sm text-muted-foreground">{t("augments.bundleEmpty")}</p>
          )}
          {bundleStatus === "ready" && !emptyBundle && entries.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("augments.poolEmpty")}</p>
          )}
          {bundleStatus === "ready" && !emptyBundle && entries.length > 0 && (
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
                  {t("augments.shownCount", { n: filteredSorted.length, total: entries.length })}
                </p>
              </div>
              <div className="overflow-x-auto rounded-md border border-border/50">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[88px]">{t("augments.colIcon")}</TableHead>
                      <TableHead className="min-w-[160px]">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto p-0 text-left text-sm font-medium"
                          onClick={() => toggleSort("name")}
                        >
                          {t("augments.colName")} {sortSuffix("name")}
                        </Button>
                      </TableHead>
                      <TableHead className="min-w-[280px]">{t("augments.colEffect")}</TableHead>
                      <TableHead className="w-[120px]">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto p-0 text-left text-sm font-medium"
                          onClick={() => toggleSort("tier")}
                        >
                          {t("augments.colTier")} {sortSuffix("tier")}
                        </Button>
                      </TableHead>
                      {showSetColumn ? (
                        <TableHead className="min-w-[160px]">{t("augments.colSet")}</TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSorted.map(({ row, cat, localizedTitle }, ix: number) => {
                      const iconUrls = iconUrlsForRow(row, cat)
                      const key = `${row.pool}-${row.title}-${ix}`
                      const descPlain = wikiAugmentToPlain(row.description_html, { maxChars: 1200 })
                      const notesPlain = wikiAugmentToPlain(row.notes_html ?? "", { maxChars: 500 })
                      return (
                        <TableRow key={key}>
                          <TableCell className="align-top">
                            <AugmentIcon urls={iconUrls} label={row.title} />
                          </TableCell>
                          <TableCell className="align-top">
                            <span className="font-medium leading-snug text-foreground">{localizedTitle}</span>
                          </TableCell>
                          <TableCell className="align-top text-sm">
                            {descPlain.trim() ? (
                              <div className="space-y-1">
                                <p className="max-w-none text-sm leading-relaxed text-foreground">{descPlain}</p>
                                {notesPlain.trim() ? (
                                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{notesPlain}</p>
                                ) : null}
                              </div>
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
                          {showSetColumn ? (
                            <TableCell className="align-top">
                              <span
                                className={cn(
                                  "text-sm",
                                  !augmentSetDisplay(row.set_label) && "text-muted-foreground",
                                )}
                              >
                                {augmentSetDisplay(row.set_label) || "—"}
                              </span>
                            </TableCell>
                          ) : null}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              {filteredSorted.length === 0 && q.trim() && (
                <p className="text-sm text-muted-foreground">{t("augments.noSearchResults")}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
