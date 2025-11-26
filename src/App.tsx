import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Routes, Route, Link, useLocation } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { ArrowUp, ArrowDown, BookOpen, LineChart, TrendingUp } from "lucide-react";
import { cn } from "./lib/utils";

// Типы (дублируют Rust модели)
interface PatchData {
  version: string;
  patch_notes: PatchNoteEntry[];
}

interface PatchNoteEntry {
  champion_name: string;
  summary: string;
  details: string[];
  change_type: "Buff" | "Nerf" | "Adjusted" | "New";
}

interface MetaAnalysisDiff {
  champion_name: string;
  role: string;
  win_rate_diff: number;
  pick_rate_diff: number;
  predicted_change: "Buff" | "Nerf" | "Adjusted" | "New" | null;
}

function App() {
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState("25.23"); // Текущая версия
  const [patchData, setPatchData] = useState<PatchData | null>(null);
  const [diffs, setDiffs] = useState<MetaAnalysisDiff[]>([]);

  const location = useLocation();

  // Загружаем последний сохраненный патч при старте
  useEffect(() => {
    invoke<PatchData | null>("get_latest_patch_data").then(data => {
      if (data) setPatchData(data);
    });
  }, []);

  async function handleAnalyze() {
    if (!version) return;
    setLoading(true);
    try {
      const result = await invoke<MetaAnalysisDiff[]>("analyze_patch", { version });
      setDiffs(result);
      
      // Обновляем данные патча
      const latest = await invoke<PatchData | null>("get_latest_patch_data");
      if (latest) setPatchData(latest);
      
      toast("Анализ завершен", {
        description: `Патч ${version} успешно обработан`,
        icon: <img src="/ok.png" className="w-5 h-5" alt="Success" />,
        className: "bg-green-950 border-green-900 text-green-100"
      });
    } catch (error) {
      console.error(error);
      toast("Ошибка анализа", {
        description: String(error),
        icon: <img src="/error.png" className="w-5 h-5" alt="Error" />,
        className: "bg-red-950 border-red-900 text-red-100"
      });
    } finally {
      setLoading(false);
    }
  }

  const navItems = [
    { path: "/", label: "Патч Ноут", icon: BookOpen },
    { path: "/meta", label: "Изменения Меты", icon: LineChart },
    { path: "/predictions", label: "Прогнозы", icon: TrendingUp },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Toaster position="top-right" theme="dark" />
      
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/50 backdrop-blur p-4 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-6">
             <div className="flex items-center gap-3">
                <img src="/logo.png" alt="LoL Analyzer" className="w-10 h-10 rounded-lg shadow-lg shadow-blue-900/20" />
                <div>
                  <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent leading-none">
                    LoL Analyzer
                  </h1>
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Patch {version}</span>
                </div>
             </div>
             
            <nav className="flex gap-1 bg-slate-900/50 p-1 rounded-lg border border-slate-800 ml-4">
              {navItems.map(({ path, label, icon: Icon }) => (
                <Link
                  key={path}
                  to={path}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-all",
                    location.pathname === path 
                      ? "bg-blue-600 text-white shadow-md" 
                      : "text-slate-400 hover:text-white hover:bg-slate-800"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex gap-2 items-center">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs font-bold">v</span>
              <input 
                type="text" 
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="15.23"
                className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 pl-6 text-sm w-24 text-center focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>
            <button
              onClick={handleAnalyze}
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded text-sm flex items-center gap-2 disabled:opacity-50 transition-all shadow-lg shadow-blue-900/20 active:scale-95"
            >
              {loading ? (
                <img src="/loading.png" className="w-4 h-4 animate-spin" alt="Loading" />
              ) : (
                <img src="/logo.png" className="w-4 h-4 grayscale opacity-50" alt="Update" />
              )}
              {loading ? "Обработка..." : "Обновить"}
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-6">
        <Routes>
          <Route path="/" element={<PatchReleaseView data={patchData} />} />
          <Route path="/meta" element={<MetaChangesView diffs={diffs} />} />
          <Route path="/predictions" element={<PredictionsView diffs={diffs} />} />
        </Routes>
      </main>
    </div>
  );
}

// Страница 1: Описание патча (Пункт 6.1)
function PatchReleaseView({ data }: { data: PatchData | null }) {
  if (!data) return <EmptyState />;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-baseline justify-between">
        <h2 className="text-3xl font-bold flex items-center gap-3">
          <img src="/logo.png" className="w-8 h-8" alt="" />
          Патч {data.version}
        </h2>
        <span className="text-slate-500 text-sm border border-slate-800 px-3 py-1 rounded-full">
           Источник: Riot Games & OP.GG
        </span>
      </div>
      
      <div className="grid gap-4">
        {data.patch_notes.length === 0 ? (
          <div className="p-12 text-center border border-dashed border-slate-800 rounded-xl bg-slate-900/20 text-slate-500">
            <img src="/error.png" className="w-12 h-12 mx-auto mb-4 opacity-20 grayscale" alt="No Data" />
            <p>Патч-ноты не найдены.</p>
            <p className="text-sm mt-2">Возможно, страница обновления еще не опубликована или изменилась структура.</p>
          </div>
        ) : (
          data.patch_notes.map((note, idx) => (
            <div key={idx} className="bg-slate-900/40 border border-slate-800 rounded-xl p-6 hover:border-slate-700 transition-colors group">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  {/* Placeholder for champion icon if we had one */}
                  <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center text-lg font-bold text-slate-600 group-hover:text-slate-400 transition-colors">
                    {note.champion_name[0]}
                  </div>
                  <h3 className="text-xl font-bold text-slate-200">{note.champion_name}</h3>
                </div>
                <Badge type={note.change_type} />
              </div>
              <ul className="space-y-2 ml-13 pl-13">
                {note.details.map((detail, i) => (
                  <li key={i} className="text-slate-400 text-sm flex items-start gap-2.5">
                    <span className="mt-2 w-1 h-1 rounded-full bg-slate-600 shrink-0" />
                    <span dangerouslySetInnerHTML={{ 
                      __html: detail.replace(/(\d+(\.\d+)?)/g, '<span class="text-slate-200 font-mono">$1</span>') 
                    }} />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Страница 2: Изменения меты (Пункт 6.2)
function MetaChangesView({ diffs }: { diffs: MetaAnalysisDiff[] }) {
  if (diffs.length === 0) return <EmptyState message="Нет данных для анализа. Нажмите 'Обновить'." />;

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <h2 className="text-2xl font-bold flex items-center gap-2">
        <LineChart className="w-6 h-6 text-blue-500" />
        Сдвиги Меты
      </h2>
      <div className="grid gap-3">
        {diffs.map((diff, idx) => (
          <div key={idx} className="bg-slate-900/50 border border-slate-800 rounded-lg p-4 flex items-center justify-between hover:bg-slate-900/80 transition-all">
            <div className="flex items-center gap-4">
               <div className={cn(
                 "w-10 h-10 rounded-lg flex items-center justify-center font-bold text-lg shadow-inner",
                 diff.win_rate_diff > 0 ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"
               )}>
                 {diff.win_rate_diff > 0 ? <ArrowUp className="w-5 h-5" /> : <ArrowDown className="w-5 h-5" />}
               </div>
               <div>
                 <div className="font-bold text-lg">{diff.champion_name}</div>
                 <div className="text-xs text-slate-500 uppercase font-semibold tracking-wider bg-slate-800/50 px-1.5 py-0.5 rounded inline-block">
                    {diff.role}
                 </div>
               </div>
            </div>
            
            <div className="flex gap-8 text-right">
               <Stat val={diff.win_rate_diff} label="Win Rate" />
               <Stat val={diff.pick_rate_diff} label="Pick Rate" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Страница 3: Прогнозы (Пункт 6.3)
function PredictionsView({ diffs }: { diffs: MetaAnalysisDiff[] }) {
  if (diffs.length === 0) return <EmptyState />;

  // Фильтруем только тех, у кого были изменения в патче
  const predicted = diffs.filter(d => d.predicted_change);

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500 delay-100">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-purple-500" />
          Прогноз Влияния Патча
        </h2>
        <p className="text-slate-400 mt-1">Сравнение ожиданий (Riot Patch Notes) vs Реальность (OP.GG Stats)</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {predicted.map((item, idx) => {
          const isAccurate = (item.predicted_change === "Buff" && item.win_rate_diff > 0) ||
                             (item.predicted_change === "Nerf" && item.win_rate_diff < 0);
          
          return (
            <div key={idx} className="bg-slate-900/30 border border-slate-800 p-5 rounded-xl relative overflow-hidden group hover:border-slate-700 transition-all">
               <div className={cn(
                 "absolute top-0 right-0 px-3 py-1 text-xs font-bold rounded-bl-lg border-l border-b",
                 item.predicted_change === "Buff" ? "bg-green-500/20 text-green-400 border-green-500/20" : "bg-red-500/20 text-red-400 border-red-500/20"
               )}>
                 ОЖИДАНИЕ: {item.predicted_change?.toUpperCase()}
               </div>
               
               <h3 className="text-xl font-bold mb-1 flex items-center gap-2">
                 {item.champion_name}
                 {isAccurate && <img src="/ok.png" className="w-4 h-4 opacity-70" title="Прогноз сбылся" />}
               </h3>
               <div className="text-sm text-slate-500 mb-4">
                 {item.predicted_change === "Buff" ? "Должен стать сильнее" : "Должен стать слабее"}
               </div>
               
               <div className="flex items-center gap-3 text-sm bg-slate-950/50 p-3 rounded border border-slate-800/50">
                  <span className="text-slate-400 font-medium">Реальность:</span>
                  <span className={cn(
                    "font-mono font-bold flex items-center gap-1 text-base",
                    item.win_rate_diff > 0 ? "text-green-400" : "text-red-400"
                  )}>
                    {item.win_rate_diff > 0 ? "+" : ""}{item.win_rate_diff}% Winrate
                  </span>
               </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ message = "Начните анализ патча сверху." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-slate-500 border border-dashed border-slate-800 rounded-xl bg-slate-900/10">
      <img src="/logo.png" className="w-16 h-16 mb-4 opacity-10 grayscale" alt="" />
      <p className="font-medium">{message}</p>
    </div>
  );
}

function Badge({ type }: { type: string }) {
  const styles = {
    Buff: "bg-green-500/10 text-green-400 border-green-500/20",
    Nerf: "bg-red-500/10 text-red-400 border-red-500/20",
    Adjusted: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    New: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  };
  // @ts-ignore
  const style = styles[type] || styles.Adjusted;
  
  return (
    <span className={cn("px-2.5 py-0.5 rounded text-xs font-bold border uppercase tracking-wider", style)}>
      {type}
    </span>
  );
}

function Stat({ val, label }: { val: number, label: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-0.5">{label}</div>
      <div className={cn("font-mono font-bold flex items-center justify-end gap-1 text-base", val > 0 ? "text-green-400" : val < 0 ? "text-red-400" : "text-slate-400")}>
        {val > 0 ? "+" : ""}{val}%
      </div>
    </div>
  );
}

export default App;
