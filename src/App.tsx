import {
  useState,
  useEffect,
  useMemo,
  type ComponentProps,
  type SyntheticEvent,
} from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Routes, Route, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  Circle,
  DownloadCloud,
  History,
  LineChart,
  List,
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
import { SettingsPage } from "@/pages/settings-page";
import { CommunityPage } from "@/pages/community-page";
import { AugmentsPage } from "@/pages/augments-page";
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
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { loadItemsRunesHybrid } from "@/lib/catalog-from-tauri";
import {
  pushWikiHistory,
  shortWikiUrlForList,
  wikiEmbedClose,
  wikiEmbedGoBack,
  wikiEmbedNavigate,
  wikiEmbedOpen,
  wikiEmbedResize,
} from "@/lib/wiki-embed";
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

const LOL_WIKI_ENTRIES = [
  { url: "https://wiki.leagueoflegends.com/en-us/", labelKey: "lolWiki.main" },
  { url: "https://wiki.leagueoflegends.com/en-us/Champion", labelKey: "lolWiki.champions" },
  { url: "https://wiki.leagueoflegends.com/en-us/Rune", labelKey: "lolWiki.runes" },
  { url: "https://wiki.leagueoflegends.com/en-us/Summoner_spell", labelKey: "lolWiki.summoners" },
  { url: "https://wiki.leagueoflegends.com/en-us/Item", labelKey: "lolWiki.items" },
  { url: "https://wiki.leagueoflegends.com/en-us/Champion_skin", labelKey: "lolWiki.skins" },
] as const;

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
  const [version, setVersion] = useState("");
  const [patchesList, setPatchesList] = useState<string[]>([]);
  const [patchData, setPatchData] = useState<PatchData | null>(null);
  const [newPatches, setNewPatches] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<ThemeOption>(() => loadAppPreferences().theme);
  const [wikiOpen, setWikiOpen] = useState(false);
  const [wikiHistory, setWikiHistory] = useState<string[]>([]);

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
    if (!wikiOpen || !isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<{ url: string }>("wiki-embed:navigated", (ev) => {
      setWikiHistory((prev) => pushWikiHistory(prev, ev.payload.url));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    const onResize = () => {
      void wikiEmbedResize();
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("resize", onResize);
    };
  }, [wikiOpen]);

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

  useEffect(() => {
    invoke<string[]>("get_available_patches")
      .then((list) => {
        setPatchesList(list);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (patchesList.length === 0) return;
    const mode = loadAppPreferences().patchDefaultMode;
    setVersion((prev) => {
      if (mode === "alwaysLatest") return patchesList[0];
      if (patchesList.includes(prev)) return prev;
      const saved = loadAppPreferences().lastPatchVersion;
      if (saved && patchesList.includes(saved)) return saved;
      return patchesList[0];
    });
    void (async () => {
      try {
        const status = await refreshPatchesStatus(patchesList);
        const latestPatch = patchesList[0];
        if (!status[latestPatch]) {
          const exists = await invoke<boolean>("check_patch_notes_exists", {
            version: latestPatch,
            patchNotesLocale,
          });
          if (exists) setNewPatches(new Set([latestPatch]));
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, [patchesList, patchNotesLocale]);

  useEffect(() => {
    if (version) loadData(version, false);
  }, [version, patchNotesLocale]);

  async function loadData(ver: string, force: boolean) {
    setLoading(true);
    try {
      const patchResult = await invoke<PatchData>("get_patch_by_version", {
        version: ver,
        patchNotesLocale,
      });
      setPatchData(patchResult);
      const listForStatus =
        patchesList.length > 0
          ? patchesList
          : await invoke<string[]>("get_available_patches").catch(() => []);
      if (listForStatus.length > 0) {
        await refreshPatchesStatus(listForStatus);
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
      console.error(error);
      toast.error(t("toasts.loadError", { msg: String(error) }));
    } finally {
      setLoading(false);
    }
  }

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
      await loadData(version, false);
    } catch (e) {
      toast.error(t("toasts.syncError", { msg: String(e) }));
    } finally {
      setSyncing(false);
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
    setWikiHistory((prev) => pushWikiHistory(prev, url));
    setWikiOpen(true);
    try {
      await wikiEmbedOpen(url);
    } catch (e) {
      toast.error(t("toasts.wikiEmbedError", { msg: String(e) }));
      setWikiOpen(false);
      setWikiHistory([]);
    }
  }

  async function closeWikiToApp() {
    if (isTauri()) {
      try {
        await wikiEmbedClose();
      } catch {
        /* ignore */
      }
    }
    setWikiOpen(false);
    setWikiHistory([]);
  }

  async function handleWikiBack() {
    if (!isTauri()) return;
    try {
      if (wikiHistory.length >= 2) {
        const target = wikiHistory[wikiHistory.length - 2];
        setWikiHistory((prev) => prev.slice(0, -1));
        await wikiEmbedNavigate(target);
        return;
      }
      await wikiEmbedGoBack();
    } catch {
      /* ignore */
    }
  }

  async function handleWikiHistoryPick(url: string) {
    if (!isTauri()) return;
    try {
      await wikiEmbedNavigate(url);
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
          {wikiOpen && isTauri() && (
            <div
              className="fixed left-0 right-0 top-0 z-200 flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-background px-3 shadow-md"
              role="toolbar"
              aria-label={t("lolWiki.chromeTitle")}
            >
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0 gap-1.5"
                onClick={() => void closeWikiToApp()}
              >
                {t("lolWiki.backToApp")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={t("lolWiki.pageBack")}
                onClick={() => void handleWikiBack()}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    aria-label={t("lolWiki.historyLabel")}
                  >
                    <List className="h-4 w-4" />
                    <span className="hidden sm:inline">{t("lolWiki.historyLabel")}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-72 w-[min(100vw-2rem,24rem)] overflow-y-auto"
                >
                  {wikiHistory.length === 0 ? (
                    <DropdownMenuItem disabled>{t("lolWiki.historyEmpty")}</DropdownMenuItem>
                  ) : (
                    [...wikiHistory].reverse().map((u) => (
                      <DropdownMenuItem
                        key={u}
                        className="flex cursor-pointer flex-col items-start gap-0.5 py-2"
                        onClick={() => void handleWikiHistoryPick(u)}
                      >
                        <span className="w-full break-all font-mono text-xs text-muted-foreground">
                          {shortWikiUrlForList(u)}
                        </span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {t("lolWiki.chromeTitle")}
              </span>
            </div>
          )}
          <div
            className={cn(
              "flex min-h-screen flex-col",
              wikiOpen && isTauri() && "hidden",
            )}
          >
            <header className="sticky top-0 z-50 border-b border-border/40 bg-background/75 backdrop-blur-xl supports-backdrop-filter:bg-background/60">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4 md:gap-8">
                  <div className="flex min-w-0 cursor-default items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-linear-to-br from-primary/15 to-primary/5 ring-1 ring-border/60">
                      <img src="/logo.svg" alt="" className="h-7 w-7" />
                    </div>
                    <div className="min-w-0">
                      <h1 className="text-lg font-semibold leading-tight tracking-tight text-foreground">
                        Patch Analyzer
                      </h1>
                      <p className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        {t("header.patchLine", { version })}
                      </p>
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
                        disabled={syncing}
                        onClick={handleSyncAll}
                      >
                        <DownloadCloud className={cn("h-4 w-4", syncing && "animate-bounce")} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("header.downloadPatchesHint")}</TooltipContent>
                  </Tooltip>
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
                              await refreshPatchesStatus(patchesList);
                              await loadData(version, false);
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
                <Routes>
                  <Route
                    path="/"
                    element={
                      <PatchReleaseView
                        data={patchData}
                        version={version}
                        patchesList={patchesList}
                        onVersionChange={setVersionPersist}
                        loading={loading}
                        newPatches={newPatches}
                      />
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
              </ErrorBoundary>
            </main>
            <footer className="sticky bottom-0 z-40 border-t border-border/50 bg-background/90 backdrop-blur-md supports-backdrop-filter:bg-background/75">
              <div className="mx-auto max-w-6xl px-2 py-2 sm:px-4">
                <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("lolWiki.category")}
                </p>
                <ScrollArea className="w-full">
                  <div className="flex w-max min-w-full flex-nowrap gap-1 pb-1 sm:flex-wrap sm:justify-center">
                    {LOL_WIKI_ENTRIES.map(({ url, labelKey }) => (
                      <Button
                        key={url}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => void openWikiUrl(url)}
                      >
                        {t(labelKey)}
                      </Button>
                    ))}
                  </div>
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
                  <UiBadge variant="warning" className="px-1 py-0 text-[10px]">
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
  const [entityType, setEntityType] = useState<"champion" | "rune" | "item">("champion");
  const [allChamps, setAllChamps] = useState<ChampionListItem[]>([]);
  const [allRunes, setAllRunes] = useState<RuneListItem[]>([]);
  const [allItems, setAllItems] = useState<ItemListItem[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    invoke<TierEntry[]>("get_tier_list")
      .then(setData)
      .catch(e => toast.error(String(e)))
      .finally(() => setLoading(false));
  }, []);

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

  const resolveIconAndName = (entry: TierEntry) => {
    if (entry.category === "Champions") {
      const c = allChamps.find(ch =>
        ch.name === entry.name || ch.name_en === entry.name
      );
      return { icon: c?.icon_url, name: c?.name || entry.name };
    }
    // Для рун: сначала патч-ноты, потом DDragon
    if (entityType === "rune") {
      if (entry.icon_url) {
        return { icon: entry.icon_url, name: entry.name };
      }
      const r = allRunes.find(r =>
        r.name === entry.name || r.nameEn === entry.name
      );
      if (r) return { icon: r.icon_url, name: r.name };
      return { icon: undefined, name: entry.name };
    }
    // Для предметов: всегда DDragon (игнорируем патч-ноты)
    if (entityType === "item") {
      const nameLower = entry.name.toLowerCase();
      let it = allItems.find(i => {
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
      // Явный хак для Sunfire Cape / Накидка солнечного пламени, если вдруг не нашли по имени
      if (!it && nameLower.includes("солнечного пламени")) {
        it = allItems.find(i => i.nameEn.toLowerCase().includes("sunfire"));
      }
      if (it) return { icon: it.icon_url, name: it.name };
      return { icon: undefined, name: entry.name };
    }
    return { icon: undefined, name: entry.name };
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
      <article className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm shadow-black/3 dark:shadow-black/20">
        <div className="border-b border-border/50 bg-muted/10 px-5 py-6 sm:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t("tier.aggregation")}
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {t("tier.title")}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {t("tier.subtitle")}
              </p>
            </div>
            <Tabs
              value={entityType}
              onValueChange={(v) => setEntityType(v as "champion" | "rune" | "item")}
              className="w-full lg:w-auto"
            >
              <TabsList className="inline-flex h-auto w-full max-w-full flex-wrap gap-1 rounded-xl bg-muted/25 p-1 lg:w-auto">
                <TabsTrigger
                  value="champion"
                  className="flex-1 rounded-lg px-3 py-2.5 text-xs font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4 sm:text-sm"
                >
                  {t("tier.champions")}
                </TabsTrigger>
                <TabsTrigger
                  value="rune"
                  className="flex-1 rounded-lg px-3 py-2.5 text-xs font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4 sm:text-sm"
                >
                  {t("tier.runes")}
                </TabsTrigger>
                <TabsTrigger
                  value="item"
                  className="flex-1 rounded-lg px-3 py-2.5 text-xs font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4 sm:text-sm"
                >
                  {t("tier.items")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
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
                      <TableHead className="w-[40%] pl-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("tier.entity")}
                      </TableHead>
                      <TableHead className="text-center text-xs font-semibold uppercase tracking-wide text-chart-up">
                        ↑ Buff
                      </TableHead>
                      <TableHead className="text-center text-xs font-semibold uppercase tracking-wide text-chart-down">
                        ↓ Nerf
                      </TableHead>
                      <TableHead className="text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("tier.changes")}
                      </TableHead>
                      <TableHead className="pr-6 text-center text-xs font-semibold uppercase tracking-wide text-chart-muted">
                        Score
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((entry, idx) => {
                      const { icon, name } = resolveIconAndName(entry);
                      const score = entry.buffs - entry.nerfs;
                      return (
                        <TableRow
                          key={entry.name + entry.category + idx}
                          className="cursor-pointer border-border/40 transition-colors hover:bg-muted/25"
                          onClick={() => handleOpenHistory(entry)}
                        >
                          <TableCell className="py-3.5 pl-6">
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="w-7 shrink-0 text-center font-mono text-[11px] text-muted-foreground">
                                {idx + 1}
                              </span>
                              {icon && (
                                <img
                                  src={cleanUrl(icon)}
                                  className="h-9 w-9 shrink-0 rounded-full border border-border/60 bg-muted object-cover"
                                  alt=""
                                />
                              )}
                              {!icon && (
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-[10px] font-bold text-muted-foreground">
                                  {name.slice(0, 2)}
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="truncate font-medium text-foreground">{name}</div>
                                <div className="text-[11px] text-muted-foreground">{categoryLabel(entry)}</div>
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
                  const { icon, name } = resolveIconAndName(entry);
                  const score = entry.buffs - entry.nerfs;
                  return (
                    <button
                      key={entry.name + entry.category + idx}
                      type="button"
                      onClick={() => handleOpenHistory(entry)}
                      className="flex w-full flex-col gap-3 p-4 text-left transition-colors hover:bg-muted/20 active:bg-muted/30"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-8 shrink-0 text-center font-mono text-xs text-muted-foreground">
                          #{idx + 1}
                        </span>
                        {icon && (
                          <img
                            src={cleanUrl(icon)}
                            className="h-10 w-10 shrink-0 rounded-full border border-border/60 bg-muted object-cover"
                            alt=""
                          />
                        )}
                        {!icon && (
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-xs font-bold text-muted-foreground">
                            {name.slice(0, 2)}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold leading-tight text-foreground">{name}</div>
                          <div className="text-[11px] text-muted-foreground">{categoryLabel(entry)}</div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 pl-11 text-xs">
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
    } else if (prefill.type === "rune" && allRunes.length) {
      const found =
        allRunes.find(r => r.name.toLowerCase() === name || r.nameEn.toLowerCase() === name) ||
        allRunes.find(r => r.name.toLowerCase().includes(name) || r.nameEn.toLowerCase().includes(name));
      if (found) {
        setSelectedRune(found);
        setChampion(null);
        setSelectedItem(null);
        setPrefill(null);
      }
    } else if (prefill.type === "item" && allItems.length) {
      const found =
        allItems.find(i => i.name.toLowerCase() === name || i.nameEn.toLowerCase() === name) ||
        allItems.find(i => i.name.toLowerCase().includes(name) || i.nameEn.toLowerCase().includes(name));
      if (found) {
        setSelectedItem(found);
        setChampion(null);
        setSelectedRune(null);
        setPrefill(null);
      }
    }
  }, [prefill, allChamps, allRunes, allItems]);

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

  // Фильтруем списки рун и предметов только по тем, что реально менялись в последних 20 патчах
  useEffect(() => {
    if (!changedItemRuneTitles.length) return;
    const titles = new Set(changedItemRuneTitles.map(t => t.toLowerCase()));

    setAllRunes(prev =>
      prev.filter(r =>
        titles.has(r.name.toLowerCase()) || titles.has(r.nameEn.toLowerCase())
      )
    );
    setAllItems(prev =>
      prev.filter(i =>
        titles.has(i.name.toLowerCase()) || titles.has(i.nameEn.toLowerCase())
      )
    );
  }, [changedItemRuneTitles]);

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
    const t = title.toLowerCase();
    if (entityType === "rune") {
      // Для рун: сначала патч-ноты, потом DDragon, потом архивные иконки
      if (patchIcon) return patchIcon;
      const r = allRunes.find(r =>
        r.name.toLowerCase() === t || r.nameEn.toLowerCase() === t
      );
      return r?.icon_url || null;
    }
    if (entityType === "item") {
      // Для предметов: всегда DDragon (игнорируем патч-ноты)
      const it = allItems.find(i =>
        i.name.toLowerCase() === t || i.nameEn.toLowerCase() === t
      );
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
          if (!groups.has(key)) {
            // Используем иконку из патч-нотов (change.image_url) или из деталей
            groups.set(key, { icon: mainIcon || d.icon_url || null, rawChanges: [] });
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
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t("history.timelineCaption")}
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
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
                  className="flex-1 rounded-lg px-3 py-2.5 text-xs font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4 sm:text-sm"
                >
                  {t("tier.champions")}
                </TabsTrigger>
                <TabsTrigger
                  value="rune"
                  className="flex-1 rounded-lg px-3 py-2.5 text-xs font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4 sm:text-sm"
                >
                  {t("tier.runes")}
                </TabsTrigger>
                <TabsTrigger
                  value="item"
                  className="flex-1 rounded-lg px-3 py-2.5 text-xs font-medium data-[state=active]:shadow-sm sm:flex-initial sm:px-4 sm:text-sm"
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
                items={allRunes}
                selected={selectedRune}
                onSelect={(r) => {
                  setSelectedRune(r);
                  setChampion(null);
                  setSelectedItem(null);
                }}
              />
            ) : (
              <ItemSelect
                items={allItems}
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
                    src={cleanUrl(champion.icon_url)}
                    className="h-16 w-16 rounded-full border-4 border-background bg-card object-cover shadow-md"
                  />
                )}
                {entityType !== "champion" && (() => {
                  return iconUrl ? (
                    <img
                      src={cleanUrl(iconUrl)}
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
                  <h3 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
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
                            <img src={cleanUrl(icon)} className="h-6 w-6 rounded bg-muted" alt="" />
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
              <p className="mb-6 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t("history.perPatch")}
              </p>
              <div className="relative ml-2 space-y-8 border-l border-border/60 pb-6 pl-5 sm:ml-4 sm:pl-8">
                {[...history].sort((a, b) => compareVersions(b.patch_version, a.patch_version)).map((item, idx) => (
                  <div key={idx} className="group relative">
                    <div className="absolute -left-[calc(0.25rem+1px)] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-muted ring-2 ring-background transition-colors group-hover:bg-primary sm:-left-[calc(1.25rem+1px)]" />
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-primary px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary-foreground shadow-sm">
                        Patch {item.patch_version}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
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
                                {block.icon_url && <img src={cleanUrl(block.icon_url)} className="h-8 w-8 rounded-lg border border-border bg-muted shadow-sm" />}
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
    note.category === "ModeAramChaos"
  ) {
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
    const it = findItemByLooseTitle(note.title, items);
    return it ? cleanUrl(it.icon_url) : undefined;
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

function PatchReleaseView({ data, version, patchesList, onVersionChange, loading, newPatches }: { data: PatchData | null, version: string, patchesList: string[], onVersionChange: (v: string) => void, loading: boolean, newPatches?: Set<string> }) {
  const { t } = useTranslation();
  const [championList, setChampionList] = useState<ChampionListItem[]>([]);
  const [itemList, setItemList] = useState<ItemListItem[]>([]);
  const [runeList, setRuneList] = useState<RuneListItem[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
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
    if (categoryFilter === "All") return patchNotes;
    return patchNotes.filter((n) => n.category === categoryFilter);
  }, [patchNotes, categoryFilter]);

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
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t("patchView.lolNotes")}
        </p>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
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
                    className="shrink-0 rounded-lg px-3 py-2 text-xs font-medium data-[state=active]:shadow-sm sm:text-sm"
                  >
                    {t("patchView.allCount", { count: data.patch_notes.length })}
                  </TabsTrigger>
                  {categoriesWithNotes.map((c) => (
                    <TabsTrigger
                      key={c}
                      value={c}
                      className="shrink-0 rounded-lg px-3 py-2 text-xs font-medium data-[state=active]:shadow-sm sm:text-sm"
                    >
                      {patchNoteCategoryLabel(c, t)} ({categoryCounts.get(c) ?? 0})
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
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
                          const u = cleanUrl(note.image_url);
                          if (u) setLightboxUrl(u);
                        }}
                      >
                        <img
                          src={cleanUrl(note.image_url) ?? ""}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ) : null}
                    <div className="flex items-start justify-between gap-2 p-3">
                      <h3 className="text-sm font-semibold leading-snug">{note.title}</h3>
                      <PatchNoteBadge type={note.change_type} />
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
                  const imgUrl = cleanUrl(note.image_url);
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
                            <h3 className="text-lg font-semibold leading-snug tracking-tight sm:text-xl">
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
                          <UiBadge variant="outline" className="font-normal">
                            {patchNoteCategoryLabel(note.category, t)}
                          </UiBadge>
                          <PatchNoteBadge type={note.change_type} />
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
                          <h3 className="text-lg font-semibold leading-snug tracking-tight sm:text-xl">
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
                          <UiBadge variant="outline" className="font-normal">
                            {patchNoteCategoryLabel(note.category, t)}
                          </UiBadge>
                        )}
                        <PatchNoteBadge type={note.change_type} />
                      </div>
                    </div>
                    <div className="ml-0 space-y-4 border-l-2 border-border/60 pl-4 sm:ml-2 sm:pl-5">
                      {Array.isArray(note.details) && note.details.map((block, i) => (
                        <div key={i}>
                          {block.title && (
                            <div className="mb-2 flex items-center gap-2">
                              {block.icon_url && (
                                <img src={cleanUrl(block.icon_url)} className="h-6 w-6 rounded bg-muted" alt="" />
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
                              const lower = change.toLowerCase();
                              const isNew = lower.includes("новое") || lower.includes("new");
                              const isRemoved = lower.includes("удалено") || lower.includes("removed");
                              const liClasses = cn(
                                "rounded-lg px-2.5 py-1.5 text-sm leading-relaxed text-foreground",
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

function PatchNoteBadge({ type }: { type: string }) {
  const { t } = useTranslation();
  const map: Record<string, NonNullable<ComponentProps<typeof UiBadge>["variant"]>> = {
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
  return <UiBadge variant={variant}>{labels[type] ?? type}</UiBadge>;
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
                <img src={cleanUrl(selected.icon_url)} className="h-6 w-6 shrink-0 rounded-full border border-border" alt="" />
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
                <p className="p-4 text-center text-xs text-muted-foreground">{t("select.noMatches")}</p>
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
                    <img src={cleanUrl(item.icon_url)} className="h-8 w-8 shrink-0 rounded bg-muted" loading="lazy" alt="" />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      {item.name_en !== item.name && (
                        <span className="text-[11px] text-muted-foreground">{item.name_en}</span>
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
                  src={cleanUrl(selected.icon_url)}
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
                <p className="p-4 text-center text-xs text-muted-foreground">{t("select.noMatches")}</p>
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
                      src={cleanUrl(item.icon_url)}
                      className="h-8 w-8 shrink-0 rounded-full border border-border bg-muted object-cover"
                      alt={item.name}
                      loading="lazy"
                      onError={runeImgOnError(item)}
                    />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      {item.nameEn !== item.name && (
                        <span className="text-[11px] text-muted-foreground">{item.nameEn}</span>
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
                <img src={cleanUrl(selected.icon_url)} className="h-6 w-6 shrink-0 rounded-full border border-border" alt="" />
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
                <p className="p-4 text-center text-xs text-muted-foreground">{t("select.noMatches")}</p>
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
                    <img src={cleanUrl(item.icon_url)} className="h-8 w-8 shrink-0 rounded bg-muted" loading="lazy" alt="" />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      {item.nameEn !== item.name && (
                        <span className="text-[11px] text-muted-foreground">{item.nameEn}</span>
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
  const raw = [...(candidates ?? []), url].filter(
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
      !t.startsWith("blob:")
    ) {
      try {
        src = convertFileSrc(t);
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
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
        <p>{message ?? t("empty.default")}</p>
      </CardContent>
    </Card>
  );
}

export default App;
