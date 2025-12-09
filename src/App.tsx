import { useState, useEffect, useRef, useId, Component, ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { BookOpen, LineChart, TrendingUp, History, ScrollText, Check, Search, DownloadCloud, ChevronDown, RefreshCw, ArrowUp, ArrowDown, ArrowRightLeft, ArrowLeft, Database as DbIcon, Settings, Sun, Moon, ExternalLink } from "lucide-react";
import { cn, mapPatchVersion } from "./lib/utils";

// Helper to clean image URLs on frontend (for existing data)
function cleanUrl(url?: string | null) {
  if (!url) return undefined;
  if (url.includes("akamaihd.net") && url.includes("?f=")) {
    try {
        return url.split("?f=")[1];
    } catch (e) { return url; }
  }
  return url;
}

function highlightSpecialTags(text: string): string {
  // НОВОЕ / Новое / NEW (без word boundary, на всякий случай)
  text = text.replace(
    /(НОВОЕ|Новое|NEW)/g,
    '<span class="inline px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-100 font-semibold text-[11px] align-middle">$1</span>',
  );
  // УДАЛЕНО / Удалено / REMOVED
  text = text.replace(
    /(УДАЛЕНО|Удалено|REMOVED)/g,
    '<span class="inline px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-100 font-semibold text-[11px] align-middle">$1</span>',
  );
  return text;
}

function analyzeChangeTrend(text: string): "up" | "down" | "neutral" {
    const lower = text.toLowerCase();
    
    // Если явно написано, что что-то УДАЛЕНО / больше не работает — это всегда ослабление
    if (
      lower.includes("удалено") ||
      lower.includes("removed") ||
      (lower.includes("больше не") && !lower.includes("больше не уменьшается") && !lower.includes("no longer reduced"))
    ) {
      return "down";
    }

    // Check for specific "no longer reduced" pattern (это бафф)
    if (lower.includes("больше не уменьшается") || lower.includes("no longer reduced")) return "up";

    // Cooldown/Cost/Time context (lower is better)
    const isInverse = lower.includes("перезарядка") || lower.includes("cooldown") || 
                      lower.includes("стоимость") || lower.includes("cost") || 
                      lower.includes("mana") || lower.includes("маны") || 
                      lower.includes("energy") || lower.includes("энергии") ||
                      lower.includes("затраты") || lower.includes("время") || lower.includes("time");

    // Split by arrow
    const parts = text.split(/\s*(?:→|⇒|->)\s*/);
    if (parts.length === 2) {
        const parseVal = (str: string) => {
            // Extract all numbers from the string
            const nums = (str.match(/[-+]?\d+(?:[.,]\d+)?/g) || [])
                .map(s => parseFloat(s.replace(',', '.')));
            
            if (nums.length === 0) return NaN;
            
            // Heuristic: Sum of all numbers usually indicates "total power"
            return nums.reduce((a, b) => a + b, 0);
        };

        const from = parseVal(parts[0]);
        const to = parseVal(parts[1]);

        if (!isNaN(from) && !isNaN(to)) {
            if (to > from) return isInverse ? "down" : "up";
            if (to < from) return isInverse ? "up" : "down";
        }
    }

    // Keyword matching
    if (lower.includes("увеличен") || lower.includes("усилен") || lower.includes("increased") || lower.includes("buffed") || lower.includes("new effect") || lower.includes("новый эффект")) return "up";
    if (lower.includes("уменьшен") || lower.includes("ослаблен") || lower.includes("decreased") || lower.includes("nerfed") || lower.includes("removed") || lower.includes("удалено")) return "down";

    return "neutral";
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error: error.message }; }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) { console.error("Uncaught error:", error, errorInfo); }
  render() {
    if (this.state.hasError) {
      return <div className="p-10 text-center text-red-500"><h1>Error</h1><code>{this.state.error}</code><button onClick={() => window.location.reload()}>Reload</button></div>;
    }
    return this.props.children;
  }
}

interface PatchData { version: string; patch_notes: PatchNoteEntry[]; }
interface ChangeBlock { title: string | null; icon_url: string | null; changes: string[]; }
interface PatchNoteEntry { id: string; title: string; image_url?: string; category: string; change_type: string; summary: string; details: ChangeBlock[]; }
interface MetaAnalysisDiff { champion_name: string; role: string; win_rate_diff: number; pick_rate_diff: number; predicted_change: string | null; champion_image_url?: string; }
interface ChampionHistoryEntry { patch_version: string; date: string; change: PatchNoteEntry; }
interface ChampionListItem { name: string; name_en: string; icon_url: string; }
interface ChampionMeta { nameRu: string; nameEn: string; icon: string; }
interface RuneListItem { name: string; nameEn: string; icon_url: string; }
interface ItemListItem { id: string; name: string; nameEn: string; icon_url: string; }
interface LogEntry { level: string; message: string; timestamp: string; }
interface TierEntry { name: string; category: string; buffs: number; nerfs: number; adjusted: number; }
interface SupabaseChampionStats {
    id: number;
    champion_id: string;
    patch_version: string;
    region: string;
    tier: string;
    role: string | null;
    win_rate: number | null;
    pick_rate: number | null;
    ban_rate: number | null;
    total_matches: number | null;
}

type ThemeMode = "light" | "dark";
type UpdateChannel = "stable" | "beta";

function compareVersions(v1: string, v2: string) {
    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10)).filter(n => !isNaN(n));
    const p1 = parse(v1);
    const p2 = parse(v2);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
        const n1 = p1[i] || 0;
        const n2 = p2[i] || 0;
        if (n1 !== n2) return n1 - n2;
    }
    return 0;
}

import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

function IconSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string; icon?: string; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOnOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const closeOnOtherOpen = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail !== id) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    window.addEventListener("iconselect-open", closeOnOtherOpen as EventListener);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      window.removeEventListener("iconselect-open", closeOnOtherOpen as EventListener);
    };
  }, [id]);

  const toggle = () => {
    setOpen(prev => {
      const next = !prev;
      if (next) window.dispatchEvent(new CustomEvent("iconselect-open", { detail: id }));
      return next;
    });
  };
  const current = options.find(o => o.value === value);
  return (
    <div className="relative inline-block" ref={ref}>
      <button
        className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm px-2 py-1 outline-none focus:border-blue-500 dark:focus:border-blue-400 text-slate-700 dark:text-slate-100"
        onClick={toggle}
        type="button"
      >
        <span className="text-slate-500 dark:text-slate-300">{label}</span>
        {current?.icon && <img src={current.icon} alt={current.label} className="w-4 h-4" />}
        <span>{current?.label || "Все"}</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full min-w-[140px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-sm">
          {options.map(opt => (
            <div
              key={opt.value}
              className={cn("flex items-center gap-2 px-3 py-2 text-sm", opt.disabled ? "text-slate-300 dark:text-slate-600 cursor-not-allowed" : "hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-slate-700 dark:text-slate-100")}
              onClick={() => { if (opt.disabled) return; onChange(opt.value); setOpen(false); }}
            >
              {opt.icon && <img src={opt.icon} alt={opt.label} className="w-4 h-4" />}
              <span>{opt.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
    const [theme, setTheme] = useState<ThemeMode>(() => {
        if (typeof window === "undefined") return "light";
        const stored = localStorage.getItem("theme");
        if (stored === "light" || stored === "dark") return stored;
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    });
    const [updateChannel, setUpdateChannel] = useState<UpdateChannel>(() => {
        if (typeof window === "undefined") return "stable";
        const stored = localStorage.getItem("updateChannel");
        return stored === "beta" ? "beta" : "stable";
    });
    const [appVersion, setAppVersion] = useState<string>("");

    useEffect(() => {
        if (typeof document === "undefined") return;
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.toggle("dark", theme === "dark");
        localStorage.setItem("theme", theme);
    }, [theme]);

    useEffect(() => {
        localStorage.setItem("updateChannel", updateChannel);
    }, [updateChannel]);

    useEffect(() => {
        getVersion().then(setAppVersion).catch(() => {});
    }, []);

    useEffect(() => {
        const initUpdater = async () => {
            try {
                const update = await check({ channel: updateChannel });
                if (update?.available) {
                    const yes = await ask(`Доступна новая версия ${update.version}! Хотите обновиться сейчас?`, {
                        title: 'Обновление доступно',
                        kind: 'info'
                    });
                    if (yes) {
                        await update.downloadAndInstall();
                        await relaunch();
                    }
                }
            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                if (!errorMsg.includes("Could not fetch") && !errorMsg.includes("release JSON")) {
                    console.error('Failed to check for updates:', e);
                }
            }
        }
        initUpdater();
    }, [updateChannel]);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState("25.23"); 
  const [patchesList, setPatchesList] = useState<string[]>([]);
  const [patchData, setPatchData] = useState<PatchData | null>(null);
  const [diffs, setDiffs] = useState<MetaAnalysisDiff[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const location = useLocation();

  useEffect(() => {
    invoke<string[]>("get_available_patches").then(list => {
        setPatchesList(list);
        if (list.length > 0) setVersion(list[0]);
    }).catch(console.error);

    const unlisten = listen<LogEntry>("log_message", (event) => {
      setLogs(prev => [event.payload, ...prev]);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => { if (version) loadData(version, false); }, [version]);

  async function loadData(ver: string, force: boolean) {
    setLoading(true);
    try {
        const [diffsResult, patchResult] = await Promise.all([
            invoke<MetaAnalysisDiff[]>("analyze_patch", { version: ver, force }),
            invoke<PatchData>("get_patch_by_version", { version: ver })
        ]);
        setDiffs(diffsResult);
        setPatchData(patchResult);
        if (force) toast.success(`Патч ${ver} обновлен`);
    } catch (error) {
        const errorMsg = String(error);
        console.error("Load data error:", errorMsg);
        const isSilentError = errorMsg === "1" || errorMsg === "101" || 
                              errorMsg.trim() === "1" || errorMsg.trim() === "101";
        if (!isSilentError) {
            toast.error("Ошибка загрузки: " + errorMsg);
        }
    } finally {
        setLoading(false);
    }
  }

  async function handleSyncAll() {
      setSyncing(true);
      toast.info("Загрузка всех патчей начата (см. логи)...");
      try {
          await invoke("sync_patch_history");
          toast.success("Все патчи загружены!");
          loadData(version, false);
      } catch (e) {
          toast.error("Ошибка синхронизации: " + String(e));
      } finally {
          setSyncing(false);
      }
  }

  const navItems = [
    { path: "/", label: "Патч Ноут", icon: BookOpen },
    { path: "/meta", label: "Изменения Меты", icon: LineChart },
    { path: "/predictions", label: "Прогнозы", icon: TrendingUp },
    { path: "/real-stats", label: "Live Статистика", icon: DbIcon },
    { path: "/tier", label: "Тир-лист", icon: LineChart },
    { path: "/history", label: "История изменений", icon: History },
  ];

  return (
    <ErrorBoundary>
    <div className={cn("min-h-screen flex flex-col font-sans selection:bg-blue-100 dark:selection:bg-blue-900/40", "bg-[hsl(var(--background))] text-[hsl(var(--foreground))]")}>
      <Toaster position="top-right" theme={theme === "dark" ? "dark" : "light"} />
      <header className="border-b border-slate-200 dark:border-slate-800 bg-[color-mix(in_srgb,hsl(var(--surface))_85%,transparent)] backdrop-blur-md p-4 sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
             <div className="flex items-center gap-3 group cursor-default">
                <div className="relative">
                    <div className="absolute inset-0 bg-blue-500 blur-lg opacity-20 group-hover:opacity-40 transition-opacity rounded-full"></div>
                    <img src="/A.svg" alt="LoL Analyzer" className="w-10 h-10 relative z-10 drop-shadow-sm" />
                </div>
                <div>
                  <h1 className="text-xl font-bold leading-none tracking-tight group-hover:text-blue-600 transition-colors text-slate-900 dark:text-slate-50">LoL Analyzer</h1>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider font-bold">Patch {version}</span>
                </div>
             </div>
            <nav className="flex-1 min-w-[260px] w-full">
              <div className="flex flex-wrap gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg border border-slate-200 dark:border-slate-700">
                {navItems.map(({ path, label, icon: Icon }) => (
                  <Link key={path} to={path} className={cn("flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all", location.pathname === path ? "bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-300 shadow-sm border border-slate-200 dark:border-slate-700" : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-white/60 dark:hover:bg-slate-700/60")}>
                    <Icon className="w-4 h-4" /> {label}
                  </Link>
                ))}
              </div>
            </nav>
          </div>
          <div className="flex flex-wrap gap-3 justify-end">
             <button 
                onClick={handleSyncAll} 
                disabled={syncing}
                className={cn("flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-md transition-all border shadow-sm active:scale-95 h-9", syncing ? "bg-slate-100 dark:bg-slate-800 text-slate-400 border-transparent" : "bg-white dark:bg-slate-900 hover:bg-blue-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-100 border-slate-200 dark:border-slate-700 hover:border-blue-200 hover:text-blue-600")}
             >
                <DownloadCloud className={cn("w-4 h-4", syncing && "animate-bounce")} /> 
                {syncing ? "Загрузка..." : "Скачать патчи"}
             </button>
            
            <CustomPatchSelect 
                value={version} 
                options={patchesList} 
                onChange={setVersion} 
                loading={loading}
            />
            <Link 
              to="/settings"
              className="flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-md transition-all border shadow-sm active:scale-95 h-9 bg-white dark:bg-slate-900 hover:bg-blue-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-100 border-slate-200 dark:border-slate-700 hover:border-blue-200 hover:text-blue-600"
            >
              <Settings className="w-4 h-4" />
              Настройки
            </Link>
            <button 
               onClick={async () => {
                  if (confirm("Вы уверены, что хотите очистить локальную базу данных? Это исправит ошибки с данными.")) {
                      try {
                          await invoke("clear_database"); 
                          window.location.reload();
                      } catch (e) {
                          toast.info("Функция очистки в разработке. Пожалуйста, перезапустите приложение.");
                      }
                  }
               }}
               className="text-xs font-semibold px-3 py-1.5 rounded-md border border-red-200 dark:border-red-700 text-red-500 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors h-9"
            >
               Сброс
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-6xl w-full mx-auto p-6">
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<PatchReleaseView data={patchData} />} />
            <Route path="/meta" element={<MetaChangesView diffs={diffs} />} />
            <Route path="/predictions" element={<PredictionsView diffs={diffs} />} />
            <Route path="/real-stats" element={<RealStatsView />} />
            <Route path="/tier" element={<TierListView />} />
            <Route path="/history" element={<ChampionHistoryView />} />
            <Route path="/logs" element={<LogsView logs={logs} />} />
            <Route path="/settings" element={<SettingsView theme={theme} onThemeChange={setTheme} channel={updateChannel} onChannelChange={setUpdateChannel} appVersion={appVersion} />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
    </ErrorBoundary>
  );
}

function CustomPatchSelect({ value, options, onChange, loading }: { value: string, options: string[], onChange: (v: string) => void, loading: boolean }) {
    const [isOpen, setIsOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false); };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [ref]);

    return (
        <div className="relative" ref={ref}>
            <button 
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900 px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-sm w-32 justify-between border border-slate-800 dark:border-slate-200"
            >
                <span className={cn(loading && "opacity-50")}>{value}</span>
                <ChevronDown className={cn("w-4 h-4 text-slate-400 transition-transform", isOpen && "rotate-180")} />
            </button>
            {isOpen && (
                <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-80 overflow-y-auto z-50 p-1 animate-in fade-in zoom-in-95 duration-200">
                    {options.map(opt => (
                        <div 
                            key={opt} 
                            onClick={() => { onChange(opt); setIsOpen(false); }}
                            className={cn("px-3 py-2 rounded-lg text-sm font-medium cursor-pointer flex items-center justify-between transition-colors", opt === value ? "bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-200" : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200")}
                        >
                            Patch {opt}
                            {opt === value && <Check className="w-3 h-3" />}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function SettingsView({ theme, onThemeChange, channel, onChannelChange, appVersion }: { theme: ThemeMode; onThemeChange: (t: ThemeMode) => void; channel: UpdateChannel; onChannelChange: (c: UpdateChannel) => void; appVersion: string }) {
  const themeOptions: { key: ThemeMode; label: string; desc: string; icon: typeof Sun }[] = [
    { key: "light", label: "Светлая", desc: "Стандартный светлый интерфейс", icon: Sun },
    { key: "dark", label: "Тёмная", desc: "Для ночной работы и OLED", icon: Moon },
  ];
  const channelOptions: { key: UpdateChannel; label: string; desc: string }[] = [
    { key: "stable", label: "Стабильная (master)", desc: "Релизы из master" },
    { key: "beta", label: "Бета (beta)", desc: "Свежие сборки, возможны баги" },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="panel rounded-xl p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">Тема</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">Переключи светлую/тёмную оболочку</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {themeOptions.map((opt) => (
            <button
              key={opt.key}
              onClick={() => onThemeChange(opt.key)}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-all shadow-sm",
                theme === opt.key
                  ? "border-blue-300 dark:border-blue-600 bg-blue-50/70 dark:bg-blue-900/30 text-blue-700 dark:text-blue-200"
                  : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 hover:border-blue-200 dark:hover:border-blue-500"
              )}
            >
              <opt.icon className="w-5 h-5" />
              <div>
                <div className="font-semibold">{opt.label}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{opt.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="panel rounded-xl p-5 shadow-sm space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Канал обновлений</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">master — стабильная, beta — бета</p>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Текущая версия: <span className="font-semibold text-slate-800 dark:text-slate-100">{appVersion || "—"}</span> ({channel})
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {channelOptions.map(opt => (
            <button
              key={opt.key}
              onClick={() => onChannelChange(opt.key)}
              className={cn(
                "px-3 py-2 rounded-lg border text-sm font-semibold transition-all shadow-sm",
                channel === opt.key
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-700"
                  : "bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-blue-200 dark:hover:border-blue-500"
              )}
            >
              <div className="font-semibold">{opt.label}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{opt.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="panel rounded-xl p-5 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Логи</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">Перейти к live-логам приложения</p>
        </div>
        <Link
          to="/logs"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors"
        >
          <ScrollText className="w-4 h-4" />
          Открыть логи
        </Link>
      </div>

      <div className="panel rounded-xl p-5 shadow-sm">
        <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">Разработчики</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex items-center gap-3">
            <img
              src="https://github.com/Jab04kin.png"
              alt="Jab04kin avatar"
              className="w-14 h-14 rounded-full border border-slate-200 dark:border-slate-700 object-cover"
            />
            <a
              href="https://github.com/Jab04kin"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-base font-semibold text-blue-600 dark:text-blue-300 hover:underline"
            >
              Jab04kin
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
          <div className="flex items-center gap-3">
            <img
              src="https://github.com/Alexxxxxander.png"
              alt="Alexxxxxander avatar"
              className="w-14 h-14 rounded-full border border-slate-200 dark:border-slate-700 object-cover"
            />
            <a
              href="https://github.com/Alexxxxxander"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-base font-semibold text-blue-600 dark:text-blue-300 hover:underline"
            >
              Alexxxxxander
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>

      <div className="panel rounded-xl p-5 shadow-sm flex items-center gap-4">
        <img
          src="https://github.com/RaspizDIYs.png"
          alt="RaspizDIYs avatar"
          className="w-14 h-14 rounded-full border border-slate-200 dark:border-slate-700 object-cover bg-white dark:bg-slate-800"
        />
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Организация</div>
          <div className="text-base font-semibold text-slate-900 dark:text-slate-100">RaspizDIYs</div>
          <a
            href="https://github.com/RaspizDIYs"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600 dark:text-blue-300 hover:underline"
          >
            другие проекты
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  );
}

// ... LogsView, ChampionHistoryView, PatchReleaseView, MetaChangesView, PredictionsView, etc. same as before ...
// Need to include them to be valid. I will use shortened versions if unchanged logic, but full if needed.
// Actually, I'll just output the full file content for safety.

function LogsView({ logs }: { logs: LogEntry[] }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
       <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Системные Логи</h2>
          <span className="text-xs bg-slate-100 text-slate-500 px-2 py-1 rounded">Live Updates</span>
       </div>
       <div className="bg-slate-900 rounded-xl p-4 h-[600px] overflow-y-auto font-mono text-xs custom-scrollbar">
          {logs.length === 0 ? (
            <div className="text-slate-500 italic text-center mt-20">Нет записей...</div>
          ) : (
            logs.map((log, i) => (
               <div key={i} className="flex gap-3 mb-1.5 border-b border-slate-800/50 pb-1.5 last:border-0 hover:bg-white/5 p-1 rounded transition-colors">
                  <span className="text-slate-500 shrink-0 select-none">{log.timestamp}</span>
                  <span className={cn("shrink-0 font-bold w-16", 
                      log.level === "INFO" ? "text-blue-400" : 
                      log.level === "ERROR" ? "text-red-400" : 
                      log.level === "WARN" ? "text-yellow-400" : "text-green-400"
                  )}>{log.level}</span>
                  <span className="text-slate-300 break-all">{log.message}</span>
               </div>
            ))
          )}
       </div>
       <div className="flex justify-end">
         <button
           onClick={() => navigate("/settings")}
           className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-100 hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors shadow-sm"
         >
           <ArrowLeft className="w-4 h-4" />
           Назад
         </button>
       </div>
    </div>
  );
}

function TierListView() {
  const [data, setData] = useState<TierEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [entityType, setEntityType] = useState<"champion" | "rune" | "item">("champion");
  const [patchWindow, setPatchWindow] = useState<number>(20);
  const [allChamps, setAllChamps] = useState<ChampionListItem[]>([]);
  const [allRunes, setAllRunes] = useState<RuneListItem[]>([]);
  const [allItems, setAllItems] = useState<ItemListItem[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    invoke<TierEntry[]>("get_tier_list", { window: patchWindow })
      .then(setData)
      .catch(e => toast.error(String(e)))
      .finally(() => setLoading(false));
  }, [patchWindow]);

  // чемпы, руны, предметы — берём те же DDragon данные, что и в истории
  useEffect(() => {
    invoke<ChampionListItem[]>("get_all_champions")
      .then(setAllChamps)
      .catch(e => toast.error(String(e)));
  }, []);

  useEffect(() => {
    async function loadDDragon() {
      try {
        const verResp = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
        const versions: string[] = await verResp.json();
        const latest = versions[0] || "15.23.1";

        const [itemsRuResp, itemsEnResp] = await Promise.all([
          fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/ru_RU/item.json`),
          fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/item.json`),
        ]);
        const itemsRuJson = await itemsRuResp.json();
        const itemsEnJson = await itemsEnResp.json();

        const items: ItemListItem[] = Object.entries<any>(itemsRuJson.data || {}).map(
          ([id, ru]) => {
            const en = itemsEnJson.data?.[id] ?? {};
            return {
              id: id as string,
              name: ru.name as string,
              nameEn: (en.name as string) || (ru.name as string),
              icon_url: `https://ddragon.leagueoflegends.com/cdn/${latest}/img/item/${id}.png`,
            };
          },
        );
        setAllItems(items);

        const [runesRuResp, runesEnResp] = await Promise.all([
          fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/ru_RU/runesReforged.json`),
          fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/runesReforged.json`),
        ]);
        const runesRuJson: any[] = await runesRuResp.json();
        const runesEnJson: any[] = await runesEnResp.json();

        const runes: RuneListItem[] = [];
        runesRuJson.forEach((treeRu, treeIndex) => {
          const treeEn = runesEnJson[treeIndex] || {};
          (treeRu.slots || []).forEach((slot: any, slotIndex: number) => {
            (slot.runes || []).forEach((runeRu: any, runeIndex: number) => {
              const runeEn = (((treeEn.slots || [])[slotIndex] || {}).runes || [])[runeIndex] || {};
              runes.push({
                name: runeRu.name as string,
                nameEn: (runeEn.name as string) || (runeRu.name as string),
                icon_url: `https://ddragon.leagueoflegends.com/cdn/${latest}/img/${runeRu.icon}`,
              });
            });
          });
        });
        setAllRunes(runes);
      } catch (e) {
        console.error(e);
      }
    }
    loadDDragon();
  }, []);

  const filtered = data.filter(entry => {
    if (entityType === "champion") return entry.category === "Champions";
    return entry.category === "ItemsRunes";
  });

  const resolveIconAndName = (entry: TierEntry) => {
    if (entry.category === "Champions") {
      const c = allChamps.find(ch =>
        ch.name === entry.name || ch.name_en === entry.name
      );
      return { icon: c?.icon_url, name: c?.name || entry.name };
    }
    // ItemsRunes -> решаем по DDragon что это
    if (entityType === "rune") {
      const r = allRunes.find(r =>
        r.name === entry.name || r.nameEn === entry.name
      );
      if (r) return { icon: r.icon_url, name: r.name };
      return { icon: undefined, name: entry.name };
    }
    if (entityType === "item") {
      const it = allItems.find(i =>
        i.name === entry.name || i.nameEn === entry.name
      );
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

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Тир-лист</h2>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span>Патчей:</span>
            <select
              className="bg-white border border-slate-200 rounded-md text-sm px-2 py-1 outline-none focus:border-blue-500"
              value={patchWindow}
              onChange={e => setPatchWindow(Number(e.target.value))}
            >
              {[1,3,5,10,20].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <div className="inline-flex rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5 text-xs font-semibold">
          {[
            { key: "champion", label: "Чемпионы" },
            { key: "rune", label: "Руны" },
            { key: "item", label: "Предметы" },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => {
                setEntityType(tab.key as any);
              }}
              className={cn(
                "px-3 py-1 rounded-lg transition-colors",
                entityType === tab.key
                  ? "bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-200 shadow-sm border border-slate-200 dark:border-slate-700"
                  : "text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="text-center py-20 text-slate-400 flex flex-col items-center gap-4">
          <RefreshCw className="animate-spin w-8 h-8 text-blue-500" />
          Строим тир-лист...
        </div>
      )}

      {!loading && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
          <div className="grid grid-cols-12 text-xs font-semibold text-slate-500 dark:text-slate-300 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800 px-4 py-2">
            <div className="col-span-6">Сущность</div>
            <div className="col-span-2 text-center text-emerald-700">↑ Buff</div>
            <div className="col-span-2 text-center text-red-700">↓ Nerf</div>
            <div className="col-span-2 text-center text-slate-600">⇄ Изм.</div>
          </div>
          <div className="divide-y divide-slate-100">
            {filtered.map((entry, idx) => {
              const { icon, name } = resolveIconAndName(entry);
              const score = entry.buffs - entry.nerfs;
              return (
                <button
                  key={entry.name + entry.category + idx}
                  onClick={() => handleOpenHistory(entry)}
                  className="w-full flex items-center px-4 py-2 text-sm hover:bg-blue-50/60 dark:hover:bg-slate-800 transition-colors"
                >
                  <div className="flex items-center gap-3 col-span-6 flex-1">
                    <span className="w-6 text-[11px] text-slate-400 font-mono">#{idx + 1}</span>
                    {icon && (
                      <img
                        src={cleanUrl(icon)}
                        className="w-8 h-8 rounded-full border border-slate-200 bg-slate-100 object-cover"
                      />
                    )}
                    {!icon && (
                      <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-400 border border-slate-200 dark:border-slate-700">
                        {name.slice(0, 2)}
                      </div>
                    )}
                    <span className="font-semibold text-slate-800 dark:text-slate-100">{name}</span>
                    <span className="ml-2 text-[11px] text-slate-400">
                      {entry.category === "Champions" ? "Чемпион" : "Руна/Предмет"}
                    </span>
                    <span className="ml-auto text-[11px] font-mono text-slate-400">
                      score {score >= 0 ? `+${score}` : score}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-4 w-40 text-xs">
                    <span className="text-center text-emerald-700 font-semibold">+{entry.buffs}</span>
                    <span className="text-center text-red-700 font-semibold">-{entry.nerfs}</span>
                    <span className="text-center text-slate-600 font-semibold">{entry.adjusted}</span>
                  </div>
                </button>
              );
            })}
            {!loading && filtered.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-slate-400">
                Нет данных для тир-листа. Скачай патчи и попробуй снова.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function ChampionHistoryView() {
  const [entityType, setEntityType] = useState<"champion" | "rune" | "item">("champion");
  const location = useLocation();

  const [champion, setChampion] = useState<ChampionListItem | null>(null);
  const [selectedRune, setSelectedRune] = useState<RuneListItem | null>(null);
  const [selectedItem, setSelectedItem] = useState<ItemListItem | null>(null);

  const [allChamps, setAllChamps] = useState<ChampionListItem[]>([]);
  const [allRunes, setAllRunes] = useState<RuneListItem[]>([]);
  const [allItems, setAllItems] = useState<ItemListItem[]>([]);
  const [changedItemRuneTitles, setChangedItemRuneTitles] = useState<string[]>([]);

  const [history, setHistory] = useState<ChampionHistoryEntry[]>([]);
  const [aggregatedGroups, setAggregatedGroups] = useState<{ title: string | null, icon: string | null, changes: string[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const [prefill, setPrefill] = useState<{ type: "champion" | "rune" | "item"; name: string } | null>(null);

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

  // Руны и предметы из Data Dragon (ru + en для поиска)
  useEffect(() => {
    async function loadDDragon() {
      try {
        const verResp = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
        const versions: string[] = await verResp.json();
        const latest = versions[0] || "15.23.1";

        // ITEMS ru + en
        const [itemsRuResp, itemsEnResp] = await Promise.all([
          fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/ru_RU/item.json`),
          fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/item.json`),
        ]);
        const itemsRuJson = await itemsRuResp.json();
        const itemsEnJson = await itemsEnResp.json();

        const items: ItemListItem[] = Object.entries<any>(itemsRuJson.data || {})
          .filter(([_, ru]) => {
            // фильтрация: только предметы, доступные на карте 11 (Summoner's Rift) и продаваемые
            const maps = ru.maps || {};
            const gold = ru.gold || {};
            return maps["11"] && gold.purchasable !== false;
          })
          .map(([id, ru]) => {
            const en = itemsEnJson.data?.[id] ?? {};
            return {
              id: id as string,
              name: ru.name as string,
              nameEn: (en.name as string) || (ru.name as string),
              icon_url: `https://ddragon.leagueoflegends.com/cdn/${latest}/img/item/${id}.png`,
            };
          });
        setAllItems(items);

        // RUNES ru + en
        const [runesRuResp, runesEnResp] = await Promise.all([
          fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/ru_RU/runesReforged.json`),
          fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/runesReforged.json`),
        ]);
        const runesRuJson: any[] = await runesRuResp.json();
        const runesEnJson: any[] = await runesEnResp.json();

        const runes: RuneListItem[] = [];
        runesRuJson.forEach((treeRu, treeIndex) => {
          const treeEn = runesEnJson[treeIndex] || {};
          (treeRu.slots || []).forEach((slot: any, slotIndex: number) => {
            (slot.runes || []).forEach((runeRu: any, runeIndex: number) => {
              const runeEn = (((treeEn.slots || [])[slotIndex] || {}).runes || [])[runeIndex] || {};
              runes.push({
                name: runeRu.name as string,
                nameEn: (runeEn.name as string) || (runeRu.name as string),
                icon_url: `https://ddragon.leagueoflegends.com/cdn/${latest}/img/${runeRu.icon}`,
              });
            });
          });
        });
        setAllRunes(runes);
      } catch (e) {
        console.error(e);
        toast.error("Не удалось загрузить список рун/предметов из Data Dragon");
      }
    }

    loadDDragon();
  }, []);

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

  // Fallback для иконок рун/предметов по названию из DDragon
  const getFallbackIcon = (title: string | null) => {
    if (!title) return null;
    const t = title.toLowerCase();
    if (entityType === "rune") {
      const r = allRunes.find(r =>
        r.name.toLowerCase() === t || r.nameEn.toLowerCase() === t
      );
      return r?.icon_url || null;
    }
    if (entityType === "item") {
      const it = allItems.find(i =>
        i.name.toLowerCase() === t || i.nameEn.toLowerCase() === t
      );
      return it?.icon_url || null;
    }
    return null;
  };

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
          if (h.change.details) {
              h.change.details.forEach(d => {
                  const key = d.title || "Основные показатели"; // Default key if null
                  if (!groups.has(key)) {
                      groups.set(key, { icon: d.icon_url || null, rawChanges: [] });
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
  }, [history]);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
       <div className="flex items-center justify-between gap-4">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">История изменений</h2>
           <div className="inline-flex rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5 text-xs font-semibold">
             {[
               { key: "champion", label: "Чемпионы" },
               { key: "rune", label: "Руны" },
               { key: "item", label: "Предметы" },
             ].map(tab => (
               <button
                 key={tab.key}
                 onClick={() => {
                   setEntityType(tab.key as any);
                   setHistory([]);
                   setChampion(null);
                   setSelectedRune(null);
                   setSelectedItem(null);
                 }}
                 className={cn(
                   "px-3 py-1 rounded-lg transition-colors",
                   entityType === tab.key
                    ? "bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-200 shadow-sm border border-slate-200 dark:border-slate-700"
                    : "text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
                 )}
               >
                 {tab.label}
               </button>
             ))}
           </div>
       </div>

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
       ) : (
         entityType === "rune" ? (
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
         )
       )}
       {!loading && history.length > 0 && (
          <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-4 opacity-10"><History className="w-24 h-24 text-slate-300" /></div>
              <div className="flex items-center gap-4 mb-6 relative z-10">
                   {entityType === "champion" && champion && (
                     <img
                       src={cleanUrl(champion.icon_url)}
                       className="w-16 h-16 rounded-full border-4 border-white shadow-md bg-white object-cover"
                     />
                   )}
                   {entityType !== "champion" && history[history.length - 1]?.change.image_url && (
                     <img
                       src={cleanUrl(history[history.length - 1].change.image_url)}
                       className="w-16 h-16 rounded-full border-4 border-white shadow-md bg-white object-cover"
                     />
                   )}
                   <div>
                       <h3 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                         {entityType === "champion" && champion && champion.name}
                         {entityType === "rune" && selectedRune && selectedRune.name}
                         {entityType === "item" && selectedItem && selectedItem.name}
                       </h3>
                       <div className="text-xs text-slate-500 font-bold uppercase tracking-wider bg-white dark:bg-slate-800 px-2 py-1 rounded-md inline-block mt-1 border border-slate-100 dark:border-slate-700">
                         Общая сводка (20 патчей)
                       </div>
                   </div>
              </div>
              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm relative z-10 space-y-4">
                  {aggregatedGroups.map((group, i) => (
                      <div key={i}>
                          {group.title && (
                              <div className="flex items-center gap-2 mb-2 border-b border-slate-100 dark:border-slate-800 pb-1">
                                  {(() => {
                                    const icon = group.icon || getFallbackIcon(group.title);
                                    return icon ? (
                                      <img src={cleanUrl(icon)} className="w-6 h-6 rounded bg-slate-100 dark:bg-slate-800" />
                                    ) : null;
                                  })()}
                                  <h4 className="font-bold text-slate-800 dark:text-slate-100">{group.title}</h4>
                              </div>
                          )}
                          <ul className="space-y-2 pl-2">
                              {group.changes.map((change, j) => {
                                  const trend = analyzeChangeTrend(change);
                                  const lower = change.toLowerCase();
                                  const isNew = lower.includes("новое") || lower.includes("new");
                                  const isRemoved = lower.includes("удалено") || lower.includes("removed");
                                  const liClasses = cn(
                                    "text-sm pl-3 border-l-2 border-blue-200 relative leading-relaxed flex items-start justify-between gap-2 rounded-md pr-2",
                                    isNew && "bg-emerald-50 text-emerald-900",
                                    isRemoved && "bg-red-50 text-red-900",
                                  );
                                  const html = highlightSpecialTags(
                                    change
                                      .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold text-slate-900 dark:text-slate-100">$1</span>')
                                      .replace(/⇒/g, '<span class="text-slate-400 mx-1">→</span>')
                                  );
                                  return (
                                      <li key={j} className={liClasses}>
                                          <span dangerouslySetInnerHTML={{ 
                                              __html: html
                                          }} />
                                          <span className="shrink-0 mt-0.5">
                                              {trend === "up" && <ArrowUp className="w-3 h-3 text-green-600" />}
                                              {trend === "down" && <ArrowDown className="w-3 h-3 text-red-600" />}
                                              {trend === "neutral" && <ArrowRightLeft className="w-3 h-3 text-slate-400" />}
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
       {loading && <div className="text-center py-20 text-slate-400 flex flex-col items-center gap-4"><RefreshCw className="animate-spin w-8 h-8 text-blue-500" />Загрузка истории...</div>}
       {!loading && history.length === 0 && (
          <div className="p-12 text-center border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-slate-500 dark:text-slate-400 bg-transparent">
             Данных нет. Нажмите "Скачать патчи" в верхнем меню или выберите другую сущность.
          </div>
       )}
       <div className="relative border-l-2 border-slate-200 ml-6 space-y-8 py-2 pb-10">
          {[...history].sort((a, b) => compareVersions(b.patch_version, a.patch_version)).map((item, idx) => (
             <div key={idx} className="relative pl-8 group">
                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-slate-200 border-2 border-white group-hover:bg-blue-500 transition-colors ring-4 ring-white" />
                <div className="flex items-center gap-3 mb-3">
                    <span className="bg-slate-900 text-white px-3 py-1 rounded-md text-xs font-bold shadow-sm">Patch {item.patch_version}</span>
                    
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm hover:shadow-md transition-all hover:border-blue-200 dark:hover:border-blue-600/60 group-hover:translate-x-1 duration-300">
                   <div className="flex items-start justify-between mb-5 pb-4 border-b border-slate-100 dark:border-slate-800">
                       <div>
                            <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100">{item.change.title}</h3>
                            {item.change.summary && <p className="text-sm text-slate-500 dark:text-slate-300 mt-2 italic leading-relaxed bg-slate-50 dark:bg-slate-800 p-3 rounded-lg border border-slate-100 dark:border-slate-700">"{item.change.summary}"</p>}
                       </div>
                       <Badge type={item.change.change_type} />
                   </div>
                   <div className="space-y-6">
                      {Array.isArray(item.change.details) && item.change.details.map((block, i) => (
                         <div key={i} className="animate-in fade-in duration-500 delay-75">
                             {block.title && (
                                 <div className="flex items-center gap-3 mb-3">
                                     {block.icon_url && <img src={cleanUrl(block.icon_url)} className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm" />}
                                     <h4 className="font-bold text-slate-800 dark:text-slate-100 text-sm border-b-2 border-transparent hover:border-blue-500 transition-colors pb-0.5">{block.title}</h4>
                                 </div>
                             )}
                             <ul className="space-y-2">
                                {Array.isArray(block.changes) && block.changes.map((change, j) => (
                                   (() => {
                                     const lower = change.toLowerCase();
                                     const isNew = lower.includes("новое") || lower.includes("new");
                                     const isRemoved = lower.includes("удалено") || lower.includes("removed");
                                     const liClasses = cn(
                                       "text-sm text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-800 p-3 rounded-lg border border-slate-100 dark:border-slate-700 hover:bg-blue-50/50 dark:hover:bg-slate-700 transition-colors",
                                       isNew && "bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200",
                                       isRemoved && "bg-red-50 text-red-900 dark:bg-red-900/30 dark:text-red-200",
                                     );
                                     return (
                                       <li key={j} className={liClasses}>
                                          <span
                                            dangerouslySetInnerHTML={{
                                              __html: highlightSpecialTags(
                                    change
                                      .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold text-slate-900 dark:text-slate-100">$1</span>')
                                      .replace(/⇒/g, '<span class="text-slate-400 mx-1">→</span>')
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
  );
}

function PatchReleaseView({ data }: { data: PatchData | null }) {
  if (!data) return <EmptyState />;
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-baseline justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-3">Патч {data.version}</h2>
        <span className="text-slate-500 dark:text-slate-400 text-xs font-medium bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-full">Riot Games Official</span>
      </div>
      <div className="grid gap-4">
        {data.patch_notes.length === 0 ? (
          <div className="p-12 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50 text-slate-500">Патч-ноты не найдены.</div>
        ) : (
          data.patch_notes.map((note) => (
            <div key={note.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow group">
              <div className="flex items-start justify-between mb-4">
                <div className="flex gap-4">
                  <ChampionIcon url={cleanUrl(note.image_url)} name={note.title} />
                  <div>
                    <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100">{note.title}</h3>
                    {note.summary && <p className="text-sm text-slate-500 dark:text-slate-300 italic mt-1 border-l-2 border-slate-200 dark:border-slate-700 pl-2 max-w-2xl">{note.summary}</p>}
                  </div>
                </div>
                <Badge type={note.change_type} />
              </div>
              <div className="space-y-4 pl-4 border-l-2 border-slate-100 ml-6">
                  {Array.isArray(note.details) && note.details.map((block, i) => (
                      <div key={i}>
                          {block.title && (
                             <div className="flex items-center gap-2 mb-2">
                                 {block.icon_url && <img src={cleanUrl(block.icon_url)} className="w-6 h-6 rounded bg-slate-100 dark:bg-slate-800" />}
                                 <h4 className="font-bold text-slate-800 dark:text-slate-100 text-sm">{block.title}</h4>
                             </div>
                          )}
                          <ul className="space-y-2">
                            {Array.isArray(block.changes) && block.changes.map((change, j) => {
                                const lower = change.toLowerCase();
                                const isNew = lower.includes("новое") || lower.includes("new");
                                const isRemoved = lower.includes("удалено") || lower.includes("removed");
                                const liClasses = cn(
                                  "text-slate-700 dark:text-slate-200 text-sm leading-relaxed rounded-md px-2 py-1",
                                  isNew && "bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-200",
                                  isRemoved && "bg-red-50 dark:bg-red-900/30 dark:text-red-200",
                                );
                                return (
                                  <li key={j} className={liClasses}>
                                      <span
                                        dangerouslySetInnerHTML={{
                                          __html: highlightSpecialTags(
                                            change
                                              .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold text-slate-900 dark:text-slate-100">$1</span>')
                                              .replace(/⇒/g, '<span class="text-slate-400 mx-1">→</span>')
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
          ))
        )}
      </div>
    </div>
  );
}

// Helper components (ChampionSelect, ChampionIcon, EmptyState, Badge, etc.)
function ChampionSelect({ items, selected, onSelect }: { items: ChampionListItem[], selected: ChampionListItem | null, onSelect: (i: ChampionListItem) => void }) {
    const [query, setQuery] = useState("");
    const [isOpen, setIsOpen] = useState(false);
    const q = query.toLowerCase();
    const filtered = items
      .filter(i =>
        i.name.toLowerCase().includes(q) || i.name_en.toLowerCase().includes(q)
      )
      .sort((a, b) => {
        // приоритет: точное совпадение ru, en, затем startsWith, затем contains
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
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false); };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [ref]);

    return (
        <div ref={ref} className="relative max-w-lg w-full">
            <div className="flex items-center gap-3 w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 shadow-sm cursor-pointer hover:border-blue-300 dark:hover:border-blue-500 transition-all group" onClick={() => setIsOpen(!isOpen)}>
                <Search className="w-4 h-4 text-slate-400 dark:text-slate-300 group-hover:text-blue-500 transition-colors" />
                {selected ? (
                    <div className="flex items-center gap-3 flex-1">
                        <img src={selected.icon_url} className="w-6 h-6 rounded-full border border-slate-100 dark:border-slate-700" />
                        <span className="font-bold text-slate-700 dark:text-slate-100">{selected.name}</span>
                    </div>
                ) : (
                    <input type="text" placeholder="Выберите чемпиона..." className="flex-1 bg-transparent outline-none text-sm cursor-pointer text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500" value={query} onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }} onClick={(e) => e.stopPropagation()} />
                )}
                <ChevronDown className={cn("w-4 h-4 text-slate-400 dark:text-slate-300 transition-transform", isOpen && "rotate-180")} />
            </div>
            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-80 overflow-y-auto z-50 p-1 animate-in slide-in-from-top-2 duration-200">
                    <input type="text" placeholder="Поиск..." className="w-full px-3 py-2 border-b border-slate-100 dark:border-slate-700 outline-none text-sm mb-1 sticky top-0 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
                    {filtered.length === 0 ? <div className="p-4 text-center text-xs text-slate-400 dark:text-slate-500">Нет совпадений</div> : filtered.map(item => (
                        <div key={item.name} onClick={() => { onSelect(item); setIsOpen(false); setQuery(""); }} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800 cursor-pointer transition-colors">
                            <img src={cleanUrl(item.icon_url)} className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800" loading="lazy" />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-slate-700 dark:text-slate-100">{item.name}</span>
                              {item.name_en !== item.name && (
                                <span className="text-[11px] text-slate-400 dark:text-slate-500">{item.name_en}</span>
                              )}
                            </div>
                            {selected?.name === item.name && <Check className="w-4 h-4 text-blue-600 ml-auto" />}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function RuneSelect({ items, selected, onSelect }: { items: RuneListItem[], selected: RuneListItem | null, onSelect: (i: RuneListItem) => void }) {
    const [query, setQuery] = useState("");
    const [isOpen, setIsOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false); };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [ref]);

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
        <div ref={ref} className="relative max-w-lg w-full">
            <div className="flex items-center gap-3 w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 shadow-sm cursor-pointer hover:border-blue-300 dark:hover:border-blue-500 transition-all group" onClick={() => setIsOpen(!isOpen)}>
                <Search className="w-4 h-4 text-slate-400 dark:text-slate-300 group-hover:text-blue-500 transition-colors" />
                {selected ? (
                    <div className="flex items-center gap-3 flex-1">
                        <img src={cleanUrl(selected.icon_url)} className="w-6 h-6 rounded-full border border-slate-100 dark:border-slate-700" />
                        <span className="font-bold text-slate-700 dark:text-slate-100">{selected.name}</span>
                    </div>
                ) : (
                    <input
                      type="text"
                      placeholder="Выберите руну..."
                      className="flex-1 bg-transparent outline-none text-sm cursor-pointer text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      value={query}
                      onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                )}
                <ChevronDown className={cn("w-4 h-4 text-slate-400 dark:text-slate-300 transition-transform", isOpen && "rotate-180")} />
            </div>
            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-80 overflow-y-auto z-50 p-1 animate-in slide-in-from-top-2 duration-200">
                    <input
                      type="text"
                      placeholder="Поиск (ru/en)..."
                      className="w-full px-3 py-2 border-b border-slate-100 dark:border-slate-700 outline-none text-sm mb-1 sticky top-0 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      autoFocus
                    />
                    {filtered.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-400 dark:text-slate-500">Нет совпадений</div>
                    ) : (
                      filtered.map((item, idx) => (
                        <div
                          key={item.name + idx}
                          onClick={() => { onSelect(item); setIsOpen(false); setQuery(""); }}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800 cursor-pointer transition-colors"
                        >
                            <img src={cleanUrl(item.icon_url)} className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800" loading="lazy" />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-slate-700 dark:text-slate-100">{item.name}</span>
                              {item.nameEn !== item.name && (
                                <span className="text-[11px] text-slate-400 dark:text-slate-500">{item.nameEn}</span>
                              )}
                            </div>
                            {selected?.name === item.name && <Check className="w-4 h-4 text-blue-600 ml-auto" />}
                        </div>
                      ))
                    )}
                </div>
            )}
        </div>
    );
}

function ItemSelect({ items, selected, onSelect }: { items: ItemListItem[], selected: ItemListItem | null, onSelect: (i: ItemListItem) => void }) {
    const [query, setQuery] = useState("");
    const [isOpen, setIsOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false); };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [ref]);

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
        <div ref={ref} className="relative max-w-lg w-full">
            <div className="flex items-center gap-3 w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 shadow-sm cursor-pointer hover:border-blue-300 dark:hover:border-blue-500 transition-all group" onClick={() => setIsOpen(!isOpen)}>
                <Search className="w-4 h-4 text-slate-400 dark:text-slate-300 group-hover:text-blue-500 transition-colors" />
                {selected ? (
                    <div className="flex items-center gap-3 flex-1">
                        <img src={cleanUrl(selected.icon_url)} className="w-6 h-6 rounded-full border border-slate-100 dark:border-slate-700" />
                        <span className="font-bold text-slate-700 dark:text-slate-100">{selected.name}</span>
                    </div>
                ) : (
                    <input
                      type="text"
                      placeholder="Выберите предмет..."
                      className="flex-1 bg-transparent outline-none text-sm cursor-pointer text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      value={query}
                      onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                )}
                <ChevronDown className={cn("w-4 h-4 text-slate-400 dark:text-slate-300 transition-transform", isOpen && "rotate-180")} />
            </div>
            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-80 overflow-y-auto z-50 p-1 animate-in slide-in-from-top-2 duration-200">
                    <input
                      type="text"
                      placeholder="Поиск (ru/en)..."
                      className="w-full px-3 py-2 border-b border-slate-100 dark:border-slate-700 outline-none text-sm mb-1 sticky top-0 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      autoFocus
                    />
                    {filtered.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-400 dark:text-slate-500">Нет совпадений</div>
                    ) : (
                      filtered.map(item => (
                        <div
                          key={item.name + item.nameEn}
                          onClick={() => { onSelect(item); setIsOpen(false); setQuery(""); }}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800 cursor-pointer transition-colors"
                        >
                            <img src={cleanUrl(item.icon_url)} className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800" loading="lazy" />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-slate-700 dark:text-slate-100">{item.name}</span>
                              {item.nameEn !== item.name && (
                                <span className="text-[11px] text-slate-400 dark:text-slate-500">{item.nameEn}</span>
                              )}
                            </div>
                            {selected?.name === item.name && <Check className="w-4 h-4 text-blue-600 ml-auto" />}
                        </div>
                      ))
                    )}
                </div>
            )}
        </div>
    );
}

function ChampionIcon({ url, name, size = "md" }: { url?: string, name: string, size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: "w-8 h-8", md: "w-12 h-12", lg: "w-16 h-16" };
  if (url) return <img src={cleanUrl(url)} alt={name} className={cn(sizes[size], "rounded-full border border-slate-200 shadow-sm object-cover bg-slate-100")} />;
  return <div className={cn(sizes[size], "rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-400 border border-slate-200")}>{name.slice(0, 2)}</div>;
}

function MetaChangesView({ diffs }: { diffs: MetaAnalysisDiff[] }) {
  if (diffs.length === 0) return <EmptyState message="Находится в разработке, собираем статистику." />;
  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Сдвиги Меты</h2>
      <div className="grid gap-3">
        {diffs.map((diff, idx) => (
          <div key={idx} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex items-center justify-between shadow-sm hover:border-blue-200 dark:hover:border-blue-600/60 transition-colors">
            <div className="flex items-center gap-4">
               <ChampionIcon url={cleanUrl(diff.champion_image_url)} name={diff.champion_name} />
               <div>
                 <div className="font-bold text-slate-900 dark:text-slate-100">{diff.champion_name}</div>
                 <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold">{diff.role}</div>
               </div>
            </div>
            <div className="flex gap-8 text-right items-center">
                <div className={cn("px-2 py-1 rounded text-xs font-bold flex items-center gap-1", diff.win_rate_diff > 0 ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600")}>
                    {diff.win_rate_diff > 0 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />} {Math.abs(diff.win_rate_diff)}%
                </div>
               <Stat val={diff.win_rate_diff} label="Win Rate" />
               <Stat val={diff.pick_rate_diff} label="Pick Rate" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PredictionsView({ diffs }: { diffs: MetaAnalysisDiff[] }) {
  const predicted = diffs.filter(d => d.predicted_change);
  if (predicted.length === 0) return <EmptyState message="Находится в разработке, собираем статистику." />;
  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Прогноз vs Реальность</h2>
      <div className="grid md:grid-cols-2 gap-4">
        {predicted.map((item, idx) => (
          <div key={idx} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-xl shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
             <div className={cn("absolute top-0 right-0 px-3 py-1 text-xs font-bold rounded-bl-lg border-l border-b border-slate-100 dark:border-slate-700", item.predicted_change === "Buff" ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-200" : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-200")}>
               {item.predicted_change?.toUpperCase()}
             </div>
             <div className="flex items-center gap-3 mb-3">
                <ChampionIcon url={cleanUrl(item.champion_image_url)} name={item.champion_name} />
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{item.champion_name}</h3>
             </div>
             <div className="text-sm text-slate-500 dark:text-slate-300 mb-4">{item.predicted_change === "Buff" ? "Ожидалось усиление" : "Ожидалось ослабление"}</div>
             <div className="flex items-center justify-between text-sm bg-slate-50 dark:bg-slate-800 p-3 rounded border border-slate-100 dark:border-slate-700">
                <span className="text-slate-500 dark:text-slate-300 font-medium">Результат (Win Rate):</span>
                <div className="flex items-center gap-2">
                    {item.win_rate_diff !== 0 && (<span className={cn("font-bold", item.win_rate_diff > 0 ? "text-green-600" : "text-red-600")}>{item.win_rate_diff > 0 ? "+" : ""}{item.win_rate_diff}%</span>)}
                    {item.win_rate_diff === 0 && <span className="text-slate-400 font-bold">Нет данных</span>}
                </div>
             </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RealStatsView() {
    const [stats, setStats] = useState<SupabaseChampionStats[]>([]);
    const [patches, setPatches] = useState<string[]>([]);
    const [selectedPatch, setSelectedPatch] = useState<string>("");
    const [selectedRole, setSelectedRole] = useState<string>("all");
    const [selectedRegion, setSelectedRegion] = useState<string>("all");
    const [selectedTier, setSelectedTier] = useState<string>("all");
    const [loading, setLoading] = useState(false);
    const [allChamps, setAllChamps] = useState<ChampionListItem[]>([]);
    const [champDict, setChampDict] = useState<Record<string, ChampionMeta>>({});
    const [ddragonVersion, setDdragonVersion] = useState<string>("15.24.1");
    const [prevStatsMap, setPrevStatsMap] = useState<Record<string, SupabaseChampionStats>>({});
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        invoke<string[]>("get_available_stats_patches").then(list => {
            console.log("Available patches:", list);
            setPatches(list);
            setError(null);
            if (list.length > 0) {
                setSelectedPatch(list[0]);
            } else {
                console.warn("No patches available in stats");
                setError("Нет доступных патчей в Supabase.");
            }
        }).catch(e => {
            const errorMsg = String(e);
            console.error("Error fetching patches:", errorMsg);
            const isSilentError = errorMsg === "1" || errorMsg === "101" || 
                                  errorMsg.trim() === "1" || errorMsg.trim() === "101" ||
                                  errorMsg.includes("Network error") || 
                                  errorMsg.includes("404") ||
                                  errorMsg.includes("not found") ||
                                  errorMsg.includes("RPC function");
            if (!isSilentError) {
                toast.error("Ошибка получения списка патчей: " + errorMsg);
            } else if (errorMsg.includes("RPC function")) {
                console.warn("RPC function not found - statistics feature unavailable");
            }
            setError("Не удалось получить список патчей из Supabase.");
        });

        invoke<ChampionListItem[]>("get_all_champions").then(setAllChamps).catch(console.error);
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const versions: string[] = await fetch("https://ddragon.leagueoflegends.com/api/versions.json").then(r => r.json());
                const ver = Array.isArray(versions) && versions.length ? versions[0] : ddragonVersion;
                const [ru, en] = await Promise.all([
                    fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/ru_RU/champion.json`).then(r => r.json()),
                    fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/champion.json`).then(r => r.json())
                ]);
                const ruData: Record<string, any> = ru?.data || {};
                const enData: Record<string, any> = en?.data || {};
                const map: Record<string, ChampionMeta> = {};
                Object.values(ruData).forEach((item: any) => {
                    const key = item.key;
                    const meta = {
                        nameRu: item.name,
                        nameEn: enData[item.id]?.name ?? item.id,
                        icon: `https://ddragon.leagueoflegends.com/cdn/${ver}/img/champion/${item.id}.png`
                    };
                    map[item.id] = meta;
                    map[key] = meta;
                });
                setChampDict(map);
                setDdragonVersion(ver);
            } catch (e) {
                console.error("Failed to load DDragon champs", e);
            }
        })();
    }, []);

    useEffect(() => {
        if (!selectedPatch) return;
        setLoading(true);
        setError(null);

        const idx = patches.findIndex(p => p === selectedPatch);
        const prevPatch = idx >= 0 && idx + 1 < patches.length ? patches[idx + 1] : null;

        const makeMap = (arr: SupabaseChampionStats[]) => {
            const m: Record<string, SupabaseChampionStats> = {};
            arr.forEach(item => {
                const key = `${item.champion_id}|${item.role || ""}`;
                m[key] = item;
            });
            return m;
        };

        console.log("Fetching stats for patch:", selectedPatch);
        Promise.all([
            invoke<SupabaseChampionStats[]>("get_real_stats", { patch: selectedPatch }),
            prevPatch ? invoke<SupabaseChampionStats[]>("get_real_stats", { patch: prevPatch }).catch(() => []) : Promise.resolve([])
        ])
        .then(([curr, prev]) => {
            console.log("Received stats:", curr);
            setStats(curr);
            setPrevStatsMap(makeMap(prev));
        })
        .catch(e => {
            const errorMsg = String(e);
            console.error("Error fetching stats:", errorMsg);
            const isSilentError = errorMsg === "1" || errorMsg === "101" || 
                                  errorMsg.trim() === "1" || errorMsg.trim() === "101" ||
                                  errorMsg.includes("Network error") || errorMsg.includes("404") || 
                                  errorMsg.includes("empty");
            if (!isSilentError) {
                toast.error("Ошибка получения статистики: " + errorMsg);
            }
            setError("Не удалось получить статистику для выбранного патча.");
        })
        .finally(() => setLoading(false));
    }, [selectedPatch]);

    const getChampIcon = (name: string) => {
        if (champDict[name]?.icon) return champDict[name].icon;
        const found = allChamps.find(c => c.name === name || c.name_en === name || c.name.toLowerCase() === name.toLowerCase());
        return found?.icon_url;
    };

    const getChampName = (id: string) => champDict[id]?.nameRu || id;
    const getChampNameEn = (id: string) => champDict[id]?.nameEn || id;

    const rankIcons: Record<string, string> = {
        platinum: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/ranked-emblem/emblem-platinum.png",
        emerald: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/ranked-emblem/emblem-emerald.png",
        diamond: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/ranked-emblem/emblem-diamond.png",
        master: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/ranked-emblem/emblem-master.png",
        grandmaster: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/ranked-emblem/emblem-grandmaster.png",
        challenger: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/ranked-emblem/emblem-challenger.png",
    };

    const roleIcons: Record<string, string> = {
        top: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-parties/global/default/icon-position-top-blue.png",
        jungle: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-parties/global/default/icon-position-jungle-blue.png",
        mid: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-parties/global/default/icon-position-middle-blue.png",
        bottom: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-parties/global/default/icon-position-bottom-blue.png",
        support: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-parties/global/default/icon-position-utility-blue.png",
        fill: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-parties/global/default/icon-position-fill-blue.png",
        unknown: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-parties/global/default/icon-position-fill-blue.png",
    };

    const normalizeRole = (role?: string | null) => {
        if (!role) return "";
        const r = role.trim().toLowerCase();
        if (r === "middle" || r === "mid") return "mid";
        if (r === "bottom" || r === "bot" || r === "adc") return "bottom";
        if (r === "support" || r === "utility" || r === "supp") return "support";
        if (r === "fill" || r === "any" || r === "unknown") return "fill";
        return r;
    };

    const getRankIcon = (tier?: string | null) => {
        if (!tier) return null;
        const key = tier.toLowerCase();
        return rankIcons[key] || null;
    };

    const getRoleIcon = (role?: string | null) => {
        const key = normalizeRole(role);
        if (!key) return null;
        return roleIcons[key] || null;
    };

    const roles = Array.from(new Set(stats.map(s => normalizeRole(s.role) || "").filter(Boolean)));
    const regions = Array.from(new Set(stats.map(s => (s.region || "").trim()).filter(Boolean)));
    const normalizeTier = (t?: string | null) => (t || "").trim().toLowerCase();
    const tiersRawLower = Array.from(new Set(stats.map(s => normalizeTier(s.tier)).filter(Boolean)));

    const filteredStats = stats.filter(row => {
        const matchRole = selectedRole === "all" || normalizeRole(row.role) === selectedRole;
        const matchRegion = selectedRegion === "all" || (row.region || "") === selectedRegion;
        const matchTier = selectedTier === "all" || normalizeTier(row.tier) === normalizeTier(selectedTier);
        return matchRole && matchRegion && matchTier;
    });

    const hasBanFiltered = filteredStats.some(s => s.ban_rate !== null && s.ban_rate !== undefined);

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                  <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-3">
                      <DbIcon className="w-6 h-6 text-blue-500" />
                      Live Статистика
                  </h2>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <IconSelect
                        label="Патч"
                        value={selectedPatch}
                        onChange={setSelectedPatch}
                        options={[
                            { value: "all", label: "Все", disabled: true },
                            ...patches.map(p => ({ value: p, label: p }))
                        ]}
                    />
                    <IconSelect
                        label="Роль"
                        value={selectedRole}
                        onChange={setSelectedRole}
                        options={[
                            { value: "all", label: "Все" },
                            ...roles.map(r => ({ value: r, label: r || "—", icon: getRoleIcon(r) || undefined }))
                        ]}
                    />
                    <IconSelect
                        label="Сервер"
                        value={selectedRegion}
                        onChange={setSelectedRegion}
                        options={[
                            { value: "all", label: "Все" },
                            ...regions.map(r => ({ value: r, label: r || "—" }))
                        ]}
                    />
                    <IconSelect
                        label="Ранг"
                        value={selectedTier}
                        onChange={setSelectedTier}
                        options={[
                            { value: "all", label: "Все" },
                            { value: "challenger", label: "Challenger", icon: getRankIcon("challenger") || undefined, disabled: !tiersRawLower.includes("challenger") },
                            { value: "grandmaster", label: "Grandmaster", icon: getRankIcon("grandmaster") || undefined, disabled: !tiersRawLower.includes("grandmaster") },
                            { value: "master", label: "Master", icon: getRankIcon("master") || undefined, disabled: !tiersRawLower.includes("master") },
                            { value: "diamond", label: "Diamond", icon: getRankIcon("diamond") || undefined, disabled: !tiersRawLower.includes("diamond") },
                            { value: "emerald", label: "Emerald", icon: getRankIcon("emerald") || undefined, disabled: !tiersRawLower.includes("emerald") },
                            { value: "platinum", label: "Platinum", icon: getRankIcon("platinum") || undefined, disabled: !tiersRawLower.includes("platinum") },
                        ]}
                    />
                </div>
            </div>

            {loading ? (
                 <div className="text-center py-20 text-slate-400 flex flex-col items-center gap-4">
                    <RefreshCw className="animate-spin w-8 h-8 text-blue-500" />
                    Загрузка данных из облака...
                </div>
            ) : error ? (
                 <EmptyState message={error} />
            ) : filteredStats.length === 0 ? (
                 <EmptyState message="Нет данных статистики для выбранного патча." />
            ) : (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300 font-semibold border-b border-slate-200 dark:border-slate-700">
                            <tr>
                                <th className="px-4 py-3">Чемпион</th>
                                <th className="px-4 py-3">Роль</th>
                                <th className="px-4 py-3 text-right">Win Rate</th>
                                <th className="px-4 py-3 text-right">Pick Rate</th>
                                {hasBanFiltered && <th className="px-4 py-3 text-right">Ban Rate</th>}
                                <th className="px-4 py-3 text-right">Матчей</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {filteredStats.map((row, idx) => (
                                <tr key={idx} className="hover:bg-blue-50/50 dark:hover:bg-slate-800 transition-colors">
                                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100 flex items-center gap-3">
                                        <ChampionIcon url={getChampIcon(row.champion_id)} name={getChampName(row.champion_id)} size="sm" />
                                        <div className="flex flex-col leading-tight">
                                            <span>{getChampName(row.champion_id)}</span>
                                            <span className="text-[11px] text-slate-400">{getChampNameEn(row.champion_id)}</span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-slate-500 text-xs uppercase font-bold tracking-wider">
                                        {getRoleIcon(row.role) ? (
                                            <img src={getRoleIcon(row.role)!} alt={row.role || "role"} className="w-6 h-6" />
                                        ) : (
                                            normalizeRole(row.role) || row.role
                                        )}
                                    </td>
                                    <td className={cn("px-4 py-3 text-right font-mono font-bold", (row.win_rate || 0) >= 50 ? "text-green-600" : "text-red-600")}>
                                        {row.win_rate ? row.win_rate.toFixed(2) : "-"}%
                                    </td>
                                    <td className="px-4 py-3 text-right text-slate-600 font-mono">
                                        {row.pick_rate ? row.pick_rate.toFixed(2) : "-"}%
                                    </td>
                                    {hasBanFiltered && (
                                      <td className="px-4 py-3 text-right text-slate-400 font-mono">
                                          {row.ban_rate !== null && row.ban_rate !== undefined ? row.ban_rate.toFixed(2) : "-" }%
                                      </td>
                                    )}
                                    <td className="px-4 py-3 text-right text-slate-400 text-xs">
                                        {row.total_matches || 0}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function EmptyState({ message = "Выберите патч и нажмите Обновить" }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
      <p>{message}</p>
    </div>
  );
}

function Badge({ type }: { type: string }) {
  const styles = { Buff: "bg-green-100 text-green-800 border-green-200", Nerf: "bg-red-100 text-red-800 border-red-200", Adjusted: "bg-yellow-100 text-yellow-800 border-yellow-200", New: "bg-blue-100 text-blue-800 border-blue-200", Fix: "bg-slate-100 text-slate-600 border-slate-200", None: "hidden" };
  // @ts-ignore
  const style = styles[type] || styles.Adjusted;
  return <span className={cn("px-2.5 py-0.5 rounded-full text-xs font-bold border", style)}>{type}</span>;
}

function Stat({ val, label }: { val: number, label: string }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-0.5">{label}</div>
      <div className={cn("font-mono font-bold", val > 0 ? "text-green-600" : val < 0 ? "text-red-600" : "text-slate-400")}>{val > 0 ? "+" : ""}{val}%</div>
    </div>
  );
}

export default App;
