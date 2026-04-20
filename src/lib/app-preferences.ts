import type { ThemeOption } from "@/types/patch";

export type PatchDefaultMode = "alwaysLatest" | "rememberSelection";
export type StartupRouteMode = "home" | "last";
export type UiDensity = "comfortable" | "compact";
export type ReducedMotionPref = "system" | "on" | "off";
export type DateFormatPref = "relative" | "absolute";

export const UI_SCALE_PRESETS = [75, 80, 90, 100, 110, 125, 150] as const;
export type UiScalePct = (typeof UI_SCALE_PRESETS)[number];

export const PREFS_STORAGE_KEY = "patch-analyzer:prefs-v1";

export type AppPreferences = {
  theme: ThemeOption;
  uiScalePct: number;
  closeToTray: boolean;
  minimizeToTray: boolean;
  autostartEnabled: boolean;
  patchDefaultMode: PatchDefaultMode;
  startupRouteMode: StartupRouteMode;
  uiDensity: UiDensity;
  reducedMotion: ReducedMotionPref;
  dateFormat: DateFormatPref;
  lastPatchVersion: string;
  lastPathname: string;
};

const DEFAULT_PREFS: AppPreferences = {
  theme: "system",
  uiScalePct: 100,
  closeToTray: false,
  minimizeToTray: false,
  autostartEnabled: false,
  patchDefaultMode: "alwaysLatest",
  startupRouteMode: "home",
  uiDensity: "comfortable",
  reducedMotion: "system",
  dateFormat: "relative",
  lastPatchVersion: "",
  lastPathname: "/",
};

function clampScale(n: number): number {
  if (UI_SCALE_PRESETS.includes(n as UiScalePct)) return n;
  return 100;
}

export function loadAppPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) {
      const legacyTheme = localStorage.getItem("theme") as ThemeOption | null;
      return {
        ...DEFAULT_PREFS,
        ...(legacyTheme ? { theme: legacyTheme } : {}),
      };
    }
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      uiScalePct: clampScale(Number(parsed.uiScalePct) || 100),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveAppPreferences(p: Partial<AppPreferences>): AppPreferences {
  const next = { ...loadAppPreferences(), ...p };
  localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
  if (next.theme) localStorage.setItem("theme", next.theme);
  window.dispatchEvent(new Event("app-prefs-changed"));
  return next;
}

export function applyDomFromPreferences(p: AppPreferences): void {
  const root = document.documentElement;
  root.setAttribute("data-density", p.uiDensity);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduce =
    p.reducedMotion === "on" || (p.reducedMotion === "system" && media.matches);
  root.classList.toggle("reduce-motion", reduce);
}

export function getEffectiveReducedMotion(p: AppPreferences): boolean {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  return p.reducedMotion === "on" || (p.reducedMotion === "system" && media.matches);
}
