import { useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { BookOpen, LineChart, TrendingUp, History, ScrollText, Check, Search, DownloadCloud, ChevronDown, RefreshCw, ArrowUp, ArrowDown, ArrowRightLeft, X, Circle, Settings } from "lucide-react";
import { cn } from "./lib/utils";

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
    '<span class="inline px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold text-[11px] align-middle">$1</span>',
  );
  // УДАЛЕНО / Удалено / REMOVED
  text = text.replace(
    /(УДАЛЕНО|Удалено|REMOVED)/g,
    '<span class="inline px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold text-[11px] align-middle">$1</span>',
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
interface ChampionListItem { name: string; name_en: string; icon_url: string; key: string; id: string; }
interface RuneListItem { id: string; name: string; nameEn: string; icon_url: string; key?: string; style?: string; }
interface ItemListItem { id: string; name: string; nameEn: string; icon_url: string; }
interface LogEntry { level: string; message: string; timestamp: string; }
interface TierEntry { name: string; category: string; buffs: number; nerfs: number; adjusted: number; icon_url?: string | null; }

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

type ThemeOption = "light" | "dark" | "system";

function App() {
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState("15.23"); 
  const [patchesList, setPatchesList] = useState<string[]>([]);
  const [patchData, setPatchData] = useState<PatchData | null>(null);
  const [diffs, setDiffs] = useState<MetaAnalysisDiff[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [patchesStatus, setPatchesStatus] = useState<Record<string, boolean>>({});
  const [newPatches, setNewPatches] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeOption>("system");
  const [effectiveTheme, setEffectiveTheme] = useState<"light" | "dark">("light");
  const location = useLocation();

  // Инициализация и применение темы
  useEffect(() => {
    const stored = (localStorage.getItem("theme") as ThemeOption | null) || "system";
    setTheme(stored);
    
    // Применяем тему сразу синхронно
    let eff: "light" | "dark";
    if (stored === "system") {
      eff = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      eff = stored;
    }
    
    const root = document.documentElement;
    const body = document.body;

    if (eff === "dark") {
      root.classList.add("dark");
      body.classList.remove("theme-light");
      body.classList.add("theme-dark");
    } else {
      root.classList.remove("dark");
      body.classList.remove("theme-dark");
      body.classList.add("theme-light");
    }
    
    setEffectiveTheme(eff);
  }, []);

  // Применение темы при изменении
  useEffect(() => {
    let eff: "light" | "dark";
    if (theme === "system") {
      eff = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      eff = theme;
    }
    setEffectiveTheme(eff);
    localStorage.setItem("theme", theme);

    const root = document.documentElement;
    const body = document.body;

    if (eff === "dark") {
      root.classList.add("dark");
      body.classList.remove("theme-light");
      body.classList.add("theme-dark");
    } else {
      root.classList.remove("dark");
      body.classList.remove("theme-dark");
      body.classList.add("theme-light");
    }
  }, [theme]);

  useEffect(() => {
    invoke<string[]>("get_available_patches").then(list => {
        setPatchesList(list);
        if (list.length > 0) setVersion(list[0]);
        // Проверяем наличие патчей в БД
        invoke<Record<string, boolean>>("check_patches_exist", { versions: list }).then(status => {
            setPatchesStatus(status);
        }).catch(console.error);
        
        // Проверяем новые патчи - берем первый патч из списка (самый новый)
        // и проверяем, загружен ли он в БД
        if (list.length > 0) {
            const latestPatch = list[0];
            const existsInDb = patchesStatus[latestPatch];
            
            // Если патч есть в списке, но не загружен в БД - это новый патч
            if (!existsInDb) {
                invoke<boolean>("check_patch_notes_exists", { version: latestPatch }).then(exists => {
                    if (exists) {
                        setNewPatches(new Set([latestPatch]));
                    }
                }).catch(console.error);
            }
        }
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
        if (force) {
            toast.success(`Патч ${ver} обновлен`);
            // Обновляем статус патча после загрузки
            setPatchesStatus(prev => ({ ...prev, [ver]: true }));
            // Убираем из списка новых, если был там
            setNewPatches(prev => {
                const updated = new Set(prev);
                updated.delete(ver);
                return updated;
            });
        }
    } catch (error) {
        console.error(error);
        toast.error("Ошибка загрузки: " + String(error));
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
          // Обновляем статус патчей
          if (patchesList.length > 0) {
              invoke<Record<string, boolean>>("check_patches_exist", { versions: patchesList }).then(status => {
                  setPatchesStatus(status);
                  // Если новый патч был загружен, убираем его из списка новых
                  setNewPatches(prev => {
                      const updated = new Set(prev);
                      Object.keys(status).forEach(v => {
                          if (status[v]) updated.delete(v);
                      });
                      return updated;
                  });
              }).catch(console.error);
          }
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
    { path: "/tier", label: "Тир-лист", icon: LineChart },
    { path: "/history", label: "История изменений", icon: History },
    { path: "/logs", label: "Логи", icon: ScrollText },
  ];

  const isDark = effectiveTheme === "dark";

  return (
    <ErrorBoundary>
    <div className={cn(
      "min-h-screen flex flex-col font-sans selection:bg-blue-100 transition-colors",
      isDark ? "bg-slate-900 text-slate-50" : "bg-slate-50 text-slate-900"
    )}>
      <Toaster position="top-right" theme="light" />
      <header
        className={cn(
          "border-b backdrop-blur-md px-4 py-3 sticky top-0 z-50 shadow-sm transition-colors",
          isDark ? "bg-slate-900/95 border-slate-800" : "bg-white/95 border-slate-200"
        )}
      >
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 md:gap-6 flex-wrap">
             <div className="flex items-center gap-3 cursor-default">
                <div className="relative">
                    <img src="/A.svg" alt="LoL Analyzer" className="w-10 h-10 relative z-10 drop-shadow-sm" />
                </div>
                <div>
                  <h1 className={cn(
                    "text-xl font-bold leading-none tracking-tight transition-colors",
                    isDark ? "text-slate-50" : "text-slate-900"
                  )}>LoL Analyzer</h1>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider font-bold">Patch {version}</span>
                </div>
             </div>
            <nav
              className={cn(
                "flex flex-wrap gap-1 p-1 rounded-lg border mt-3 md:mt-0 md:ml-4 transition-colors",
                isDark ? "bg-slate-800/80 border-slate-700" : "bg-white/90 border-slate-200"
              )}
            >
              {navItems.map(({ path, label, icon: Icon }) => (
                <Link
                  key={path}
                  to={path}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                    location.pathname === path
                      ? (isDark
                          ? "bg-slate-900 text-blue-300 shadow-sm border border-slate-700"
                          : "bg-white text-blue-600 shadow-sm border border-slate-200")
                      : (isDark
                          ? "text-slate-300 hover:text-slate-50 hover:bg-slate-700/70"
                          : "text-slate-500 hover:text-slate-900 hover:bg-slate-50")
                  )}
                >
                  <Icon className="w-4 h-4" /> {label}
                </Link>
              ))}
            </nav>
          </div>
          {/* Группа действий: иконки в один ряд; при маленькой ширине блок уходит под заголовок, но сами кнопки не ломаются по вертикали */}
          <div className="flex gap-2 items-center md:ml-auto pl-2 justify-start md:justify-end whitespace-nowrap">
            <button
              onClick={handleSyncAll}
              disabled={syncing}
              title="Скачать патчи"
              aria-label="Скачать патчи"
              className={cn(
                "inline-flex items-center justify-center w-9 h-9 rounded-md border shadow-sm active:scale-95 transition-colors",
                syncing
                  ? "bg-slate-100 text-slate-400 border-transparent"
                  : "bg-white hover:bg-blue-50 text-slate-700 border-slate-200 hover:border-blue-200 hover:text-blue-600"
              )}
            >
              <DownloadCloud className={cn("w-4 h-4", syncing && "animate-bounce")} />
            </button>
            <button
              onClick={() => setSettingsOpen(o => !o)}
              title="Настройки"
              aria-label="Настройки"
              className={cn(
                "inline-flex items-center justify-center w-9 h-9 rounded-md border shadow-sm active:scale-95 transition-colors",
                isDark
                  ? "border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700"
                  : "border-slate-300 bg-white/80 text-slate-700 hover:bg-slate-50"
              )}
            >
              <Settings className="w-4 h-4" />
            </button>
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
               title="Сброс"
               aria-label="Сброс"
               className="inline-flex items-center justify-center w-9 h-9 rounded-md border shadow-sm active:scale-95 transition-colors bg-red-50 text-red-600 border-red-300 hover:bg-red-100"
            >
               <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
        {settingsOpen && (
          <div className="max-w-6xl mx-auto mt-3 px-1">
            <div className="relative">
              <div
                className={cn(
                  "absolute right-0 w-full sm:w-80 rounded-xl shadow-xl p-4 z-40 border transition-colors",
                  isDark ? "bg-slate-900 border-slate-700" : "bg-white border-slate-200/80"
                )}
              >
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Настройки</h2>
                  <button
                    onClick={() => setSettingsOpen(false)}
                    className="text-xs text-slate-400 hover:text-slate-600"
                  >
                    Закрыть
                  </button>
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <div className="font-semibold text-slate-700 dark:text-slate-200 mb-1">Тема</div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { value: "system" as ThemeOption, label: "Системная" },
                        { value: "light" as ThemeOption, label: "Светлая" },
                        { value: "dark" as ThemeOption, label: "Тёмная" },
                      ].map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setTheme(opt.value)}
                          className={cn(
                            "px-2.5 py-1 rounded-md border text-xs font-medium transition-colors",
                            theme === opt.value
                              ? "bg-blue-50 border-blue-400 text-blue-700"
                              : "bg-slate-50/60 border-slate-200 text-slate-600 hover:bg-slate-100"
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-700 text-[11px] text-slate-500 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Разработчик:</span>
                    <a
                      href="https://github.com/Jab04kin"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 hover:text-blue-600"
                    >
                      <img
                        src="https://avatars.githubusercontent.com/Jab04kin"
                        alt="@Shpinat"
                        style={{ width: 30, height: 30 }}
                        className="rounded-full"
                      />
                      <span>@Shpinat</span>
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Организация:</span>
                    <a
                      href="https://github.com/RaspizDIYs"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 hover:text-blue-600"
                    >
                      <span>RaspizDIYs</span>
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Сообщество:</span>
                    <a
                      href="https://discord.gg/dmx5GqHDcN"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 hover:text-indigo-500"
                    >
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-indigo-600 text-white">
                        <svg
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          className="w-3 h-3"
                        >
                          <path
                            fill="currentColor"
                            d="M20.317 4.369A19.791 19.791 0 0 0 16.558 3a13.276 13.276 0 0 0-.622 1.282 18.27 18.27 0 0 0-3.872 0A12.63 12.63 0 0 0 11.442 3a19.736 19.736 0 0 0-3.76 1.38C4.209 9.05 3.447 13.58 3.782 18.045a19.9 19.9 0 0 0 4.886 2.476 15.02 15.02 0 0 0 1.176-1.9 12.93 12.93 0 0 1-1.853-.9c.156-.113.308-.23.455-.35a8.9 8.9 0 0 0 7.108 0c.15.12.302.237.455.35-.59.35-1.21.65-1.853.9.34.66.73 1.29 1.176 1.9a19.8 19.8 0 0 0 4.886-2.476c.4-4.59-.676-9.08-3.946-13.676ZM9.68 15.332c-1.07 0-1.955-.98-1.955-2.186 0-1.205.86-2.2 1.955-2.2 1.105 0 1.982.995 1.955 2.2 0 1.206-.85 2.186-1.955 2.186Zm4.64 0c-1.07 0-1.955-.98-1.955-2.186 0-1.205.86-2.2 1.955-2.2 1.105 0 1.982.995 1.955 2.2 0 1.206-.85 2.186-1.955 2.186Z"
                          />
                        </svg>
                      </span>
                      <span>Discord</span>
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </header>
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-4 sm:px-6 sm:py-6">
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<PatchReleaseView data={patchData} version={version} patchesList={patchesList} onVersionChange={setVersion} loading={loading} patchesStatus={patchesStatus} newPatches={newPatches} />} />
            <Route path="/meta" element={<MetaChangesView diffs={diffs} />} />
            <Route path="/predictions" element={<PredictionsView diffs={diffs} />} />
            <Route path="/tier" element={<TierListView />} />
            <Route path="/history" element={<ChampionHistoryView />} />
            <Route path="/logs" element={<LogsView logs={logs} />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <SupabaseStatusIndicator />
    </div>
    </ErrorBoundary>
  );
}

function SupabaseStatusIndicator() {
  const [status, setStatus] = useState<"active" | "inactive" | "error" | "checking">("checking");

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const result = await invoke<boolean>("check_supabase_status");
        setStatus(result ? "active" : "inactive");
      } catch (error) {
        setStatus("error");
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const getStatusColor = () => {
    switch (status) {
      case "active":
        return "bg-green-500";
      case "error":
        return "bg-red-500";
      case "inactive":
      case "checking":
      default:
        return "bg-gray-400";
    }
  };

  const isPulsing = status === "active";

  return (
    <div className="fixed bottom-4 right-4 flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 z-50">
      <div className="relative">
        <div
          className={cn(
            "w-3 h-3 rounded-full",
            getStatusColor(),
            isPulsing && "animate-pulse"
          )}
        />
        {isPulsing && (
          <div
            className={cn(
              "absolute inset-0 rounded-full bg-green-500",
              "animate-ping opacity-75"
            )}
          />
        )}
      </div>
      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
        data
      </span>
    </div>
  );
}

function CustomPatchSelect({ value, options, onChange, loading, patchesStatus, newPatches }: { value: string, options: string[], onChange: (v: string) => void, loading: boolean, patchesStatus?: Record<string, boolean>, newPatches?: Set<string> }) {
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
                className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-sm w-32 justify-between"
            >
                <div className="flex items-center gap-2">
                  {/* Зеленый круг для текущего патча */}
                  <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_0_3px_rgba(34,197,94,0.4)]" />
                  <span className={cn("truncate", loading && "opacity-50")}>{value}</span>
                </div>
                <ChevronDown className={cn("w-4 h-4 text-slate-400 transition-transform", isOpen && "rotate-180")} />
            </button>
            {isOpen && (
                <div className="absolute top-full right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-xl max-h-80 overflow-y-auto z-50 p-1 animate-in fade-in zoom-in-95 duration-200">
                    {options.map(opt => {
                        const exists = patchesStatus?.[opt] ?? false;
                        const isCurrent = opt === value;
                        const isNew = newPatches?.has(opt) ?? false;
                        return (
                            <div 
                                key={opt} 
                                onClick={() => { onChange(opt); setIsOpen(false); }}
                                className={cn("px-3 py-2 rounded-lg text-sm font-medium cursor-pointer flex items-center justify-between transition-colors", isCurrent ? "bg-blue-50 text-blue-600" : "hover:bg-slate-50 text-slate-700")}
                            >
                                <div className="flex items-center gap-2">
                                    {isCurrent ? (
                                        <Circle className="w-3 h-3 text-green-500 fill-green-500" />
                                    ) : exists ? (
                                        <Check className="w-3 h-3 text-green-500" />
                                    ) : (
                                        <X className="w-3 h-3 text-red-500" />
                                    )}
                                    <span>Patch {opt}</span>
                                    {isNew && (
                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700">
                                            NEW
                                        </span>
                                    )}
                                </div>
                                {isCurrent && <Check className="w-3 h-3" />}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ... LogsView, ChampionHistoryView, PatchReleaseView, MetaChangesView, PredictionsView, etc. same as before ...
// Need to include them to be valid. I will use shortened versions if unchanged logic, but full if needed.
// Actually, I'll just output the full file content for safety.

function LogsView({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
       <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-slate-900">Системные Логи</h2>
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
    </div>
  );
}

function TierListView() {
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
          const styleKey = treeRu.key || "";
          (treeRu.slots || []).forEach((slot: any, slotIndex: number) => {
            (slot.runes || []).forEach((runeRu: any, runeIndex: number) => {
              const runeEn = (((treeEn.slots || [])[slotIndex] || {}).runes || [])[runeIndex] || {};
              const runeId = runeRu.id || `${treeIndex}-${slotIndex}-${runeIndex}`;
              runes.push({
                id: runeId,
                name: runeRu.name as string,
                nameEn: (runeEn.name as string) || (runeRu.name as string),
                icon_url: `https://ddragon.leagueoflegends.com/cdn/img/${runeRu.icon}`,
                key: runeRu.key || "",
                style: styleKey,
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

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Тир-лист (20 патчей)</h2>
        <div className="inline-flex rounded-xl border border-slate-200 bg-white dark:bg-slate-900 p-0.5 text-xs font-semibold">
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
                  ? "bg-white text-blue-600 shadow-sm"
                  : "text-slate-500 hover:text-slate-900",
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
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-sm overflow-hidden">
          <div className="grid grid-cols-12 text-xs font-semibold text-slate-500 dark:text-slate-300 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-4 py-2">
            <div className="col-span-5">Сущность</div>
            <div className="col-span-2 text-center text-emerald-700">↑ Buff</div>
            <div className="col-span-2 text-center text-red-700">↓ Nerf</div>
            <div className="col-span-2 text-center text-slate-600">⇄ Изм.</div>
            <div className="col-span-1 text-center text-slate-500">Score</div>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((entry, idx) => {
              const { icon, name } = resolveIconAndName(entry);
              const score = entry.buffs - entry.nerfs;
              return (
                <button
                  key={entry.name + entry.category + idx}
                  onClick={() => handleOpenHistory(entry)}
                  className="w-full grid grid-cols-12 items-center px-4 py-2 text-sm hover:bg-blue-50/60 dark:hover:bg-slate-800/80 transition-colors bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50"
                >
                  <div className="col-span-5 flex items-center gap-3">
                    <span className="w-6 text-[11px] text-slate-400 font-mono">#{idx + 1}</span>
                    {icon && (
                      <img
                        src={cleanUrl(icon)}
                        className="w-8 h-8 rounded-full border border-slate-200 bg-slate-100 object-cover"
                        alt=""
                      />
                    )}
                    {!icon && (
                      <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-[10px] font-bold text-slate-400 border border-slate-200">
                        {name.slice(0, 2)}
                      </div>
                    )}
                    <span className="font-semibold text-slate-800 dark:text-slate-50">{name}</span>
                    <span className="ml-2 text-[11px] text-slate-400">
                      {entry.category === "Champions" ? "Чемпион" : entry.category === "Runes" ? "Руна" : entry.category === "Items" ? "Предмет" : "Руна/Предмет"}
                    </span>
                  </div>
                  <div className="col-span-2 text-center text-emerald-700 font-semibold text-xs">
                    {entry.buffs}
                  </div>
                  <div className="col-span-2 text-center text-red-700 font-semibold text-xs">
                    {entry.nerfs}
                  </div>
                  <div className="col-span-2 text-center text-slate-600 font-semibold text-xs">
                    {entry.adjusted}
                  </div>
                  <div className="col-span-1 text-center text-xs font-mono font-semibold" style={{ color: score > 0 ? '#059669' : score < 0 ? '#dc2626' : '#64748b' }}>
                    {score > 0 ? `+${score}` : score < 0 ? score : "0"}
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
          const styleKey = treeRu.key || "";
          (treeRu.slots || []).forEach((slot: any, slotIndex: number) => {
            (slot.runes || []).forEach((runeRu: any, runeIndex: number) => {
              const runeEn = (((treeEn.slots || [])[slotIndex] || {}).runes || [])[runeIndex] || {};
              const runeId = runeRu.id || `${treeIndex}-${slotIndex}-${runeIndex}`;
              runes.push({
                id: runeId,
                name: runeRu.name as string,
                nameEn: (runeEn.name as string) || (runeRu.name as string),
                icon_url: `https://ddragon.leagueoflegends.com/cdn/img/${runeRu.icon}`,
                key: runeRu.key || "",
                style: styleKey,
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
                  const key = d.title || "Основные показатели"; // Default key if null
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
  }, [history]);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50">История изменений</h2>
           <div className="inline-flex rounded-xl border border-slate-200 bg-white dark:bg-slate-900 p-0.5 text-xs font-semibold">
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
                     ? "bg-white text-blue-600 shadow-sm"
                     : "text-slate-500 hover:text-slate-900"
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
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-4 opacity-10"><History className="w-24 h-24 text-slate-300" /></div>
              <div className="flex items-center gap-4 mb-6 relative z-10">
                   {entityType === "champion" && champion && (
                     <img
                       src={cleanUrl(champion.icon_url)}
                       className="w-16 h-16 rounded-full border-4 border-white shadow-md bg-white object-cover"
                     />
                   )}
                   {entityType !== "champion" && (() => {
                     return iconUrl ? (
                       <img
                         src={cleanUrl(iconUrl)}
                         className="w-16 h-16 rounded-full border-4 border-white shadow-md bg-white object-cover"
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
                   <div>
                       <h3 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
                         {entityType === "champion" && champion && champion.name}
                         {entityType === "rune" && selectedRune && selectedRune.name}
                         {entityType === "item" && selectedItem && selectedItem.name}
                       </h3>
                       <div className="text-xs text-slate-900 dark:text-slate-50 font-bold uppercase tracking-wider bg-white dark:bg-slate-900 px-2 py-1 rounded-md inline-block mt-1 border border-slate-100 dark:border-slate-700">
                         Общая сводка (20 патчей)
                       </div>
                   </div>
              </div>
              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm relative z-10 space-y-4 text-slate-900 dark:text-slate-50">
                  {aggregatedGroups.map((group, i) => (
                      <div key={i}>
                          {group.title && (
                              <div className="flex items-center gap-2 mb-2 border-b border-slate-100 pb-1">
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
                                      <img src={cleanUrl(icon)} className="w-6 h-6 rounded bg-slate-100" alt="" />
                                    ) : null;
                                  })()}
                                  <h4 className="font-bold text-slate-900 dark:text-slate-50">{group.title}</h4>
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
                                      .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold">$1</span>')
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
          <div className="p-12 text-center border-2 border-dashed border-slate-200 rounded-xl text-slate-500 bg-white dark:bg-slate-900">
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
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 shadow-sm hover:shadow-md transition-all hover:border-blue-200 dark:hover:border-slate-500 group-hover:translate-x-1 duration-300 text-slate-900 dark:text-slate-50">
              <div className="flex items-start justify-between mb-5 pb-4 border-b border-slate-100">
                       <div>
                            <h3 className="text-xl font-bold text-slate-900 dark:text-slate-50">{item.change.title}</h3>
                            {item.change.summary && (
                              <p className="text-sm text-slate-600 dark:text-slate-200 mt-2 italic leading-relaxed bg-white dark:bg-slate-800 p-3 rounded-lg border border-slate-100 dark:border-slate-600">
                                "{item.change.summary}"
                              </p>
                            )}
                       </div>
                       <Badge type={item.change.change_type} />
                   </div>
                   <div className="space-y-6">
                      {Array.isArray(item.change.details) && item.change.details.map((block, i) => (
                         <div key={i} className="animate-in fade-in duration-500 delay-75">
                             {block.title && (
                                 <div className="flex items-center gap-3 mb-3">
                                     {block.icon_url && <img src={cleanUrl(block.icon_url)} className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-200 shadow-sm" />}
                                     <h4 className="font-bold text-sm border-b-2 border-transparent hover:border-blue-500 transition-colors pb-0.5 text-slate-900 dark:text-slate-50">
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
                                       "text-sm bg-white dark:bg-slate-800 p-3 rounded-lg border border-slate-100 dark:border-slate-600 hover:bg-blue-50/50 dark:hover:bg-slate-700 transition-colors text-slate-900 dark:text-slate-50",
                                       isNew && "bg-emerald-50 text-emerald-900",
                                       isRemoved && "bg-red-50 text-red-900",
                                     );
                                     return (
                                       <li key={j} className={liClasses}>
                                          <span
                                            dangerouslySetInnerHTML={{
                                              __html: highlightSpecialTags(
                                                change
                                                  .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold">$1</span>')
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

function PatchReleaseView({ data, version, patchesList, onVersionChange, loading, patchesStatus, newPatches }: { data: PatchData | null, version: string, patchesList: string[], onVersionChange: (v: string) => void, loading: boolean, patchesStatus?: Record<string, boolean>, newPatches?: Set<string> }) {
  if (!data) return <EmptyState />;
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-baseline justify-between border-b border-slate-100 pb-4">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 flex items-center gap-3">Патч {data.version}</h2>
        <div className="flex items-center gap-3">
          <span className="text-slate-500 text-xs font-medium bg-slate-100 px-3 py-1 rounded-full">Riot Games Official</span>
          <CustomPatchSelect 
            value={version} 
            options={patchesList} 
            onChange={onVersionChange} 
            loading={loading}
            patchesStatus={patchesStatus}
            newPatches={newPatches}
          />
        </div>
      </div>
      <div className="grid gap-4">
        {data.patch_notes.length === 0 ? (
          <div className="p-12 text-center border-2 border-dashed border-slate-200 rounded-xl bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-200">
            Патч-ноты не найдены.
          </div>
        ) : (
          data.patch_notes.map((note) => (
            <div
              key={note.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow group text-slate-900 dark:text-slate-50"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex gap-4">
                  <ChampionIcon url={cleanUrl(note.image_url)} name={note.title} />
                  <div>
                    <h3 className="text-xl font-bold text-slate-900 dark:text-slate-50">{note.title}</h3>
                    {note.summary && (
                      <p className="text-sm text-slate-600 dark:text-slate-200 italic mt-1 border-l-2 border-slate-200 dark:border-slate-600 pl-2 max-w-2xl">
                        {note.summary}
                      </p>
                    )}
                  </div>
                </div>
                <Badge type={note.change_type} />
              </div>
              <div className="space-y-4 pl-4 border-l-2 border-slate-100 ml-6">
                  {Array.isArray(note.details) && note.details.map((block, i) => (
                      <div key={i}>
                          {block.title && (
                             <div className="flex items-center gap-2 mb-2">
                                 {block.icon_url && <img src={cleanUrl(block.icon_url)} className="w-6 h-6 rounded bg-slate-100" />}
                                 <h4 className="font-bold text-sm text-slate-900 dark:text-slate-50">{block.title}</h4>
                             </div>
                          )}
                          <ul className="space-y-2">
                            {Array.isArray(block.changes) && block.changes.map((change, j) => {
                                const lower = change.toLowerCase();
                                const isNew = lower.includes("новое") || lower.includes("new");
                                const isRemoved = lower.includes("удалено") || lower.includes("removed");
                                const liClasses = cn(
                                  "text-sm leading-relaxed rounded-md px-2 py-1",
                                  "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50",
                                  isNew && "bg-emerald-50 text-emerald-900",
                                  isRemoved && "bg-red-50 text-red-900",
                                );
                                return (
                                  <li key={j} className={liClasses}>
                                      <span
                                        dangerouslySetInnerHTML={{
                                          __html: highlightSpecialTags(
                                            change
                                              .replace(/(\d+(\.\d+)?)/g, '<span class="font-bold">$1</span>')
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
            <div className="flex items-center gap-3 w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 shadow-sm cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-all group" onClick={() => setIsOpen(!isOpen)}>
                <Search className="w-4 h-4 text-slate-400 dark:text-slate-400 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors" />
                {selected ? (
                    <div className="flex items-center gap-3 flex-1">
                        <img src={selected.icon_url} className="w-6 h-6 rounded-full border border-slate-100 dark:border-slate-700" />
                        <span className="font-bold text-slate-700 dark:text-slate-50">{selected.name}</span>
                    </div>
                ) : (
                    <input type="text" placeholder="Выберите чемпиона..." className="flex-1 bg-transparent outline-none text-sm cursor-pointer text-slate-900 dark:text-slate-50 placeholder:text-slate-400 dark:placeholder:text-slate-500" value={query} onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }} onClick={(e) => e.stopPropagation()} />
                )}
                <ChevronDown className={cn("w-4 h-4 text-slate-400 dark:text-slate-400 transition-transform", isOpen && "rotate-180")} />
            </div>
            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-80 overflow-y-auto z-50 p-1 animate-in slide-in-from-top-2 duration-200">
                    <input type="text" placeholder="Поиск..." className="w-full px-3 py-2 border-b border-slate-100 dark:border-slate-700 outline-none text-sm mb-1 sticky top-0 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 dark:placeholder:text-slate-500" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
                    {filtered.length === 0 ? <div className="p-4 text-center text-xs text-slate-400 dark:text-slate-500">Нет совпадений</div> : filtered.map((item, idx) => (
                        <div key={`${item.name}-${item.name_en}-${idx}`} onClick={() => { onSelect(item); setIsOpen(false); setQuery(""); }} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800 cursor-pointer transition-colors">
                            <img src={cleanUrl(item.icon_url)} className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800" loading="lazy" />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-slate-700 dark:text-slate-50">{item.name}</span>
                              {item.name_en !== item.name && (
                                <span className="text-[11px] text-slate-400 dark:text-slate-400">{item.name_en}</span>
                              )}
                            </div>
                            {selected?.name === item.name && <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 ml-auto" />}
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
            <div className="flex items-center gap-3 w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 shadow-sm cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-all group" onClick={() => setIsOpen(!isOpen)}>
                <Search className="w-4 h-4 text-slate-400 dark:text-slate-400 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors" />
                {selected ? (
                    <div className="flex items-center gap-3 flex-1">
                        <img 
                            src={cleanUrl(selected.icon_url)} 
                            className="w-6 h-6 rounded-full border border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 object-cover flex-shrink-0" 
                            alt={selected.name}
                            onError={(e) => {
                                // Fallback на архивную иконку при ошибке
                                if (selected.key && selected.style) {
                                    invoke<string | null>("get_fallback_rune_icon", { 
                                        styleKey: selected.style, 
                                        runeKey: selected.key 
                                    }).then(fallback => {
                                        if (fallback && e.currentTarget) {
                                            const cleaned = cleanUrl(fallback);
                                            if (cleaned) {
                                                e.currentTarget.src = cleaned;
                                            }
                                        }
                                    }).catch(() => {});
                                }
                            }}
                        />
                        <span className="font-bold text-slate-700 dark:text-slate-50">{selected.name}</span>
                    </div>
                ) : (
                    <input
                      type="text"
                      placeholder="Выберите руну..."
                      className="flex-1 bg-transparent outline-none text-sm cursor-pointer text-slate-900 dark:text-slate-50 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      value={query}
                      onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                )}
                <ChevronDown className={cn("w-4 h-4 text-slate-400 dark:text-slate-400 transition-transform", isOpen && "rotate-180")} />
            </div>
            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-80 overflow-y-auto z-50 p-1 animate-in slide-in-from-top-2 duration-200">
                    <input
                      type="text"
                      placeholder="Поиск (ru/en)..."
                      className="w-full px-3 py-2 border-b border-slate-100 dark:border-slate-700 outline-none text-sm mb-1 sticky top-0 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      autoFocus
                    />
                    {filtered.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-400 dark:text-slate-500">Нет совпадений</div>
                    ) : (
                      filtered.map(item => (
                        <div
                          key={item.id}
                          onClick={() => { onSelect(item); setIsOpen(false); setQuery(""); }}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800 cursor-pointer transition-colors"
                        >
                            {/* Скругленная мини-иконка */}
                            <img 
                              src={cleanUrl(item.icon_url)} 
                              className="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 object-cover flex-shrink-0" 
                              alt={item.name}
                              loading="lazy"
                              onError={(e) => {
                                // Fallback на архивную иконку при ошибке
                                if (item.key && item.style) {
                                    invoke<string | null>("get_fallback_rune_icon", { 
                                        styleKey: item.style, 
                                        runeKey: item.key 
                                    }).then(fallback => {
                                        if (fallback && e.currentTarget) {
                                            const cleaned = cleanUrl(fallback);
                                            if (cleaned) {
                                                e.currentTarget.src = cleaned;
                                            }
                                        }
                                    }).catch(() => {});
                                }
                              }}
                            />
                            <div className="flex flex-col flex-1 min-w-0">
                              <span className="text-sm font-medium text-slate-700 dark:text-slate-50">{item.name}</span>
                              {item.nameEn !== item.name && (
                                <span className="text-[11px] text-slate-400 dark:text-slate-400">{item.nameEn}</span>
                              )}
                            </div>
                            {selected?.name === item.name && <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 ml-auto flex-shrink-0" />}
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
            <div className="flex items-center gap-3 w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 shadow-sm cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-all group" onClick={() => setIsOpen(!isOpen)}>
                <Search className="w-4 h-4 text-slate-400 dark:text-slate-400 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors" />
                {selected ? (
                    <div className="flex items-center gap-3 flex-1">
                        <img src={cleanUrl(selected.icon_url)} className="w-6 h-6 rounded-full border border-slate-100 dark:border-slate-700" />
                        <span className="font-bold text-slate-700 dark:text-slate-50">{selected.name}</span>
                    </div>
                ) : (
                    <input
                      type="text"
                      placeholder="Выберите предмет..."
                      className="flex-1 bg-transparent outline-none text-sm cursor-pointer text-slate-900 dark:text-slate-50 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      value={query}
                      onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                )}
                <ChevronDown className={cn("w-4 h-4 text-slate-400 dark:text-slate-400 transition-transform", isOpen && "rotate-180")} />
            </div>
            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-80 overflow-y-auto z-50 p-1 animate-in slide-in-from-top-2 duration-200">
                    <input
                      type="text"
                      placeholder="Поиск (ru/en)..."
                      className="w-full px-3 py-2 border-b border-slate-100 dark:border-slate-700 outline-none text-sm mb-1 sticky top-0 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      autoFocus
                    />
                    {filtered.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-400 dark:text-slate-500">Нет совпадений</div>
                    ) : (
                      filtered.map(item => (
                        <div
                          key={item.id}
                          onClick={() => { onSelect(item); setIsOpen(false); setQuery(""); }}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800 cursor-pointer transition-colors"
                        >
                            <img src={cleanUrl(item.icon_url)} className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800" loading="lazy" />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-slate-700 dark:text-slate-50">{item.name}</span>
                              {item.nameEn !== item.name && (
                                <span className="text-[11px] text-slate-400 dark:text-slate-400">{item.nameEn}</span>
                              )}
                            </div>
                            {selected?.name === item.name && <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 ml-auto" />}
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
  const [apiData, setApiData] = useState<MetaAnalysisDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [useApi, setUseApi] = useState(false);
  const location = useLocation();
  
  useEffect(() => {
    const loadApiData = async () => {
      setLoading(true);
      try {
        const patchesList = await invoke<string[]>("get_available_patches");
        console.log("[MetaChangesView] Available patches:", patchesList);
        if (patchesList.length >= 2) {
          const currentPatch = patchesList[0];
          const previousPatch = patchesList[1];
          console.log("[MetaChangesView] Comparing:", { from: previousPatch, to: currentPatch });
          
          const metaChanges = await invoke<Array<{
            champion_id: string;
            win_rate_diff: number;
            pick_rate_diff: number;
            ban_rate_diff: number;
          }>>("get_meta_changes_from_api", {
            fromPatch: previousPatch,
            toPatch: currentPatch,
            region: "ru",
            tier: null
          });
          
          console.log("[MetaChangesView] Meta changes received:", metaChanges);
          console.log("[MetaChangesView] First change sample:", metaChanges[0]);
          
          if (metaChanges && metaChanges.length > 0) {
            const champions = await invoke<ChampionListItem[]>("get_all_champions");
            const championMap = new Map(champions.map(c => [c.name_en.toLowerCase(), c]));
            
            const transformed = metaChanges.map(change => {
              const champion = championMap.get(change.champion_id.toLowerCase());
              return {
                champion_name: champion?.name || change.champion_id,
                role: "ALL",
                win_rate_diff: change.win_rate_diff,
                pick_rate_diff: change.pick_rate_diff,
                predicted_change: null,
                champion_image_url: champion?.icon_url
              } as MetaAnalysisDiff;
            });
            
            setApiData(transformed);
            setUseApi(true);
          }
        }
      } catch (error: any) {
        console.error("Failed to load API data:", error);
        setUseApi(false);
      } finally {
        setLoading(false);
      }
    };
    
    loadApiData();
  }, [location.pathname]);
  
  const displayData = useApi ? apiData : diffs;
  
  if (loading) {
    return <EmptyState message="Загрузка данных статистики..." />;
  }
  
  if (displayData.length === 0) return <EmptyState message="Нет данных статистики." />;
  
  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Сдвиги Меты</h2>
      <div className="grid gap-3">
        {displayData.map((diff, idx) => (
          <div
            key={idx}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 flex items-center justify-between shadow-sm hover:border-blue-200 dark:hover:border-slate-500 transition-colors text-slate-900 dark:text-slate-50"
          >
            <div className="flex items-center gap-4">
               <ChampionIcon url={cleanUrl(diff.champion_image_url)} name={diff.champion_name} />
               <div>
                 <div className="font-bold text-slate-900 dark:text-slate-50">{diff.champion_name}</div>
                 <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold">{diff.role}</div>
               </div>
            </div>
            <div className="flex gap-8 text-right items-center">
                <div className={cn("px-2 py-1 rounded text-xs font-bold flex items-center gap-1", diff.win_rate_diff > 0 ? "bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400" : "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400")}>
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
  const [apiData, setApiData] = useState<MetaAnalysisDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [useApi, setUseApi] = useState(false);
  const location = useLocation();
  
  useEffect(() => {
    const loadApiData = async () => {
      setLoading(true);
      try {
        const patchesList = await invoke<string[]>("get_available_patches");
        console.log("[PredictionsView] Available patches:", patchesList);
        if (patchesList.length >= 2) {
          const currentPatch = patchesList[0];
          const previousPatch = patchesList[1];
          console.log("[PredictionsView] Comparing:", { from: previousPatch, to: currentPatch });
          
          const metaChanges = await invoke<Array<{
            champion_id: string;
            win_rate_diff: number;
            pick_rate_diff: number;
            ban_rate_diff: number;
          }>>("get_meta_changes_from_api", {
            fromPatch: previousPatch,
            toPatch: currentPatch,
            region: "ru",
            tier: null
          });
          
          console.log("[PredictionsView] Meta changes received:", metaChanges);
          console.log("[PredictionsView] First change sample:", metaChanges[0]);
          
          if (metaChanges && metaChanges.length > 0) {
            const champions = await invoke<ChampionListItem[]>("get_all_champions");
            // Создаем маппинг: champion_id (числовой key) -> champion data
            const championMapByKey = new Map(champions.map(c => [c.key, c]));
            // Также маппинг по строковому ID (на случай если champion_id уже строковый)
            const championMapById = new Map(champions.map(c => [c.id.toLowerCase(), c]));
            
            const transformed = metaChanges.map(change => {
              // Пробуем найти по числовому key или строковому id
              const champion = championMapByKey.get(change.champion_id) || 
                              championMapById.get(change.champion_id.toLowerCase());
              return {
                champion_name: champion?.name || change.champion_id,
                role: "ALL",
                win_rate_diff: change.win_rate_diff,
                pick_rate_diff: change.pick_rate_diff,
                predicted_change: null,
                champion_image_url: champion?.icon_url
              } as MetaAnalysisDiff;
            });
            
            setApiData(transformed);
            setUseApi(true);
          }
        }
      } catch (error: any) {
        console.error("Failed to load API data:", error);
        setUseApi(false);
      } finally {
        setLoading(false);
      }
    };
    
    loadApiData();
  }, [location.pathname]);
  
  const displayData = useApi ? apiData : diffs;
  const predicted = displayData.filter(d => d.predicted_change);
  
  if (loading) {
    return <EmptyState message="Загрузка данных статистики..." />;
  }
  
  if (predicted.length === 0) return <EmptyState message="Нет прогнозов." />;
  
  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Прогноз vs Реальность</h2>
      <div className="grid md:grid-cols-2 gap-4">
        {predicted.map((item, idx) => (
          <div key={idx} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-5 rounded-xl shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
             <div className={cn("absolute top-0 right-0 px-3 py-1 text-xs font-bold rounded-bl-lg border-l border-b border-slate-100 dark:border-slate-700", item.predicted_change === "Buff" ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400" : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400")}>
               {item.predicted_change?.toUpperCase()}
             </div>
             <div className="flex items-center gap-3 mb-3">
                <ChampionIcon url={cleanUrl(item.champion_image_url)} name={item.champion_name} />
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-50">{item.champion_name}</h3>
             </div>
             <div className="text-sm text-slate-500 dark:text-slate-400 mb-4">{item.predicted_change === "Buff" ? "Ожидалось усиление" : "Ожидалось ослабление"}</div>
             <div className="flex items-center justify-between text-sm bg-white dark:bg-slate-800 p-3 rounded border border-slate-100 dark:border-slate-700">
                <span className="text-slate-500 dark:text-slate-400 font-medium">Результат (Win Rate):</span>
                <div className="flex items-center gap-2">
                    {item.win_rate_diff !== 0 && (<span className={cn("font-bold", item.win_rate_diff > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>{item.win_rate_diff > 0 ? "+" : ""}{item.win_rate_diff}%</span>)}
                    {item.win_rate_diff === 0 && <span className="text-slate-400 dark:text-slate-500 font-bold">Нет данных</span>}
                </div>
             </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ message = "Выберите патч и нажмите Обновить" }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl bg-white dark:bg-slate-900">
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
      <div className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 font-bold mb-0.5">{label}</div>
      <div className={cn("font-mono font-bold", val > 0 ? "text-green-600 dark:text-green-400" : val < 0 ? "text-red-600 dark:text-red-400" : "text-slate-400 dark:text-slate-500")}>{val > 0 ? "+" : ""}{val}%</div>
    </div>
  );
}

export default App;
