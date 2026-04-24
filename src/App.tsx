import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  lazy,
  Suspense,
  type ComponentProps,
  type SyntheticEvent,
} from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Routes, Route, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  BookOpen,
  Check,
  ChevronDown,
  Circle,
  DownloadCloud,
  History,
  LineChart,
  RefreshCw,
  Search,
  Settings,
  Wrench,
  Youtube,
  ArrowUp,
  ArrowDown,
  ArrowRightLeft,
  X,
  Sparkles,
} from "lucide-react";
import { ErrorBoundary } from "@/components/error-boundary";

const SettingsPage = lazy(async () => {
  const m = await import("@/pages/settings-page");
  return { default: m.SettingsPage };
});
const CommunityPage = lazy(async () => {
  const m = await import("@/pages/community-page");
  return { default: m.CommunityPage };
});
const AugmentsPage = lazy(async () => {
  const m = await import("@/pages/augments-page");
  return { default: m.AugmentsPage };
});
import { YoutubeChannelPanel } from "@/components/youtube-channel-panel";
import {
  YOUTUBE_CHANNEL_SKINSPOTLIGHTS,
  YOUTUBE_URL_SKINSPOTLIGHTS,
} from "@/lib/youtube-channels";
import { SkinSpotlightEmbed } from "@/components/skin-spotlight-embed";
import { buildSkinSpotlightYoutubeSearch } from "@/lib/youtube-match";
import { useYoutubeFeed } from "@/hooks/use-youtube-feed";
import { StartupRouteSync } from "@/components/startup-route";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  applyDomFromPreferences,
  loadAppPreferences,
  saveAppPreferences,
} from "@/lib/app-preferences";
import { formatAppDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import {
  cleanUrl,
  highlightSpecialTags,
  compareVersions,
  patchNoteCategoryLabel,
  WIKI_AUGMENT_DETAIL_TITLE,
  PATCH_NOTE_CATEGORY_TAB_ORDER,
} from "@/lib/patch-utils";
import { wikiAugmentToPlain } from "@/lib/wiki-augment-plain";
import { loadItemsRunesHybrid } from "@/lib/catalog-from-tauri";
import { wikiEmbedOpen } from "@/lib/wiki-embed";
import type {
  PatchData,
  PatchNoteEntry,
  ChampionHistoryEntry,
  ChampionListItem,
  RuneListItem,
  ItemListItem,
  TierEntry,
  ChangeTrend,
  ThemeOption,
} from "@/types/patch";

function RouteFallback() {
  return (
    <div className="space-y-4 py-2">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full max-w-2xl" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

const TIER_WINDOW_OPTIONS = [5, 10, 20] as const;
const TIER_HISTORY_TOP_LIMIT = 10;
const TIER_ARCHIVE_SORT_OPTIONS = ["score", "buffs", "nerfs"] as const;
const PREVIOUS_PATCH_TARGET_OPTIONS = [50, 60, 70, 80, 90, 100] as const;
const PREVIOUS_PATCH_SAVED_EVENT = "previous_patch_saved";
type PreviousPatchSavedPayload = {
  version: string;
  processed: number;
  total: number;
  downloaded: number;
  skipped: number;
  saved: boolean;
};

const LOL_WIKI_ENTRIES = [
  { url: "https://wiki.leagueoflegends.com/en-us/", labelKey: "lolWiki.main" },
  { url: "https://wiki.leagueoflegends.com/en-us/Champion", labelKey: "lolWiki.champions" },
  { url: "https://wiki.leagueoflegends.com/en-us/Rune", labelKey: "lolWiki.runes" },
  { url: "https://wiki.leagueoflegends.com/en-us/Summoner_spell", labelKey: "lolWiki.summoners" },
  { url: "https://wiki.leagueoflegends.com/en-us/Item", labelKey: "lolWiki.items" },
  { url: "https://wiki.leagueoflegends.com/en-us/Champion_skin", labelKey: "lolWiki.skins" },
] as const;

function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function findItemByName(items: ItemListItem[], rawName: string): ItemListItem | undefined {
  const needle = normalizeEntityName(rawName);
  if (!needle) return undefined;
  return items.find((item) => {
    const ru = normalizeEntityName(item.name);
    const en = normalizeEntityName(item.nameEn);
    return ru === needle || en === needle;
  });
}

function buildIconCandidates(urls: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    const cleaned = cleanUrl(raw) ?? raw;
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function resolveUiImageSrc(url?: string | null): string | undefined {
  if (!url) return undefined;
  const cleaned = cleanUrl(url) ?? url;
  if (
    isTauri() &&
    !cleaned.startsWith("http://") &&
    !cleaned.startsWith("https://") &&
    !cleaned.startsWith("data:") &&
    !cleaned.startsWith("blob:") &&
    !cleaned.startsWith("asset:") &&
    !cleaned.startsWith("tauri:")
  ) {
    try {
      return convertFileSrc(cleaned.replace(/\\/g, "/"));
    } catch {
      return cleaned;
    }
  }
  return cleaned;
}

async function openExternalUrl(url: string) {
  if (isTauri()) {
    try {
      await openUrl(url);
      return;
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function App() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const patchNotesLocale = i18n.language?.startsWith("en") ? "en" : "ru";
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingPrevious, setSyncingPrevious] = useState(false);
  const [previousSyncProgress, setPreviousSyncProgress] = useState<{
    processed: number;
    total: number;
    downloaded: number;
    skipped: number;
  } | null>(null);
  const [previousPatchTargetTotal, setPreviousPatchTargetTotal] =
    useState<(typeof PREVIOUS_PATCH_TARGET_OPTIONS)[number]>(50);
  const [version, setVersion] = useState("");
  const [patchesList, setPatchesList] = useState<string[]>([]);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [patchData, setPatchData] = useState<PatchData | null>(null);
  const [newPatches, setNewPatches] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<ThemeOption>(() => loadAppPreferences().theme);
  const prevLocaleRef = useRef(patchNotesLocale);
  const currentVersionRef = useRef(version);

  useEffect(() => {
    currentVersionRef.current = version;
  }, [version]);

  useEffect(() => {
    if (!isTauri() || !import.meta.env.DEV) return;
    void invoke("cache_status").catch(() => undefined);
    void invoke("validate_cached_assets").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<PreviousPatchSavedPayload>(PREVIOUS_PATCH_SAVED_EVENT, async (event) => {
        setPreviousSyncProgress({
          processed: event.payload.processed,
          total: event.payload.total,
          downloaded: event.payload.downloaded,
          skipped: event.payload.skipped,
        });
        try {
          const list = await invoke<string[]>("get_cached_patch_versions");
          setPatchesList(list);
        } catch {
          // ignore live update errors
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    applyDomFromPreferences(loadAppPreferences());
    document.documentElement.lang = i18n.language?.startsWith("en") ? "en" : "ru";
    const onPrefs = () => applyDomFromPreferences(loadAppPreferences());
    window.addEventListener("app-prefs-changed", onPrefs);
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", onPrefs);
    return () => {
      window.removeEventListener("app-prefs-changed", onPrefs);
      mq.removeEventListener("change", onPrefs);
    };
  }, [i18n.language]);

  useEffect(() => {
    const p = loadAppPreferences();
    setTheme(p.theme);
    let eff: "light" | "dark";
    if (p.theme === "system") {
      eff = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      eff = p.theme;
    }
    const root = document.documentElement;
    if (eff === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, []);

  useEffect(() => {
    let eff: "light" | "dark";
    if (theme === "system") {
      eff = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      eff = theme;
    }
    saveAppPreferences({ theme });
    localStorage.setItem("theme", theme);
    const root = document.documentElement;
    if (eff === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, [theme]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await getCurrentWindow().onCloseRequested(async (e) => {
        e.preventDefault();
        const prefs = loadAppPreferences();
        if (prefs.closeToTray) {
          await getCurrentWindow().setSkipTaskbar(true);
          await getCurrentWindow().hide();
          return;
        }
        try {
          await invoke("exit_app");
        } catch {
          try {
            await getCurrentWindow().close();
          } catch {
            /* ignore */
          }
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const w = getCurrentWindow();
      unlisten = await w.onResized(async () => {
        if (!loadAppPreferences().minimizeToTray) return;
        try {
          if (await w.isMinimized()) {
            await w.setSkipTaskbar(true);
            await w.hide();
          }
        } catch {
          /* ignore */
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("update_tray_menu_labels", {
      show: i18n.t("tray.show"),
      quit: i18n.t("tray.quit"),
    }).catch(() => { });
  }, [i18n.language]);

  async function refreshPatchesStatus(list: string[]) {
    if (list.length === 0) return {};
    return await invoke<Record<string, boolean>>("check_patches_exist", { versions: list });
  }

  const loadData = useCallback(
    async (
      ver: string,
      force: boolean,
      listOverride?: string[],
      allowNetwork = false,
    ) => {
      const list = listOverride ?? patchesList;
      const showSpinner = force || list.length === 0;
      if (showSpinner) setLoading(true);
      else setLoading(false);
      try {
        const patchResult = await invoke<PatchData>("get_patch_by_version", {
          version: ver,
          patchNotesLocale,
          allowNetwork,
        });
        setPatchData(patchResult);
        if (list.length > 0) {
          await refreshPatchesStatus(list);
        }
        if (force) {
          toast.success(t("toasts.patchRefreshed", { ver }));
          setNewPatches((prev) => {
            const updated = new Set(prev);
            updated.delete(ver);
            return updated;
          });
        }
      } catch (error) {
        const msg = String(error);
        if (msg.includes("PATCH_NOT_CACHED")) {
          toast.error(t("toasts.patchNotCached"));
        } else {
          console.error(error);
          toast.error(t("toasts.loadError", { msg }));
        }
      } finally {
        setLoading(false);
      }
    },
    [patchesList, patchNotesLocale, t],
  );

  useEffect(() => {
    if (!isTauri()) {
      setCacheLoaded(true);
      return;
    }
    void (async () => {
      try {
        const list = await invoke<string[]>("get_cached_patch_versions");
        setPatchesList(list);
        if (list.length === 0) {
          setVersion("");
          return;
        }
        const mode = loadAppPreferences().patchDefaultMode;
        let v = list[0]!;
        if (mode !== "alwaysLatest") {
          const saved = loadAppPreferences().lastPatchVersion;
          if (saved && list.includes(saved)) v = saved;
        }
        setVersion(v);
      } catch (e) {
        console.error(e);
      } finally {
        setCacheLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (patchesList.length === 0) return;
    void (async () => {
      try {
        const status = await refreshPatchesStatus(patchesList);
        const latestPatch = patchesList[0];
        if (latestPatch && !status[latestPatch]) {
          setNewPatches(new Set([latestPatch]));
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, [patchesList]);

  useEffect(() => {
    if (!version) return;
    const localeChanged = prevLocaleRef.current !== patchNotesLocale;
    prevLocaleRef.current = patchNotesLocale;
    void loadData(version, false, undefined, localeChanged);
  }, [version, patchNotesLocale, loadData]);

  async function handleSyncAll() {
    setSyncing(true);
    toast.info(t("toasts.syncingAll"));
    try {
      await invoke("sync_patch_history", { patchNotesLocale });
      toast.success(t("toasts.syncDone"));
      const list = await invoke<string[]>("get_available_patches");
      setPatchesList(list);
      const status = await refreshPatchesStatus(list);
      setNewPatches((prev) => {
        const updated = new Set(prev);
        Object.keys(status).forEach((v) => {
          if (status[v]) updated.delete(v);
        });
        return updated;
      });
      let v = version;
      if (list.length > 0 && !list.includes(v)) {
        v = list[0]!;
        setVersion(v);
        saveAppPreferences({ lastPatchVersion: v });
      }
      if (v) {
        await loadData(v, false, list);
      }
      window.dispatchEvent(new Event("tier-data-updated"));
    } catch (e) {
      toast.error(t("toasts.syncError", { msg: String(e) }));
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncPreviousToLimit(targetTotal: (typeof PREVIOUS_PATCH_TARGET_OPTIONS)[number]) {
    setSyncingPrevious(true);
    setPreviousSyncProgress(null);
    toast.info(t("toasts.syncingPrevious", { count: targetTotal }));
    try {
      await invoke("sync_previous_patch_history_to_limit", {
        targetTotal,
        patchNotesLocale,
      });
      toast.success(t("toasts.syncPreviousDone", { count: targetTotal }));
      const list = await invoke<string[]>("get_cached_patch_versions");
      setPatchesList(list);
      const selectedVersion = currentVersionRef.current;
      if (list.length > 0 && !list.includes(selectedVersion)) {
        const fallback = list[0]!;
        setVersion(fallback);
        saveAppPreferences({ lastPatchVersion: fallback });
        await loadData(fallback, false, list);
      } else if (selectedVersion) {
        await loadData(selectedVersion, false, list);
      }
      window.dispatchEvent(new Event("tier-data-updated"));
    } catch (e) {
      toast.error(t("toasts.syncError", { msg: String(e) }));
    } finally {
      setSyncingPrevious(false);
      window.setTimeout(() => setPreviousSyncProgress(null), 2000);
    }
  }

  function setVersionPersist(next: string) {
    setVersion(next);
    saveAppPreferences({ lastPatchVersion: next });
  }

  async function openWikiUrl(url: string) {
    if (!isTauri()) {
      await openExternalUrl(url);
      return;
    }
    try {
      await wikiEmbedOpen(url);
    } catch (e) {
      toast.error(t("toasts.wikiEmbedError", { msg: String(e) }));
    }
  }

  const navItems = [
    { path: "/", label: t("nav.patchNotes"), icon: BookOpen },
    { path: "/tier", label: t("nav.tier"), icon: LineChart },
    { path: "/history", label: t("nav.history"), icon: History },
    { path: "/augments", label: t("nav.augments"), icon: Sparkles },
    { path: "/settings", label: t("nav.settings"), icon: Settings },
  ];

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <StartupRouteSync />
        <div className="flex min-h-screen flex-col bg-background font-sans text-foreground antialiased selection:bg-primary/25">
          <Toaster position="top-right" />
          <div className="flex min-h-screen flex-col">
            <header className="sticky top-0 z-50 border-b border-border/40 bg-background/75 backdrop-blur-xl supports-backdrop-filter:bg-background/60">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4 md:gap-8">
                  <div className="flex min-w-0 cursor-default items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center">
                      <img src="/logo.svg" alt="Logo" className="h-11 w-11 drop-shadow-md" />
                    </div>
                    <div className="min-w-0">
                      <h1 className="text-lg font-semibold leading-snug tracking-normal text-foreground">
                        Patch Analyzer
                      </h1>
                      <p className="truncate text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
                        {t("header.patchLine", { version: version || "—" })}
                      </p>
                      {isTauri() && cacheLoaded && patchesList.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t("header.dataFromCache")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <nav
                    className="flex w-full min-w-0 sm:w-auto md:ml-0"
                    aria-label={t("nav.mainLabel")}
                  >
                    <div className="inline-flex w-full max-w-full gap-0.5 rounded-full border border-border/50 bg-muted/20 p-1 shadow-inner sm:w-auto">
                      {navItems.map(({ path, label, icon: Icon }) => (
                        <NavLink
                          key={path}
                          to={path}
                          end={path === "/"}
                          className={({ isActive }) =>
                            cn(
                              "flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium transition-colors sm:flex-initial sm:justify-start sm:px-4",
                              isActive
                                ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                            )
                          }
                        >
                          <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
                          <span className="truncate">{label}</span>
                        </NavLink>
                      ))}
                    </div>
                  </nav>
                </div>
                <div className="flex shrink-0 items-center gap-0.5 rounded-2xl border border-border/50 bg-muted/15 p-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
                        aria-label={t("header.openCommunity")}
                        onClick={() => navigate("/community")}
                      >
                        <Youtube className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("header.openCommunityHint")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
                        aria-label={t("header.downloadPatches")}
                        disabled={syncing || syncingPrevious}
                        onClick={handleSyncAll}
                      >
                        <DownloadCloud className={cn("h-4 w-4", syncing && "animate-bounce")} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("header.downloadPatchesHint")}</TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
                            aria-label={t("header.downloadPreviousPatches")}
                            disabled={syncing || syncingPrevious}
                          >
                            <History className={cn("h-4 w-4", syncingPrevious && "animate-bounce")} />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <div className="space-y-1">
                          <p>{t("header.downloadPreviousPatchesHint", { count: previousPatchTargetTotal })}</p>
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            {t("header.downloadPreviousPatchesWarning")}
                          </p>
                          {syncingPrevious && previousSyncProgress && previousSyncProgress.total > 0 ? (
                            <>
                              <p className="text-xs text-muted-foreground">
                                {t("header.downloadPreviousPatchesProgress", {
                                  processed: previousSyncProgress.processed,
                                  total: previousSyncProgress.total,
                                })}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {t("header.downloadPreviousPatchesStats", {
                                  downloaded: previousSyncProgress.downloaded,
                                  skipped: previousSyncProgress.skipped,
                                })}
                              </p>
                            </>
                          ) : null}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" className="min-w-52">
                      <DropdownMenuItem disabled>
                        {t("header.previousPatchesLimitLabel")}
                      </DropdownMenuItem>
                      {PREVIOUS_PATCH_TARGET_OPTIONS.map((option) => (
                        <DropdownMenuItem
                          key={option}
                          disabled={syncing || syncingPrevious}
                          onClick={() => {
                            setPreviousPatchTargetTotal(option);
                            void handleSyncPreviousToLimit(option);
                          }}
                        >
                          <span className="flex w-full items-center justify-between gap-3">
                            <span>{t("header.previousPatchesLimitOption", { count: option })}</span>
                            {option === previousPatchTargetTotal ? <Check className="h-4 w-4" /> : null}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <AlertDialog>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <AlertDialogTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
                              aria-label={t("header.resetDb")}
                            >
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t("header.resetDbHint")}</TooltipContent>
                    </Tooltip>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("dialogs.resetDbTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>{t("dialogs.resetDbDesc")}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("dialogs.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={async () => {
                            try {
                              await invoke("clear_database");
                              setPatchData(null);
                              setNewPatches(new Set());
                              const list = await invoke<string[]>("get_cached_patch_versions");
                              setPatchesList(list);
                              if (list.length) await refreshPatchesStatus(list);
                              const v =
                                version && list.includes(version) ? version : (list[0] ?? "");
                              setVersion(v);
                              if (v) {
                                await loadData(v, false, list);
                              }
                              window.dispatchEvent(new Event("tier-data-updated"));
                              toast.success(t("toasts.resetDone"));
                            } catch {
                              toast.info(t("toasts.resetManual"));
                            }
                          }}
                        >
                          {t("dialogs.confirmReset")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </header>
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6 sm:py-8">
              <ErrorBoundary>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route
                      path="/"
                      element={
                        !isTauri() || cacheLoaded ? (
                          <PatchReleaseView
                            data={patchData}
                            version={version}
                            patchesList={patchesList}
                            onVersionChange={setVersionPersist}
                            loading={loading}
                            newPatches={newPatches}
                            noLocalCache={isTauri() && patchesList.length === 0}
                          />
                        ) : (
                          <RouteFallback />
                        )
                      }
                    />
                    <Route path="/tier" element={<TierListView />} />
                    <Route path="/history" element={<ChampionHistoryView />} />
                    <Route path="/augments" element={<AugmentsPage />} />
                    <Route
                      path="/settings"
                      element={<SettingsPage theme={theme} onThemeChange={setTheme} />}
                    />
                    <Route path="/community" element={<CommunityPage />} />
                  </Routes>
                </Suspense>
              </ErrorBoundary>
            </main>
            <footer className="sticky bottom-0 z-40 border-t border-border/40 bg-background/80 backdrop-blur-xl supports-backdrop-filter:bg-background/60">
              <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    {t("lolWiki.category")}
                  </span>
                  <div className="hidden h-3 w-px bg-border sm:block" />
                </div>
                <ScrollArea className="w-full sm:w-auto">
                  <div className="flex w-max min-w-full flex-nowrap items-center gap-1 sm:justify-end">
                    {LOL_WIKI_ENTRIES.map(({ url, labelKey }) => (
                      <Button
                        key={url}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        onClick={() => void openWikiUrl(url)}
                      >
                        {t(labelKey)}
                      </Button>
                    ))}
                  </div>
                  <ScrollBar orientation="horizontal" className="invisible" />
                </ScrollArea>
              </div>
            </footer>
          </div>
        </div>
      </TooltipProvider>
    </ErrorBoundary>
  );
}

function CustomPatchSelect({
  value,
  options,
  onChange,
  loading,
  newPatches,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  loading: boolean;
  newPatches?: Set<string>;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          className="h-9 min-w-34 justify-between gap-2 rounded-full border-border/60 bg-background/80 px-3.5 text-sm font-medium shadow-sm"
          disabled={loading}
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500/90 shadow-[0_0_0_2px_rgba(16,185,129,0.25)]" />
          <span className={cn("truncate", loading && "opacity-50")}>{value}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
        {options.map((opt) => {
          const isCurrent = opt === value;
          const isNew = newPatches?.has(opt) ?? false;
          return (
            <DropdownMenuItem
              key={opt}
              onClick={() => onChange(opt)}
              className={cn(isCurrent && "bg-accent")}
            >
              <span className="flex flex-1 items-center gap-2">
                {isCurrent ? (
                  <Circle className="h-3 w-3 fill-green-500 text-green-500" />
                ) : (
                  <span className="inline-block w-3 shrink-0" aria-hidden />
                )}
                <span>{t("header.patchLine", { version: opt })}</span>
                {isNew && (
                  <UiBadge variant="warning" className="px-1 py-0 text-xs">
                    NEW
                  </UiBadge>
                )}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TierListView() {
  const { t } = useTranslation();
  const [data, setData] = useState<TierEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [tierWindow, setTierWindow] = useState<(typeof TIER_WINDOW_OPTIONS)[number]>(20);
  const [tierRange, setTierRange] = useState<{
    newestPatch: string;
    oldestPatch: string;
    usedPatches: number;
  } | null>(null);
  const [historyMode, setHistoryMode] = useState<"topBuffs" | "topNerfs" | "archive">("topBuffs");
  const [archiveSort, setArchiveSort] = useState<(typeof TIER_ARCHIVE_SORT_OPTIONS)[number]>("score");
  const [entityType, setEntityType] = useState<"champion" | "rune" | "item">("champion");
  const [allChamps, setAllChamps] = useState<ChampionListItem[]>([]);
  const [allRunes, setAllRunes] = useState<RuneListItem[]>([]);
  const [allItems, setAllItems] = useState<ItemListItem[]>([]);
  const navigate = useNavigate();

  const loadTierList = useCallback(async () => {
    setLoading(true);
    try {
      const [tierEntries, cachedVersions] = await Promise.all([
        invoke<TierEntry[]>("get_tier_list", { windowSize: tierWindow }),
        invoke<string[]>("get_cached_patch_versions").catch(() => []),
      ]);
      setData(tierEntries);
      const windowVersions = cachedVersions.slice(0, tierWindow);
      if (windowVersions.length > 0) {
        setTierRange({
          newestPatch: windowVersions[0]!,
          oldestPatch: windowVersions[windowVersions.length - 1]!,
          usedPatches: windowVersions.length,
        });
      } else {
        setTierRange(null);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [tierWindow]);

  useEffect(() => {
    void loadTierList();
  }, [loadTierList]);

  useEffect(() => {
    const onTierUpdate = () => {
      void loadTierList();
    };
    window.addEventListener("tier-data-updated", onTierUpdate);
    return () => window.removeEventListener("tier-data-updated", onTierUpdate);
  }, [loadTierList]);

  // чемпы, руны, предметы — берём те же DDragon данные, что и в истории
  useEffect(() => {
    invoke<ChampionListItem[]>("get_all_champions")
      .then(setAllChamps)
      .catch(e => toast.error(String(e)));
  }, []);

  useEffect(() => {
    void loadItemsRunesHybrid()
      .then(({ items, runes }) => {
        setAllItems(items);
        setAllRunes(runes);
      })
      .catch(e => {
        console.error(e);
      });
  }, []);

  const filtered = data.filter(entry => {
    if (entityType === "champion") return entry.category === "Champions";
    if (entityType === "rune") return entry.category === "Runes" || entry.category === "ItemsRunes";
    if (entityType === "item") return entry.category === "Items" || entry.category === "ItemsRunes";
    return false;
  });

  const topBuffHistory = useMemo(() => {
    return [...filtered]
      .filter((entry) => entry.buffs > 0)
      .sort((a, b) => {
        if (b.buffs !== a.buffs) return b.buffs - a.buffs;
        const scoreA = a.buffs - a.nerfs;
        const scoreB = b.buffs - b.nerfs;
        return scoreB - scoreA;
      })
      .slice(0, TIER_HISTORY_TOP_LIMIT);
  }, [filtered]);

  const topNerfHistory = useMemo(() => {
    return [...filtered]
      .filter((entry) => entry.nerfs > 0)
      .sort((a, b) => {
        if (b.nerfs !== a.nerfs) return b.nerfs - a.nerfs;
        const scoreA = a.buffs - a.nerfs;
        const scoreB = b.buffs - b.nerfs;
        return scoreA - scoreB;
      })
      .slice(0, TIER_HISTORY_TOP_LIMIT);
  }, [filtered]);

  const archiveSorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const scoreA = a.buffs - a.nerfs;
      const scoreB = b.buffs - b.nerfs;
      if (archiveSort === "buffs") {
        return b.buffs - a.buffs || scoreB - scoreA;
      }
      if (archiveSort === "nerfs") {
        return b.nerfs - a.nerfs || scoreA - scoreB;
      }
      return scoreB - scoreA || b.buffs - a.buffs || a.nerfs - b.nerfs;
    });
  }, [archiveSort, filtered]);

  const resolveIconAndName = (entry: TierEntry) => {
    if (entry.category === "Champions") {
      const c = allChamps.find(ch =>
        ch.name === entry.name || ch.name_en === entry.name
      );
      return {
        iconCandidates: buildIconCandidates([entry.icon_url, c?.icon_url]),
        name: c?.name || entry.name,
      };
    }
    if (entityType === "rune") {
      const r = allRunes.find(r =>
        normalizeEntityName(r.name) === normalizeEntityName(entry.name) ||
        normalizeEntityName(r.nameEn) === normalizeEntityName(entry.name)
      );
      return {
        iconCandidates: buildIconCandidates([entry.icon_url, r?.icon_url]),
        name: r?.name || entry.name,
      };
    }
    if (entityType === "item") {
      const it = findItemByName(allItems, entry.name);
      return {
        iconCandidates: buildIconCandidates([entry.icon_url, it?.icon_url]),
        name: it?.name || entry.name,
      };
    }
    return { iconCandidates: buildIconCandidates([entry.icon_url]), name: entry.name };
  };

  const handleOpenHistory = (entry: TierEntry) => {
    const type =
      entry.category === "Champions"
        ? "champion"
        : entityType === "rune"
          ? "rune"
          : "item";
    navigate(`/history?type=${encodeURIComponent(type)}&name=${encodeURIComponent(entry.name)}`);
  };

  const categoryLabel = (entry: TierEntry) =>
    entry.category === "Champions"
      ? t("tier.categoryChampion")
      : entry.category === "Runes"
        ? t("tier.categoryRune")
        : entry.category === "Items"
          ? t("tier.categoryItem")
          : t("tier.categoryRuneItem");

  return (
    <div className="animate-in fade-in duration-500">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,1fr)]">
        <article className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm shadow-black/3 dark:shadow-black/20">
          <div className="border-b border-border/50 bg-muted/10 px-5 py-5 sm:px-8">
            <div className="space-y-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {t("tier.aggregation", { count: tierWindow })}
                </p>
                <h2 className="mt-1 text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">
                  {t("tier.title")}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Tabs
                  value={entityType}
                  onValueChange={(v) => setEntityType(v as "champion" | "rune" | "item")}
                  className="min-w-0 flex-1 sm:flex-initial"
                >
                  <TabsList className="inline-flex h-auto w-full max-w-full flex-wrap gap-1 rounded-xl bg-muted/25 p-1 sm:w-auto sm:flex-nowrap">
                    <TabsTrigger
                      value="champion"
                      className="flex-1 rounded-lg px-3 py-2.5 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4"
                    >
                      {t("tier.champions")}
                    </TabsTrigger>
                    <TabsTrigger
                      value="rune"
                      className="flex-1 rounded-lg px-3 py-2.5 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4"
                    >
                      {t("tier.runes")}
                    </TabsTrigger>
                    <TabsTrigger
                      value="item"
                      className="flex-1 rounded-lg px-3 py-2.5 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4"
                    >
                      {t("tier.items")}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Tabs
                  value={String(tierWindow)}
                  onValueChange={(v) => setTierWindow(Number(v) as (typeof TIER_WINDOW_OPTIONS)[number])}
                  className="min-w-0 flex-1 sm:flex-initial"
                >
                  <TabsList className="inline-flex h-auto w-full max-w-full flex-wrap gap-1 rounded-xl bg-muted/25 p-1 sm:w-auto sm:flex-nowrap">
                    {TIER_WINDOW_OPTIONS.map((value) => (
                      <TabsTrigger
                        key={value}
                        value={String(value)}
                        className="flex-1 rounded-lg px-3 py-2.5 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4"
                      >
                        {t("tier.windowOption", { count: value })}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </div>
          </div>

          <div className="min-h-48">
            {loading && (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                <RefreshCw className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">{t("tier.building")}</p>
              </div>
            )}

            {!loading && (
              <>
                <div className="hidden md:block overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-b border-border/50 bg-muted/15 hover:bg-muted/15">
                        <TableHead className="w-[40%] pl-6 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                          {t("tier.entity")}
                        </TableHead>
                        <TableHead className="text-center text-sm font-semibold uppercase tracking-wide text-chart-up">
                          ↑ Buff
                        </TableHead>
                        <TableHead className="text-center text-sm font-semibold uppercase tracking-wide text-chart-down">
                          ↓ Nerf
                        </TableHead>
                        <TableHead className="text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                          {t("tier.changes")}
                        </TableHead>
                        <TableHead className="pr-6 text-center text-sm font-semibold uppercase tracking-wide text-chart-muted">
                          Score
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((entry, idx) => {
                        const { iconCandidates, name } = resolveIconAndName(entry);
                        const score = entry.buffs - entry.nerfs;
                        return (
                          <TableRow
                            key={entry.name + entry.category + idx}
                            className="cursor-pointer border-border/40 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            role="button"
                            tabIndex={0}
                            onClick={() => handleOpenHistory(entry)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleOpenHistory(entry);
                              }
                            }}
                          >
                            <TableCell className="py-3.5 pl-6">
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="w-7 shrink-0 text-center font-mono text-xs text-muted-foreground">
                                  {idx + 1}
                                </span>
                                <TierEntityIcon
                                  urls={iconCandidates}
                                  name={name}
                                  size="md"
                                  className="h-9 w-9"
                                />
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-foreground">{name}</div>
                                  <div className="text-xs text-muted-foreground">{categoryLabel(entry)}</div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="py-3.5 text-center text-sm font-semibold tabular-nums text-chart-up">
                              {entry.buffs}
                            </TableCell>
                            <TableCell className="py-3.5 text-center text-sm font-semibold tabular-nums text-chart-down">
                              {entry.nerfs}
                            </TableCell>
                            <TableCell className="py-3.5 text-center text-sm font-medium tabular-nums text-muted-foreground">
                              {entry.adjusted}
                            </TableCell>
                            <TableCell
                              className={cn(
                                "py-3.5 pr-6 text-center font-mono text-sm font-semibold tabular-nums",
                                score > 0 && "text-chart-up",
                                score < 0 && "text-chart-down",
                                score === 0 && "text-chart-muted",
                              )}
                            >
                              {score > 0 ? `+${score}` : score < 0 ? score : "0"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {filtered.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="py-14 text-center text-sm text-muted-foreground">
                            {t("tier.noData")}
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                <div className="md:hidden divide-y divide-border/50">
                  {filtered.map((entry, idx) => {
                    const { iconCandidates, name } = resolveIconAndName(entry);
                    const score = entry.buffs - entry.nerfs;
                    return (
                      <button
                        key={entry.name + entry.category + idx}
                        type="button"
                        onClick={() => handleOpenHistory(entry)}
                        className="flex w-full flex-col gap-3 p-4 text-left transition-colors hover:bg-muted/20 active:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-8 shrink-0 text-center font-mono text-sm text-muted-foreground">
                            #{idx + 1}
                          </span>
                          <TierEntityIcon
                            urls={iconCandidates}
                            name={name}
                            size="lg"
                            className="h-10 w-10"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold leading-tight text-foreground">{name}</div>
                            <div className="text-xs text-muted-foreground">{categoryLabel(entry)}</div>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 pl-11 text-sm">
                          <span className="tabular-nums text-chart-up">↑ {entry.buffs}</span>
                          <span className="tabular-nums text-chart-down">↓ {entry.nerfs}</span>
                          <span className="tabular-nums text-muted-foreground">⇄ {entry.adjusted}</span>
                          <span
                            className={cn(
                              "font-mono font-semibold tabular-nums",
                              score > 0 && "text-chart-up",
                              score < 0 && "text-chart-down",
                              score === 0 && "text-chart-muted",
                            )}
                          >
                            {score > 0 ? `+${score}` : score < 0 ? score : "0"}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                  {filtered.length === 0 && (
                    <div className="px-4 py-14 text-center text-sm text-muted-foreground">
                      {t("tier.noData")}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </article>
        <article className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm shadow-black/3 dark:shadow-black/20 xl:sticky xl:top-24 xl:max-h-[calc(100vh-7rem)] xl:overflow-auto">
          <div className="border-b border-border/50 bg-muted/10 px-5 py-5 sm:px-6">
            <h3 className="text-lg font-semibold tracking-normal text-foreground">{t("tier.historyTitle")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {tierRange
                ? t("tier.historyRange", {
                  newest: tierRange.newestPatch,
                  oldest: tierRange.oldestPatch,
                  count: tierRange.usedPatches,
                })
                : t("tier.noData")}
            </p>
            <Tabs
              value={historyMode}
              onValueChange={(v) => setHistoryMode(v as "topBuffs" | "topNerfs" | "archive")}
              className="mt-3 w-full"
            >
              <TabsList className="inline-flex h-auto w-full max-w-full flex-wrap gap-1 rounded-xl bg-muted/25 p-1 sm:w-auto">
                <TabsTrigger
                  value="topBuffs"
                  className="flex-1 rounded-lg px-3 py-2 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial"
                >
                  {t("tier.topBuffs")}
                </TabsTrigger>
                <TabsTrigger
                  value="topNerfs"
                  className="flex-1 rounded-lg px-3 py-2 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial"
                >
                  {t("tier.topNerfs")}
                </TabsTrigger>
                <TabsTrigger
                  value="archive"
                  className="flex-1 rounded-lg px-3 py-2 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial"
                >
                  {t("tier.archiveTab")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {historyMode !== "archive" ? (
            <div className="grid gap-4 px-5 py-5 sm:px-6">
              {historyMode === "topBuffs" ? (
                <div className="space-y-3">
                  <p className="text-sm font-semibold uppercase tracking-wide text-chart-up">
                    {t("tier.topBuffs")}
                  </p>
                  {topBuffHistory.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("tier.noHistoryData")}</p>
                  ) : (
                    <div className="space-y-2">
                      {topBuffHistory.map((entry, idx) => {
                        const { iconCandidates, name } = resolveIconAndName(entry);
                        return (
                          <button
                            key={`buff-${entry.name}-${entry.category}-${idx}`}
                            type="button"
                            onClick={() => handleOpenHistory(entry)}
                            className="flex w-full items-center gap-3 rounded-lg border border-border/50 px-3 py-2 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="w-6 shrink-0 text-center font-mono text-sm text-muted-foreground">
                              {idx + 1}
                            </span>
                            <TierEntityIcon urls={iconCandidates} name={name} size="md" className="h-8 w-8" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
                            <span className="font-mono text-sm tabular-nums text-chart-up">↑ {entry.buffs}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm font-semibold uppercase tracking-wide text-chart-down">
                    {t("tier.topNerfs")}
                  </p>
                  {topNerfHistory.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("tier.noHistoryData")}</p>
                  ) : (
                    <div className="space-y-2">
                      {topNerfHistory.map((entry, idx) => {
                        const { iconCandidates, name } = resolveIconAndName(entry);
                        return (
                          <button
                            key={`nerf-${entry.name}-${entry.category}-${idx}`}
                            type="button"
                            onClick={() => handleOpenHistory(entry)}
                            className="flex w-full items-center gap-3 rounded-lg border border-border/50 px-3 py-2 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="w-6 shrink-0 text-center font-mono text-sm text-muted-foreground">
                              {idx + 1}
                            </span>
                            <TierEntityIcon urls={iconCandidates} name={name} size="md" className="h-8 w-8" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
                            <span className="font-mono text-sm tabular-nums text-chart-down">↓ {entry.nerfs}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="px-5 py-5 sm:px-6">
              <Tabs
                value={archiveSort}
                onValueChange={(v) => setArchiveSort(v as (typeof TIER_ARCHIVE_SORT_OPTIONS)[number])}
                className="mb-4 w-full"
              >
                <TabsList className="inline-flex h-auto w-full max-w-full flex-wrap gap-1 rounded-xl bg-muted/25 p-1 sm:w-auto">
                  <TabsTrigger
                    value="score"
                    className="flex-1 rounded-lg px-3 py-2 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial"
                  >
                    {t("tier.sortScore")}
                  </TabsTrigger>
                  <TabsTrigger
                    value="buffs"
                    className="flex-1 rounded-lg px-3 py-2 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial"
                  >
                    {t("tier.sortBuffs")}
                  </TabsTrigger>
                  <TabsTrigger
                    value="nerfs"
                    className="flex-1 rounded-lg px-3 py-2 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial"
                  >
                    {t("tier.sortNerfs")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {archiveSorted.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("tier.noHistoryData")}</p>
              ) : (
                <div className="space-y-2">
                  {archiveSorted.map((entry, idx) => {
                    const { iconCandidates, name } = resolveIconAndName(entry);
                    const score = entry.buffs - entry.nerfs;
                    return (
                      <button
                        key={`archive-${entry.name}-${entry.category}-${idx}`}
                        type="button"
                        onClick={() => handleOpenHistory(entry)}
                        className="flex w-full items-center gap-3 rounded-lg border border-border/50 px-3 py-2 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="w-6 shrink-0 text-center font-mono text-sm text-muted-foreground">
                          {idx + 1}
                        </span>
                        <TierEntityIcon urls={iconCandidates} name={name} size="md" className="h-8 w-8" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
                        <span className="font-mono text-sm tabular-nums text-chart-up">↑ {entry.buffs}</span>
                        <span className="font-mono text-sm tabular-nums text-chart-down">↓ {entry.nerfs}</span>
                        <span
                          className={cn(
                            "font-mono text-sm tabular-nums",
                            score > 0 && "text-chart-up",
                            score < 0 && "text-chart-down",
                            score === 0 && "text-chart-muted",
                          )}
                        >
                          {score > 0 ? `+${score}` : score}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
function ChampionHistoryView() {
  const { t, i18n } = useTranslation();
  const [dateFmt, setDateFmt] = useState(() => loadAppPreferences().dateFormat);
  const [entityType, setEntityType] = useState<"champion" | "rune" | "item">("champion");
  const location = useLocation();

  useEffect(() => {
    const h = () => setDateFmt(loadAppPreferences().dateFormat);
    window.addEventListener("app-prefs-changed", h);
    return () => window.removeEventListener("app-prefs-changed", h);
  }, []);

  const [champion, setChampion] = useState<ChampionListItem | null>(null);
  const [selectedRune, setSelectedRune] = useState<RuneListItem | null>(null);
  const [selectedItem, setSelectedItem] = useState<ItemListItem | null>(null);

  const [allChamps, setAllChamps] = useState<ChampionListItem[]>([]);
  const [allRunes, setAllRunes] = useState<RuneListItem[]>([]);
  const [allItems, setAllItems] = useState<ItemListItem[]>([]);
  const [changedItemRuneTitles, setChangedItemRuneTitles] = useState<string[]>([]);
  const uniqueRunes = useMemo(() => {
    const map = new Map<string, RuneListItem>();
    for (const rune of allRunes) {
      const byId = rune.id.trim();
      const byStyleKey = `${normalizeEntityName(rune.style ?? "")}:${normalizeEntityName(rune.key ?? "")}`;
      const key =
        byId ||
        (byStyleKey !== ":" ? byStyleKey : "") ||
        normalizeEntityName(rune.nameEn) ||
        normalizeEntityName(rune.name);
      if (!key) continue;
      const prev = map.get(key);
      if (!prev || (!prev.icon_url && rune.icon_url)) {
        map.set(key, rune);
      }
    }
    return Array.from(map.values());
  }, [allRunes]);
  const uniqueItems = useMemo(() => {
    const map = new Map<string, ItemListItem>();
    for (const item of allItems) {
      const keyRu = normalizeEntityName(item.name);
      const keyEn = normalizeEntityName(item.nameEn);
      const key = keyRu || keyEn || item.id.trim();
      if (!key) continue;
      const prev = map.get(key);
      const prevHasBothNames = Boolean(prev?.name?.trim()) && Boolean(prev?.nameEn?.trim());
      const curHasBothNames = Boolean(item.name?.trim()) && Boolean(item.nameEn?.trim());
      if (
        !prev ||
        (!prev.icon_url && item.icon_url) ||
        (!prevHasBothNames && curHasBothNames)
      ) {
        map.set(key, item);
      }
    }
    return Array.from(map.values());
  }, [allItems]);
  const changedTitlesSet = useMemo(
    () => new Set(changedItemRuneTitles.map((title) => normalizeEntityName(title))),
    [changedItemRuneTitles],
  );
  const filteredRunes = useMemo(() => {
    if (!changedTitlesSet.size) return [];
    return uniqueRunes.filter((rune) => {
      const ru = normalizeEntityName(rune.name);
      const en = normalizeEntityName(rune.nameEn);
      return changedTitlesSet.has(ru) || changedTitlesSet.has(en);
    });
  }, [uniqueRunes, changedTitlesSet]);
  const filteredItems = useMemo(() => {
    if (!changedTitlesSet.size) return [];
    return uniqueItems.filter((item) => {
      const ru = normalizeEntityName(item.name);
      const en = normalizeEntityName(item.nameEn);
      return changedTitlesSet.has(ru) || changedTitlesSet.has(en);
    });
  }, [uniqueItems, changedTitlesSet]);

  const [history, setHistory] = useState<ChampionHistoryEntry[]>([]);
  const [aggregatedGroups, setAggregatedGroups] = useState<{ title: string | null, icon: string | null, changes: string[] }[]>([]);
  const [aggregatedChangeTrends, setAggregatedChangeTrends] = useState<ChangeTrend[][]>([]);
  const [loading, setLoading] = useState(false);
  const [prefill, setPrefill] = useState<{ type: "champion" | "rune" | "item"; name: string } | null>(null);

  // Состояние для иконки руны/предмета
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [useFallback, setUseFallback] = useState(false);

  // Чемпионы из бэкенда (DDragon)
  useEffect(() => {
    invoke<ChampionListItem[]>("get_all_champions")
      .then(setAllChamps)
      .catch(e => toast.error(String(e)));
  }, []);

  // Читаем query (?type=&name=) при заходе со страницы тир-листа
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const type = params.get("type") as "champion" | "rune" | "item" | null;
    const name = params.get("name");
    if (type && name) {
      setEntityType(type);
      setPrefill({ type, name });
    }
  }, [location.search]);

  // Применяем prefill, когда подгружены списки сущностей
  useEffect(() => {
    if (!prefill) return;
    const name = prefill.name.toLowerCase();
    if (prefill.type === "champion" && allChamps.length) {
      const found =
        allChamps.find(c => c.name.toLowerCase() === name || c.name_en.toLowerCase() === name) ||
        allChamps.find(c => c.name.toLowerCase().includes(name) || c.name_en.toLowerCase().includes(name));
      if (found) {
        setChampion(found);
        setSelectedRune(null);
        setSelectedItem(null);
        setPrefill(null);
      }
    } else if (prefill.type === "rune" && filteredRunes.length) {
      const found =
        filteredRunes.find(r => r.name.toLowerCase() === name || r.nameEn.toLowerCase() === name) ||
        filteredRunes.find(r => r.name.toLowerCase().includes(name) || r.nameEn.toLowerCase().includes(name));
      if (found) {
        setSelectedRune(found);
        setChampion(null);
        setSelectedItem(null);
        setPrefill(null);
      }
    } else if (prefill.type === "item" && filteredItems.length) {
      const found =
        filteredItems.find(i => i.name.toLowerCase() === name || i.nameEn.toLowerCase() === name) ||
        filteredItems.find(i => i.name.toLowerCase().includes(name) || i.nameEn.toLowerCase().includes(name));
      if (found) {
        setSelectedItem(found);
        setChampion(null);
        setSelectedRune(null);
        setPrefill(null);
      }
    }
  }, [prefill, allChamps, filteredRunes, filteredItems]);

  useEffect(() => {
    void loadItemsRunesHybrid({ itemsSrPurchasableOnly: true })
      .then(({ items, runes }) => {
        setAllItems(items);
        setAllRunes(runes);
      })
      .catch(e => {
        console.error(e);
        toast.error(t("toasts.ddragonRunesItemsError"));
      });
  }, [t]);

  // Загружем названия рун/предметов, которые менялись в последних 20 патчах
  useEffect(() => {
    invoke<string[]>("get_changed_itemsrunes_titles")
      .then(setChangedItemRuneTitles)
      .catch(e => console.error(e));
  }, []);

  // Подгрузка истории по выбранному типу сущности
  useEffect(() => {
    if (entityType === "champion") {
      if (!champion) { setHistory([]); return; }
      setLoading(true);
      invoke<ChampionHistoryEntry[]>("get_champion_history", { championName: champion.name })
        .then(setHistory)
        .catch(e => toast.error(String(e)))
        .finally(() => setLoading(false));
      return;
    }

    if (entityType === "rune") {
      if (!selectedRune) { setHistory([]); return; }
      setLoading(true);
      invoke<ChampionHistoryEntry[]>("get_rune_history", { runeName: selectedRune.name })
        .then(setHistory)
        .catch(e => toast.error(String(e)))
        .finally(() => setLoading(false));
      return;
    }

    if (entityType === "item") {
      if (!selectedItem) { setHistory([]); return; }
      setLoading(true);
      invoke<ChampionHistoryEntry[]>("get_item_history", { itemName: selectedItem.name })
        .then(setHistory)
        .catch(e => toast.error(String(e)))
        .finally(() => setLoading(false));
      return;
    }
  }, [entityType, champion, selectedRune, selectedItem]);

  // Fallback для иконок рун/предметов
  const getFallbackIcon = (title: string | null, patchIcon?: string | null): string | null => {
    if (!title) return null;
    const t = normalizeEntityName(title);
    if (entityType === "rune") {
      // Для рун: сначала патч-ноты, потом DDragon, потом архивные иконки
      if (patchIcon) return patchIcon;
      const r = filteredRunes.find(r =>
        normalizeEntityName(r.name) === t || normalizeEntityName(r.nameEn) === t
      );
      return r?.icon_url || null;
    }
    if (entityType === "item") {
      const it = findItemByName(filteredItems, title);
      return it?.icon_url || null;
    }
    return null;
  };

  // Обновление иконки для рун/предметов
  useEffect(() => {
    if (entityType === "champion") {
      setIconUrl(null);
      setUseFallback(false);
      return;
    }

    const lastChange = history[history.length - 1]?.change;
    if (entityType === "rune") {
      const url = lastChange?.image_url || getFallbackIcon(selectedRune?.name || null, lastChange?.image_url || null);
      setIconUrl(url);
      setUseFallback(false);
    } else if (entityType === "item") {
      const url = getFallbackIcon(selectedItem?.name || null);
      setIconUrl(url);
      setUseFallback(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, selectedRune, selectedItem, history.length]);

  useEffect(() => {
    if (!history || history.length === 0) return;

    // 1. Calculate Net Changes for Summary
    // Strategy: Group by Ability/Stat Title. Then try to parse changes.
    // If we detect "Stat: X -> Y" and later "Stat: Y -> Z", we want "Stat: X -> Z".

    const groups = new Map<string, { icon: string | null, rawChanges: { date: Date, text: string }[] }>();

    // Process oldest to newest to build the chain
    // Sort by version ascending since dates might be identical
    const chronologicalHistory = [...history].sort((a, b) => compareVersions(a.patch_version, b.patch_version));

    chronologicalHistory.forEach(h => {
      // Приоритет иконки: сначала из change.image_url (для рун/предметов), потом из details
      const mainIcon = h.change.image_url || null;
      if (h.change.details) {
        h.change.details.forEach(d => {
          const key = d.title || t("patchView.defaultStats");
          const detailIcon = d.icon_url || null;
          if (!groups.has(key)) {
            groups.set(key, { icon: detailIcon || mainIcon, rawChanges: [] });
          } else if (detailIcon && !groups.get(key)?.icon) {
            groups.get(key)!.icon = detailIcon;
          }
          if (d.changes) {
            d.changes.forEach(c => {
              groups.get(key)!.rawChanges.push({ date: new Date(h.date), text: c });
            });
          }
        });
      }
    });

    // Smart Deduplication and Net Change Calculation
    const finalGroups: { title: string | null, icon: string | null, changes: string[] }[] = [];

    groups.forEach((value, key) => {
      // Map to track numeric stats: "Stat Name" -> { startVal, endVal, fullStart, fullEnd }
      // This is hard to do perfectly with regex, so we use a simplified approach:
      // If multiple lines look like they describe the same stat (fuzzy match name), we keep the "Chain".

      // Simplest approach for now satisfying user:
      // If we have multiple entries for the exact same stat string structure "Name: A -> B", keep the oldest A and newest B.

      const statChains = new Map<string, { start: string, end: string, template: string }>();
      const otherChanges: string[] = [];

      value.rawChanges.forEach(item => {
        // Try to parse "Name: Val1 -> Val2" or "Name Val1 -> Val2"
        // Relaxed Regex to capture ANY value content including text
        const match = item.text.match(/^(.+?)(?::\s*|\s+)(.*?)\s*(?:→|⇒|->)\s*(.*)$/);

        if (match) {
          const statName = match[1].trim();
          const oldVal = match[2].trim();
          const newVal = match[3].trim();

          if (!statChains.has(statName)) {
            statChains.set(statName, { start: oldVal, end: newVal, template: item.text });
          } else {
            // Update the end value to the newest one
            statChains.get(statName)!.end = newVal;
          }
        } else {
          // If not a simple numeric chain, just add to list (but we want to avoid duplicates if exactly same?)
          // User said: "It is written twice".
          // We will just keep unique strings for non-numeric changes.
          // But if it's a text change that evolves?
          // Ideally we show the LATEST state description.
          otherChanges.push(item.text);
        }
      });

      // Build final list
      const computedChanges: string[] = [];

      // Add chained stats
      statChains.forEach((val, name) => {
        // Reconstruct string: "Name: Start -> End"
        // Try to preserve original separator from template if possible, or default to ": "
        const separator = val.template.includes(':') ? ': ' : ' ';
        computedChanges.push(`${name}${separator}${val.start} → ${val.end}`);
      });

      // Add other changes (deduplicated)
      // We prefer the LATEST occurrence of a text description if they conflict? 
      // Or just all unique ones? User implies "Summary" should be concise.
      // Let's just take unique ones.
      const uniqueOthers = Array.from(new Set(otherChanges));
      computedChanges.push(...uniqueOthers);

      if (computedChanges.length > 0) {
        finalGroups.push({
          title: key,
          icon: value.icon,
          changes: computedChanges
        });
      }
    });

    setAggregatedGroups(finalGroups);
  }, [history, t]);

  useEffect(() => {
    if (!aggregatedGroups.length) {
      setAggregatedChangeTrends([]);
      return;
    }
    let cancelled = false;
    const texts = aggregatedGroups.flatMap((g) => g.changes);
    invoke<ChangeTrend[]>("analyze_change_trends", { texts })
      .then((trends) => {
        if (cancelled) return;
        const nested: ChangeTrend[][] = [];
        let offset = 0;
        for (const g of aggregatedGroups) {
          const n = g.changes.length;
          nested.push(trends.slice(offset, offset + n) as ChangeTrend[]);
          offset += n;
        }
        setAggregatedChangeTrends(nested);
      })
      .catch((e) => {
        console.error(e);
        toast.error(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [aggregatedGroups]);

  return (
    <div className="animate-in fade-in duration-500">
      <article className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm shadow-black/3 dark:shadow-black/20">
        <div className="border-b border-border/50 bg-muted/10 px-5 py-6 sm:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t("history.timelineCaption")}
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">
                {t("nav.history")}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {t("history.pageIntro")}
              </p>
            </div>
            <Tabs
              value={entityType}
              onValueChange={(v) => {
                setEntityType(v as "champion" | "rune" | "item");
                setHistory([]);
                setChampion(null);
                setSelectedRune(null);
                setSelectedItem(null);
              }}
              className="w-full lg:w-auto"
            >
              <TabsList className="inline-flex h-auto w-full max-w-full flex-wrap gap-1 rounded-xl bg-muted/25 p-1 lg:w-auto">
                <TabsTrigger
                  value="champion"
                  className="flex-1 rounded-lg px-3 py-2.5 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4"
                >
                  {t("tier.champions")}
                </TabsTrigger>
                <TabsTrigger
                  value="rune"
                  className="flex-1 rounded-lg px-3 py-2.5 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4"
                >
                  {t("tier.runes")}
                </TabsTrigger>
                <TabsTrigger
                  value="item"
                  className="flex-1 rounded-lg px-3 py-2.5 text-sm font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4"
                >
                  {t("tier.items")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        <div className="space-y-6 px-5 py-6 sm:px-8">
          <div className="rounded-xl border border-border/50 bg-muted/10 p-4 sm:p-5">
            {entityType === "champion" ? (
              <ChampionSelect
                items={allChamps}
                selected={champion}
                onSelect={(c) => {
                  setChampion(c);
                  setSelectedRune(null);
                  setSelectedItem(null);
                }}
              />
            ) : entityType === "rune" ? (
              <RuneSelect
                items={filteredRunes}
                selected={selectedRune}
                onSelect={(r) => {
                  setSelectedRune(r);
                  setChampion(null);
                  setSelectedItem(null);
                }}
              />
            ) : (
              <ItemSelect
                items={filteredItems}
                selected={selectedItem}
                onSelect={(it) => {
                  setSelectedItem(it);
                  setChampion(null);
                  setSelectedRune(null);
                }}
              />
            )}
          </div>

          {!loading && history.length > 0 && (
            <div className="relative overflow-hidden rounded-xl border border-border/50 bg-muted/5 p-5 sm:p-6">
              <div className="pointer-events-none absolute -right-4 -top-4 opacity-[0.07]">
                <History className="h-32 w-32 text-muted-foreground" strokeWidth={1.25} />
              </div>
              <div className="relative z-10 mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
                {entityType === "champion" && champion && (
                  <img
                    src={resolveUiImageSrc(champion.icon_url)}
                    className="h-16 w-16 rounded-full border-4 border-background bg-card object-cover shadow-md"
                  />
                )}
                {entityType !== "champion" && (() => {
                  return iconUrl ? (
                    <img
                      src={resolveUiImageSrc(iconUrl)}
                      className="h-16 w-16 rounded-full border-4 border-background bg-card object-cover shadow-md"
                      alt=""
                      onError={async () => {
                        if (entityType === "rune" && selectedRune?.key && selectedRune?.style && !useFallback) {
                          setUseFallback(true);
                          try {
                            const fallback = await invoke<string | null>("get_fallback_rune_icon", {
                              styleKey: selectedRune.style,
                              runeKey: selectedRune.key
                            });
                            if (fallback) setIconUrl(fallback);
                          } catch (e) {
                            // Игнорируем ошибки
                          }
                        }
                      }}
                    />
                  ) : null;
                })()}
                <div className="min-w-0">
                  <h3 className="text-xl font-semibold tracking-normal text-foreground sm:text-2xl">
                    {entityType === "champion" && champion && champion.name}
                    {entityType === "rune" && selectedRune && selectedRune.name}
                    {entityType === "item" && selectedItem && selectedItem.name}
                  </h3>
                  <UiBadge variant="secondary" className="mt-2 rounded-full font-normal">
                    {t("history.summaryBadge")}
                  </UiBadge>
                </div>
              </div>
              <div className="relative z-10 space-y-5 rounded-xl border border-border/50 bg-card/90 p-4 text-foreground shadow-inner sm:p-5">
                {aggregatedGroups.map((group, i) => (
                  <div key={i}>
                    {group.title && (
                      <div className="mb-2 flex items-center gap-2 border-b border-border/50 pb-2">
                        {(() => {
                          let icon: string | null = null;
                          if (entityType === "rune") {
                            // Для рун: сначала патч-ноты, потом DDragon
                            icon = group.icon || getFallbackIcon(group.title, group.icon || null);
                          } else if (entityType === "item") {
                            // Для предметов: всегда DDragon (игнорируем патч-ноты)
                            icon = getFallbackIcon(group.title);
                          } else {
                            icon = group.icon || getFallbackIcon(group.title);
                          }
                          return icon ? (
                            <img src={resolveUiImageSrc(icon)} className="h-6 w-6 rounded bg-muted" alt="" />
                          ) : null;
                        })()}
                        <h4 className="text-sm font-semibold text-foreground">{group.title}</h4>
                      </div>
                    )}
                    <ul className="space-y-2 pl-2">
                      {group.changes.map((change, j) => {
                        const trend = aggregatedChangeTrends[i]?.[j] ?? "neutral";
                        const lower = change.toLowerCase();
                        const isNew = lower.includes("новое") || lower.includes("new");
                        const isRemoved = lower.includes("удалено") || lower.includes("removed");
                        const liClasses = cn(
                          "relative flex items-start justify-between gap-2 rounded-md border-l-2 border-primary/30 pl-3 pr-2 text-sm leading-relaxed",
                          isNew && "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
                          isRemoved && "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100",
                        );
                        const html = highlightSpecialTags(
                          change
                            .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold">$1</span>')
                            .replace(/⇒/g, '<span class="text-muted-foreground mx-1">→</span>')
                        );
                        return (
                          <li key={j} className={liClasses}>
                            <span dangerouslySetInnerHTML={{
                              __html: html
                            }} />
                            <span className="shrink-0 mt-0.5">
                              {trend === "up" && <ArrowUp className="w-3 h-3 text-green-600" />}
                              {trend === "down" && <ArrowDown className="w-3 h-3 text-red-600" />}
                              {trend === "neutral" && <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
          {loading && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <RefreshCw className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{t("history.loading")}</p>
            </div>
          )}
          {!loading && history.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 px-6 py-14 text-center text-sm text-muted-foreground">
              {t("history.noData")}
            </div>
          )}
          {history.length > 0 && (
            <div className="border-t border-border/40 pt-2">
              <p className="mb-6 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t("history.perPatch")}
              </p>
              <div className="relative ml-2 space-y-8 border-l border-border/60 pb-6 pl-5 sm:ml-4 sm:pl-8">
                {[...history].sort((a, b) => compareVersions(b.patch_version, a.patch_version)).map((item, idx) => (
                  <div key={idx} className="group relative">
                    <div className="absolute -left-[calc(0.25rem+1px)] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-muted ring-2 ring-background transition-colors group-hover:bg-primary sm:-left-[calc(1.25rem+1px)]" />
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-primary px-3 py-1 text-xs font-semibold uppercase tracking-wide text-primary-foreground shadow-sm">
                        {t("history.patchLabel", { version: item.patch_version })}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatAppDate(item.date, dateFmt, i18n.language)}
                      </span>
                    </div>
                    <div className="rounded-xl border border-border/50 bg-card/90 p-4 text-foreground shadow-sm transition-all duration-200 hover:border-primary/20 hover:shadow-md sm:p-6">
                      <div className="mb-4 flex flex-col gap-3 border-b border-border/50 pb-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <h3 className="text-lg font-semibold leading-snug text-foreground sm:text-xl">{item.change.title}</h3>
                          {item.change.summary && (
                            <p className="mt-2 rounded-lg border border-border/50 bg-muted/30 p-3 text-sm italic leading-relaxed text-muted-foreground">
                              &ldquo;{item.change.summary}&rdquo;
                            </p>
                          )}
                        </div>
                        <PatchNoteBadge type={item.change.change_type} />
                      </div>
                      <div className="space-y-6">
                        {Array.isArray(item.change.details) && item.change.details.map((block, i) => (
                          <div key={i} className="animate-in fade-in duration-500 delay-75">
                            {block.title && (
                              <div className="flex items-center gap-3 mb-3">
                                {block.icon_url && <img src={resolveUiImageSrc(block.icon_url)} className="h-8 w-8 rounded-lg border border-border bg-muted shadow-sm" />}
                                <h4 className="border-b-2 border-transparent pb-0.5 text-sm font-bold text-foreground transition-colors hover:border-primary">
                                  {block.title}
                                </h4>
                              </div>
                            )}
                            <ul className="space-y-2">
                              {Array.isArray(block.changes) && block.changes.map((change, j) => (
                                (() => {
                                  const lower = change.toLowerCase();
                                  const isNew = lower.includes("новое") || lower.includes("new");
                                  const isRemoved = lower.includes("удалено") || lower.includes("removed");
                                  const liClasses = cn(
                                    "rounded-lg border border-border bg-card p-3 text-sm text-foreground transition-colors hover:bg-accent/50",
                                    isNew && "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
                                    isRemoved && "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100",
                                  );
                                  return (
                                    <li key={j} className={liClasses}>
                                      <span
                                        dangerouslySetInnerHTML={{
                                          __html: highlightSpecialTags(
                                            change
                                              .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold">$1</span>')
                                              .replace(/⇒/g, '<span class="text-muted-foreground mx-1">→</span>')
                                          ),
                                        }}
                                      />
                                    </li>
                                  );
                                })()
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </article>
    </div>
  );
}

function patchNoteIsBugFix(note: PatchNoteEntry): boolean {
  const title = note.title.trim().toLowerCase();
  return (
    note.change_type === "Fix" ||
    note.category === "BugFixes" ||
    title === "исправление ошибки" ||
    title === "bug fix"
  );
}

function findItemByLooseTitle(title: string, items: ItemListItem[]): ItemListItem | undefined {
  const nameLower = title.trim().toLowerCase();
  let it = items.find((i) => {
    const ru = i.name.toLowerCase();
    const en = i.nameEn.toLowerCase();
    return (
      ru === nameLower ||
      en === nameLower ||
      ru.includes(nameLower) ||
      nameLower.includes(ru) ||
      en.includes(nameLower) ||
      nameLower.includes(en)
    );
  });
  if (!it && nameLower.includes("солнечного пламени")) {
    it = items.find((i) => i.nameEn.toLowerCase().includes("sunfire"));
  }
  return it;
}

function findRuneByLooseTitle(title: string, runes: RuneListItem[]): RuneListItem | undefined {
  const lower = title.trim().toLowerCase();
  return runes.find((r) => {
    const ru = r.name.toLowerCase();
    const en = r.nameEn.toLowerCase();
    return (
      ru === lower ||
      en === lower ||
      ru.includes(lower) ||
      lower.includes(ru) ||
      en.includes(lower) ||
      lower.includes(en)
    );
  });
}

function resolvePatchNoteLeadIconUrl(
  note: PatchNoteEntry,
  champs: ChampionListItem[],
  items: ItemListItem[],
  runes: RuneListItem[],
): string | undefined {
  const direct = cleanUrl(note.image_url);
  if (direct) return direct;
  if (note.category === "Champions") {
    const t = note.title.trim();
    const lower = t.toLowerCase();
    const c = champs.find(
      (x) =>
        x.name === t ||
        x.name_en === t ||
        x.name.toLowerCase() === lower ||
        x.name_en.toLowerCase() === lower,
    );
    return c ? cleanUrl(c.icon_url) : undefined;
  }
  if (note.category === "Items") {
    const it = findItemByLooseTitle(note.title, items);
    return it ? cleanUrl(it.icon_url) : undefined;
  }
  if (note.category === "Runes") {
    const r = findRuneByLooseTitle(note.title, runes);
    return r ? cleanUrl(r.icon_url) : undefined;
  }
  if (note.category === "ItemsRunes") {
    const it = findItemByLooseTitle(note.title, items);
    if (it) return cleanUrl(it.icon_url);
    const r = findRuneByLooseTitle(note.title, runes);
    return r ? cleanUrl(r.icon_url) : undefined;
  }
  if (
    note.category === "ModeArena" ||
    note.category === "ModeAram" ||
    note.category === "ModeAramChaos" ||
    note.category === "ModeAramAugments"
  ) {
    const it = findItemByLooseTitle(note.title, items);
    if (it) return cleanUrl(it.icon_url);
    const t = note.title.trim();
    const lower = t.toLowerCase();
    const c = champs.find(
      (x) =>
        x.name === t ||
        x.name_en === t ||
        x.name.toLowerCase() === lower ||
        x.name_en.toLowerCase() === lower,
    );
    if (c) return cleanUrl(c.icon_url);
    return undefined;
  }
  return undefined;
}

function PatchNoteLeadIcon({
  note,
  iconUrl,
}: {
  note: PatchNoteEntry;
  iconUrl?: string;
}) {
  if (patchNoteIsBugFix(note)) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-primary">
        <Wrench className="h-6 w-6 shrink-0" strokeWidth={2} aria-hidden />
      </div>
    );
  }
  return <ChampionIcon candidates={note.icon_candidates} url={iconUrl} name={note.title} />;
}

function PatchReleaseView({ data, version, patchesList, onVersionChange, loading, newPatches, noLocalCache }: { data: PatchData | null, version: string, patchesList: string[], onVersionChange: (v: string) => void, loading: boolean, newPatches?: Set<string>, noLocalCache?: boolean }) {
  const { t } = useTranslation();
  const [championList, setChampionList] = useState<ChampionListItem[]>([]);
  const [itemList, setItemList] = useState<ItemListItem[]>([]);
  const [runeList, setRuneList] = useState<RuneListItem[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
  const [changeTypeFilter, setChangeTypeFilter] = useState<string>("All");
  const { items: skinYoutubeFeed } = useYoutubeFeed(YOUTUBE_CHANNEL_SKINSPOTLIGHTS);
  useEffect(() => {
    invoke<ChampionListItem[]>("get_all_champions")
      .then(setChampionList)
      .catch(() => { });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { items, runes } = await loadItemsRunesHybrid();
        if (!cancelled) {
          setItemList(items);
          setRuneList(runes);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCategoryFilter("All");
    setChangeTypeFilter("All");
  }, [data?.version]);

  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxUrl(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxUrl]);

  const patchNotes = data?.patch_notes ?? [];
  const skinYoutubeSearchQuery = (title: string) =>
    buildSkinSpotlightYoutubeSearch(title, championList)?.searchQuery ?? `SkinSpotlights ${title}`;
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of patchNotes) {
      m.set(n.category, (m.get(n.category) ?? 0) + 1);
    }
    return m;
  }, [patchNotes]);

  const categoriesWithNotes = useMemo(() => {
    const ordered = PATCH_NOTE_CATEGORY_TAB_ORDER.filter((c) => (categoryCounts.get(c) ?? 0) > 0);
    const extras = [...categoryCounts.keys()].filter(
      (c) => !PATCH_NOTE_CATEGORY_TAB_ORDER.includes(c) && (categoryCounts.get(c) ?? 0) > 0,
    );
    extras.sort();
    return [...ordered, ...extras];
  }, [categoryCounts]);

  const filteredPatchNotes = useMemo(() => {
    return patchNotes.filter((n) => {
      const byCategory = categoryFilter === "All" || n.category === categoryFilter;
      const byType = changeTypeFilter === "All" || n.change_type === changeTypeFilter;
      return byCategory && byType;
    });
  }, [patchNotes, categoryFilter, changeTypeFilter]);

  const availableChangeTypes = useMemo(() => {
    const opts = new Set<string>();
    for (const note of patchNotes) {
      const raw = note.change_type?.trim();
      if (raw) opts.add(raw);
    }
    return ["All", ...Array.from(opts)];
  }, [patchNotes]);

  if (noLocalCache && !data) {
    return <EmptyState message={t("patchView.noLocalPatches")} />;
  }
  if (loading && !data) {
    return (
      <div className="animate-in fade-in duration-300">
        <div className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm">
          <Skeleton className="h-[min(38vh,320px)] w-full rounded-none" />
          <div className="space-y-4 p-6">
            <Skeleton className="h-10 w-full max-w-md" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-4 border-t border-border/50 p-6 pt-0">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </div>
    );
  }
  if (!data) return <EmptyState />;
  const banner = cleanUrl(data.banner_url ?? undefined);

  const patchHeaderBar = (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t("patchView.lolNotes")}
        </p>
        <h2 className="text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">
          {t("patchView.patchTitle", { version: data.version })}
        </h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <UiBadge variant="secondary" className="rounded-full px-3 font-normal">
          Riot Games
        </UiBadge>
        <CustomPatchSelect
          value={version}
          options={patchesList}
          onChange={onVersionChange}
          loading={loading}
          newPatches={newPatches}
        />
      </div>
    </div>
  );

  return (
    <div className="animate-in fade-in duration-500">
      <article className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm shadow-black/3 dark:shadow-black/20">
        {banner ? (
          <div className="relative">
            <div className="max-h-[min(42vh,440px)] min-h-[200px] w-full overflow-hidden">
              <img
                src={banner}
                alt=""
                className="h-full w-full max-h-[min(42vh,440px)] min-h-[200px] object-cover object-center"
              />
            </div>
            <div
              className="pointer-events-none absolute inset-0 bg-linear-to-t from-card via-card/40 to-transparent"
              aria-hidden
            />
            <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-card px-5 pb-6 pt-16 sm:px-8">
              {patchHeaderBar}
            </div>
          </div>
        ) : (
          <div className="border-b border-border/50 bg-muted/15 px-5 py-8 sm:px-8">{patchHeaderBar}</div>
        )}

        {data.patch_notes.length > 0 && (
          <Tabs value={categoryFilter} onValueChange={setCategoryFilter} className="w-full">
            <div className="sticky top-14 z-10 border-b border-border/50 bg-background/90 px-4 py-3 backdrop-blur-md sm:px-6">
              <div className="overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <TabsList className="inline-flex h-auto min-h-10 w-max min-w-full flex-nowrap justify-start gap-1 rounded-xl bg-muted/25 p-1 sm:flex-wrap">
                  <TabsTrigger
                    value="All"
                    className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium data-[state=active]:shadow-sm"
                  >
                    {t("patchView.allCount", { count: data.patch_notes.length })}
                  </TabsTrigger>
                  {categoriesWithNotes.map((c) => (
                    <TabsTrigger
                      key={c}
                      value={c}
                      className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium data-[state=active]:shadow-sm"
                    >
                      {patchNoteCategoryLabel(c, t)} ({categoryCounts.get(c) ?? 0})
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              {availableChangeTypes.length > 1 ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {availableChangeTypes.map((type) => (
                    <PatchNoteBadge
                      key={type}
                      type={type}
                      onClick={() => setChangeTypeFilter(type)}
                      active={changeTypeFilter === type}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </Tabs>
        )}

        <div className="divide-y divide-border/50">
          {data.patch_notes.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground sm:px-8">
              {t("patchView.noNotes")}
            </div>
          ) : filteredPatchNotes.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground sm:px-8">
              {t("patchView.emptyCategory")}
            </div>
          ) : categoryFilter === "UpcomingSkinsChromas" ? (
            <>
              <div className="grid gap-4 px-5 py-8 sm:grid-cols-2 sm:px-8 lg:grid-cols-3">
                {filteredPatchNotes.map((note) => (
                  <div
                    key={note.id}
                    className="overflow-hidden rounded-xl border border-border/50 bg-muted/10 shadow-sm"
                  >
                    {note.image_url ? (
                      <button
                        type="button"
                        className="aspect-video w-full overflow-hidden bg-muted/30 p-0 text-left"
                        onClick={() => {
                          const u = resolveUiImageSrc(note.image_url);
                          if (u) setLightboxUrl(u);
                        }}
                      >
                        <img
                          src={resolveUiImageSrc(note.image_url) ?? ""}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ) : null}
                    <div className="flex items-start justify-between gap-2 p-3">
                      <h3 className="text-sm font-semibold leading-snug">{note.title}</h3>
                      <PatchNoteBadge
                        type={note.change_type}
                        onClick={() => setChangeTypeFilter(note.change_type)}
                        active={changeTypeFilter === note.change_type}
                      />
                    </div>
                    <div className="border-t border-border/40 px-3 pb-3 pt-2">
                      <SkinSpotlightEmbed
                        feed={skinYoutubeFeed}
                        noteTitle={note.title}
                        champions={championList}
                        searchUrl={`https://www.youtube.com/results?search_query=${encodeURIComponent(
                          skinYoutubeSearchQuery(note.title),
                        )}`}
                        searchLabel={t("patchView.searchOnYoutube")}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-border/50 px-5 py-5 sm:px-8">
                <YoutubeChannelPanel
                  channelId={YOUTUBE_CHANNEL_SKINSPOTLIGHTS}
                  channelPageUrl={YOUTUBE_URL_SKINSPOTLIGHTS}
                  heading={t("patchView.skinSpotlightsBlock")}
                  matchTitles={filteredPatchNotes.map((n) => n.title)}
                  feedItems={skinYoutubeFeed}
                />
              </div>
            </>
          ) : (
            <>
              {filteredPatchNotes.map((note) => {
                if (categoryFilter === "All" && note.category === "UpcomingSkinsChromas") {
                  const imgUrl = resolveUiImageSrc(note.image_url);
                  const ytSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent(
                    skinYoutubeSearchQuery(note.title),
                  )}`;
                  return (
                    <div
                      key={note.id}
                      className="group px-5 py-8 transition-colors hover:bg-muted/20 sm:px-8"
                    >
                      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 gap-4">
                          {imgUrl ? (
                            <button
                              type="button"
                              className="relative h-32 w-48 shrink-0 overflow-hidden rounded-lg border border-border/50 bg-muted/20"
                              onClick={() => setLightboxUrl(imgUrl)}
                            >
                              <img src={imgUrl} alt="" className="h-full w-full object-cover" />
                            </button>
                          ) : null}
                          <div className="min-w-0">
                            <h3 className="text-lg font-semibold leading-snug tracking-normal sm:text-xl">
                              {note.title}
                            </h3>
                            {note.summary && (
                              <p className="mt-2 max-w-2xl border-l-2 border-primary/20 pl-3 text-sm leading-relaxed text-muted-foreground">
                                {note.summary}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-row flex-wrap items-center justify-end gap-2 sm:flex-col sm:items-end">
                          <button
                            type="button"
                            onClick={() => setCategoryFilter(note.category)}
                            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                          >
                            <UiBadge variant="outline" className="font-normal">
                              {patchNoteCategoryLabel(note.category, t)}
                            </UiBadge>
                          </button>
                          <PatchNoteBadge
                            type={note.change_type}
                            onClick={() => setChangeTypeFilter(note.change_type)}
                            active={changeTypeFilter === note.change_type}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => void openExternalUrl(ytSearch)}
                          >
                            <Youtube className="h-4 w-4 shrink-0" aria-hidden />
                            {t("patchView.searchOnYoutube")}
                          </Button>
                        </div>
                      </div>
                      <SkinSpotlightEmbed
                        feed={skinYoutubeFeed}
                        noteTitle={note.title}
                        champions={championList}
                        searchUrl={ytSearch}
                        searchLabel={t("patchView.searchOnYoutube")}
                      />
                    </div>
                  );
                }
                return (
                  <div
                    key={note.id}
                    className="group px-5 py-8 transition-colors hover:bg-muted/20 sm:px-8"
                  >
                    <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 gap-4">
                        <PatchNoteLeadIcon
                          note={note}
                          iconUrl={resolvePatchNoteLeadIconUrl(note, championList, itemList, runeList)}
                        />
                        <div className="min-w-0">
                          <h3 className="text-lg font-semibold leading-snug tracking-normal sm:text-xl">
                            {note.title}
                          </h3>
                          {note.summary && (
                            <p className="mt-2 max-w-2xl border-l-2 border-primary/20 pl-3 text-sm leading-relaxed text-muted-foreground">
                              {note.summary}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-row flex-wrap items-center justify-end gap-2 sm:flex-col sm:items-end">
                        {categoryFilter === "All" && (
                          <button
                            type="button"
                            onClick={() => setCategoryFilter(note.category)}
                            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                          >
                            <UiBadge variant="outline" className="font-normal">
                              {patchNoteCategoryLabel(note.category, t)}
                            </UiBadge>
                          </button>
                        )}
                        <PatchNoteBadge
                          type={note.change_type}
                          onClick={() => setChangeTypeFilter(note.change_type)}
                          active={changeTypeFilter === note.change_type}
                        />
                      </div>
                    </div>
                    <div className="ml-0 space-y-4 border-l-2 border-border/60 pl-4 sm:ml-2 sm:pl-5">
                      {Array.isArray(note.details) && note.details.map((block, i) => (
                        <div key={i}>
                          {block.title && (
                            <div className="mb-2 flex items-center gap-2">
                              {block.icon_url && (
                                <img src={resolveUiImageSrc(block.icon_url)} className="h-6 w-6 rounded bg-muted" alt="" />
                              )}
                              <h4 className="text-sm font-semibold text-foreground">
                                {block.title === WIKI_AUGMENT_DETAIL_TITLE
                                  ? t("patchView.wikiAugmentWikiHeading")
                                  : block.title}
                              </h4>
                            </div>
                          )}
                          <ul className="space-y-2">
                            {Array.isArray(block.changes) && block.changes.map((change, j) => {
                              const wikiAugmentBlock = block.title === WIKI_AUGMENT_DETAIL_TITLE;
                              const displayWiki = wikiAugmentBlock
                                ? wikiAugmentToPlain(change, { maxChars: 12000 })
                                : "";
                              const lower = wikiAugmentBlock ? displayWiki.toLowerCase() : change.toLowerCase();
                              const isNew = lower.includes("новое") || lower.includes("new");
                              const isRemoved = lower.includes("удалено") || lower.includes("removed");
                              const liClasses = cn(
                                "rounded-lg px-2.5 py-1.5 text-sm leading-relaxed text-foreground",
                                isNew && "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
                                isRemoved && "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100",
                              );
                              return (
                                <li key={j} className={liClasses}>
                                  {wikiAugmentBlock ? (
                                    <span>{displayWiki}</span>
                                  ) : (
                                    <span
                                      dangerouslySetInnerHTML={{
                                        __html: highlightSpecialTags(
                                          change
                                            .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold">$1</span>')
                                            .replace(/⇒/g, '<span class="text-muted-foreground mx-1">→</span>')
                                        ),
                                      }}
                                    />
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </article>
      {lightboxUrl ? (
        <div
          className="fixed inset-0 z-100 flex items-center justify-center bg-black/85 p-4"
          role="presentation"
          onClick={() => setLightboxUrl(null)}
        >
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="fixed right-4 top-4 z-110 h-10 w-10 rounded-full shadow-lg"
            aria-label={t("patchView.closeImage")}
            onClick={(e) => {
              e.stopPropagation();
              setLightboxUrl(null);
            }}
          >
            <X className="h-5 w-5" aria-hidden />
          </Button>
          <img
            src={lightboxUrl}
            alt=""
            className="max-h-[90vh] w-auto max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </div>
  );
}

function PatchNoteBadge({
  type,
  onClick,
  active,
}: {
  type: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const map: Record<string, NonNullable<ComponentProps<typeof UiBadge>["variant"]>> = {
    All: "secondary",
    Buff: "success",
    Nerf: "destructive",
    Adjusted: "warning",
    New: "default",
    Removed: "outline",
    Fix: "secondary",
    None: "outline",
  };
  const labels: Record<string, string> = {
    Removed: t("badge.Removed"),
    New: t("badge.New"),
  };
  const variant = map[type] ?? "secondary";
  if (type === "None") return null;
  const badge = (
    <UiBadge variant={variant} className={active ? "ring-2 ring-primary/40" : undefined}>
      {labels[type] ?? type}
    </UiBadge>
  );
  if (!onClick) return badge;
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {badge}
    </button>
  );
}

// Helper components (ChampionSelect, ChampionIcon, EmptyState, Badge, etc.)
function ChampionSelect({ items, selected, onSelect }: { items: ChampionListItem[], selected: ChampionListItem | null, onSelect: (i: ChampionListItem) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const q = query.toLowerCase();
  const filtered = items
    .filter(i =>
      i.name.toLowerCase().includes(q) || i.name_en.toLowerCase().includes(q)
    )
    .sort((a, b) => {
      const ar = a.name.toLowerCase();
      const ae = a.name_en.toLowerCase();
      const br = b.name.toLowerCase();
      const be = b.name_en.toLowerCase();
      const score = (name: string, nameEn: string) => {
        if (!q) return 0;
        if (name === q || nameEn === q) return 0;
        if (name.startsWith(q) || nameEn.startsWith(q)) return 1;
        return 2;
      };
      return score(ar, ae) - score(br, be);
    });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-auto min-h-11 w-full max-w-lg justify-between px-3 py-2 font-normal"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {selected ? (
              <>
                <img src={resolveUiImageSrc(selected.icon_url)} className="h-6 w-6 shrink-0 rounded-full border border-border" alt="" />
                <span className="truncate font-semibold text-foreground">{selected.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{t("select.pickChampion")}</span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <div className="flex flex-col">
          <div className="border-b p-2">
            <Input
              placeholder={t("select.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9"
            />
          </div>
          <ScrollArea className="h-72">
            <div className="flex flex-col gap-0.5 p-1">
              {filtered.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">{t("select.noMatches")}</p>
              ) : (
                filtered.map((item, idx) => (
                  <Button
                    key={`${item.name}-${item.name_en}-${idx}`}
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-3 px-2 py-2"
                    onClick={() => {
                      onSelect(item);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <img src={resolveUiImageSrc(item.icon_url)} className="h-8 w-8 shrink-0 rounded bg-muted" loading="lazy" alt="" />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      {item.name_en !== item.name && (
                        <span className="text-xs text-muted-foreground">{item.name_en}</span>
                      )}
                    </div>
                    {selected?.name === item.name && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </Button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RuneSelect({ items, selected, onSelect }: { items: RuneListItem[], selected: RuneListItem | null, onSelect: (i: RuneListItem) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const q = query.toLowerCase();
  const filtered = items
    .filter(i =>
      i.name.toLowerCase().includes(q) || i.nameEn.toLowerCase().includes(q)
    )
    .sort((a, b) => {
      const ar = a.name.toLowerCase();
      const ae = a.nameEn.toLowerCase();
      const br = b.name.toLowerCase();
      const be = b.nameEn.toLowerCase();
      const score = (name: string, nameEn: string) => {
        if (!q) return 0;
        if (name === q || nameEn === q) return 0;
        if (name.startsWith(q) || nameEn.startsWith(q)) return 1;
        return 2;
      };
      return score(ar, ae) - score(br, be);
    });

  const runeImgOnError = (item: RuneListItem) => (e: SyntheticEvent<HTMLImageElement>) => {
    if (item.key && item.style) {
      invoke<string | null>("get_fallback_rune_icon", {
        styleKey: item.style,
        runeKey: item.key
      }).then(fallback => {
        if (fallback && e.currentTarget) {
          const cleaned = cleanUrl(fallback);
          if (cleaned) e.currentTarget.src = cleaned;
        }
      }).catch(() => { });
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-auto min-h-11 w-full max-w-lg justify-between px-3 py-2 font-normal"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {selected ? (
              <>
                <img
                  src={resolveUiImageSrc(selected.icon_url)}
                  className="h-6 w-6 shrink-0 rounded-full border border-border bg-muted object-cover"
                  alt={selected.name}
                  onError={runeImgOnError(selected)}
                />
                <span className="truncate font-semibold text-foreground">{selected.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{t("select.pickRune")}</span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <div className="flex flex-col">
          <div className="border-b p-2">
            <Input
              placeholder={t("select.searchRuneItem")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9"
            />
          </div>
          <ScrollArea className="h-72">
            <div className="flex flex-col gap-0.5 p-1">
              {filtered.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">{t("select.noMatches")}</p>
              ) : (
                filtered.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-3 px-2 py-2"
                    onClick={() => {
                      onSelect(item);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <img
                      src={resolveUiImageSrc(item.icon_url)}
                      className="h-8 w-8 shrink-0 rounded-full border border-border bg-muted object-cover"
                      alt={item.name}
                      loading="lazy"
                      onError={runeImgOnError(item)}
                    />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      {item.nameEn !== item.name && (
                        <span className="text-xs text-muted-foreground">{item.nameEn}</span>
                      )}
                    </div>
                    {selected?.name === item.name && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </Button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ItemSelect({ items, selected, onSelect }: { items: ItemListItem[], selected: ItemListItem | null, onSelect: (i: ItemListItem) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const q = query.toLowerCase();
  const uniq = Array.from(
    items.reduce((acc, item) => {
      const key = `${normalizeEntityName(item.name)}|${normalizeEntityName(item.nameEn)}`;
      const prev = acc.get(key);
      if (!prev || (!prev.icon_url && item.icon_url)) {
        acc.set(key, item);
      }
      return acc;
    }, new Map<string, ItemListItem>()),
  ).map(([, item]) => item);
  const filtered = uniq
    .filter(i =>
      i.name.toLowerCase().includes(q) || i.nameEn.toLowerCase().includes(q)
    )
    .sort((a, b) => {
      const ar = a.name.toLowerCase();
      const ae = a.nameEn.toLowerCase();
      const br = b.name.toLowerCase();
      const be = b.nameEn.toLowerCase();
      const score = (name: string, nameEn: string) => {
        if (!q) return 0;
        if (name === q || nameEn === q) return 0;
        if (name.startsWith(q) || nameEn.startsWith(q)) return 1;
        return 2;
      };
      return score(ar, ae) - score(br, be);
    });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-auto min-h-11 w-full max-w-lg justify-between px-3 py-2 font-normal"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {selected ? (
              <>
                <img src={resolveUiImageSrc(selected.icon_url)} className="h-6 w-6 shrink-0 rounded-full border border-border" alt="" />
                <span className="truncate font-semibold text-foreground">{selected.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{t("select.pickItem")}</span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <div className="flex flex-col">
          <div className="border-b p-2">
            <Input
              placeholder={t("select.searchRuneItem")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9"
            />
          </div>
          <ScrollArea className="h-72">
            <div className="flex flex-col gap-0.5 p-1">
              {filtered.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">{t("select.noMatches")}</p>
              ) : (
                filtered.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-3 px-2 py-2"
                    onClick={() => {
                      onSelect(item);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <img src={resolveUiImageSrc(item.icon_url)} className="h-8 w-8 shrink-0 rounded bg-muted" loading="lazy" alt="" />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      {item.nameEn !== item.name && (
                        <span className="text-xs text-muted-foreground">{item.nameEn}</span>
                      )}
                    </div>
                    {selected?.name === item.name && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </Button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TierEntityIcon({
  urls,
  name,
  size,
  className,
}: {
  urls: string[];
  name: string;
  size: "md" | "lg";
  className?: string;
}) {
  const [idx, setIdx] = useState(0);
  const sizeClass = size === "lg" ? "h-9 w-9" : "h-7 w-7";
  const src = idx < urls.length ? urls[idx] : undefined;
  if (src) {
    return (
      <img
        src={src}
        className={cn(
          "shrink-0 rounded-full border border-border/60 bg-muted object-cover",
          sizeClass,
          "text-xs",
          className,
        )}
        alt=""
        onError={() => setIdx(i => i + 1)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted font-bold text-muted-foreground",
        sizeClass,
        "text-xs",
        className,
      )}
    >
      {name.slice(0, 2)}
    </div>
  );
}

function ChampionIcon({
  url,
  candidates,
  name,
  size = "md",
}: {
  url?: string;
  candidates?: string[];
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizes = { sm: "w-8 h-8", md: "w-12 h-12", lg: "w-16 h-16" };
  const raw = [url, ...(candidates ?? [])].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (seen.has(x)) continue;
    seen.add(x);
    merged.push(x);
  }
  const [idx, setIdx] = useState(0);
  const cur = idx < merged.length ? merged[idx] : undefined;
  if (cur) {
    const t = cur.trim();
    let src = cleanUrl(t) ?? t;
    if (
      isTauri() &&
      !t.startsWith("http") &&
      !t.startsWith("data:") &&
      !t.startsWith("blob:") &&
      !t.startsWith("asset:") &&
      !t.startsWith("tauri:")
    ) {
      try {
        src = convertFileSrc(t.replace(/\\/g, "/"));
      } catch {
        /* keep src */
      }
    }
    return (
      <img
        src={src}
        alt={name}
        className={cn(sizes[size], "rounded-full border border-border bg-muted object-cover shadow-sm")}
        onError={() => setIdx(i => i + 1)}
      />
    );
  }
  return (
    <div
      className={cn(
        sizes[size],
        "flex items-center justify-center rounded-full border border-border bg-muted text-xs font-bold text-muted-foreground",
      )}
    >
      {name.slice(0, 2)}
    </div>
  );
}

function EmptyState({ message }: { message?: string }) {
  const { t } = useTranslation();
  const text = message?.trim();
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
        <p>{text ?? t("empty.default")}</p>
      </CardContent>
    </Card>
  );
}

export default App;
