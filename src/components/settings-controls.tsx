import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  loadAppPreferences,
  saveAppPreferences,
  UI_SCALE_PRESETS,
  type AppPreferences,
} from "@/lib/app-preferences";
import type { ThemeOption } from "@/types/patch";

type Props = {
  theme: ThemeOption;
  onThemeChange: (t: ThemeOption) => void;
};

export function SettingsControls({ theme, onThemeChange }: Props) {
  const { t, i18n } = useTranslation();
  const [prefs, setPrefs] = useState<AppPreferences>(() => loadAppPreferences());
  const [dbPath, setDbPath] = useState<string>("");
  const [autostartOn, setAutostartOn] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheStatusJson, setCacheStatusJson] = useState<string>("");
  const [cacheValidationJson, setCacheValidationJson] = useState<string>("");
  const [cacheWarmResult, setCacheWarmResult] = useState<string>("");
  const [cacheError, setCacheError] = useState<string>("");

  const refreshPrefs = useCallback(() => {
    setPrefs(loadAppPreferences());
  }, []);

  useEffect(() => {
    const onChange = () => refreshPrefs();
    window.addEventListener("app-prefs-changed", onChange);
    return () => window.removeEventListener("app-prefs-changed", onChange);
  }, [refreshPrefs]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<string>("get_database_path").then(setDbPath).catch(() => setDbPath(""));
    void isEnabled()
      .then(setAutostartOn)
      .catch(() => setAutostartOn(false));
  }, []);

  const patchPrefs = (partial: Partial<AppPreferences>) => {
    const next = saveAppPreferences(partial);
    setPrefs(next);
  };

  const applyZoom = useCallback(async (pct: number) => {
    if (!isTauri()) return;
    try {
      const w = getCurrentWebview();
      await w.setZoom(pct / 100);
    } catch {
      document.documentElement.style.zoom = `${pct / 100}`;
    }
  }, []);

  useEffect(() => {
    void applyZoom(prefs.uiScalePct);
  }, [prefs.uiScalePct, applyZoom]);

  const setLang = (lng: "ru" | "en") => {
    void i18n.changeLanguage(lng);
    localStorage.setItem("i18nextLng", lng);
    document.documentElement.lang = lng;
    if (isTauri()) {
      void invoke("update_tray_menu_labels", {
        show: i18n.t("tray.show"),
        quit: i18n.t("tray.quit"),
      }).catch(() => { });
    }
  };

  const toggleAutostart = async (on: boolean) => {
    if (!isTauri()) return;
    try {
      if (on) await enable();
      else await disable();
      const next = await isEnabled();
      setAutostartOn(next);
      saveAppPreferences({ autostartEnabled: next });
      setPrefs(loadAppPreferences());
    } catch {
      setAutostartOn(false);
      saveAppPreferences({ autostartEnabled: false });
      setPrefs(loadAppPreferences());
    }
  };

  const onRevealDb = async () => {
    if (!dbPath || !isTauri()) return;
    try {
      await revealItemInDir(dbPath);
    } catch {
      /* ignore */
    }
  };

  type CacheStatusPayload = {
    patch_versions: number;
    patch_locales: string[];
    static_catalog_rows: number;
    patch_asset_files: number;
    patch_asset_bytes: number;
    game_asset_files: number;
    game_asset_bytes: number;
  };

  type AssetValidationPayload = {
    checked: number;
    missing: number;
    broken_paths: string[];
  };

  const runCacheStatus = useCallback(async () => {
    if (!isTauri()) return;
    const payload = await invoke<CacheStatusPayload>("cache_status");
    setCacheStatusJson(JSON.stringify(payload, null, 2));
  }, []);

  const runAssetValidation = useCallback(async () => {
    if (!isTauri()) return;
    const payload = await invoke<AssetValidationPayload>("validate_cached_assets");
    setCacheValidationJson(JSON.stringify(payload, null, 2));
  }, []);

  const runWarmFullCache = useCallback(async () => {
    if (!isTauri()) return;
    await invoke("warm_full_cache");
    setCacheWarmResult(`ok:${new Date().toISOString()}`);
    await runCacheStatus();
    await runAssetValidation();
  }, [runAssetValidation, runCacheStatus]);

  const runClearAllCachedData = useCallback(async () => {
    if (!isTauri()) return;
    await invoke("clear_all_cached_data");
    setCacheWarmResult(`cleared:${new Date().toISOString()}`);
    await runCacheStatus();
    await runAssetValidation();
  }, [runAssetValidation, runCacheStatus]);

  const runDevDiagnostics = useCallback(async () => {
    if (!isTauri()) return;
    setCacheBusy(true);
    setCacheError("");
    try {
      await runCacheStatus();
      await runAssetValidation();
    } catch (e) {
      setCacheError(String(e));
    } finally {
      setCacheBusy(false);
    }
  }, [runAssetValidation, runCacheStatus]);

  useEffect(() => {
    if (!isTauri()) return;
    if (!import.meta.env.DEV) return;
    void runDevDiagnostics();
  }, [runDevDiagnostics]);

  return (
    <div className="space-y-6 text-sm">
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-medium">{t("settings.singleBlockTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("settings.singleBlockDescription")}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t("settings.sectionInterface")}
          </p>
          <div className="space-y-2">
            <Label>{t("settings.language")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.languageHint")}</p>
            <div className="flex flex-wrap gap-2">
              {(["ru", "en"] as const).map((lng) => (
                <Button
                  key={lng}
                  type="button"
                  size="sm"
                  variant={i18n.language === lng ? "default" : "outline"}
                  onClick={() => setLang(lng)}
                >
                  {lng === "ru" ? t("settings.langRu") : t("settings.langEn")}
                </Button>
              ))}
            </div>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>{t("settings.theme")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.themeHint")}</p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { value: "system" as ThemeOption, label: t("settings.themeSystem") },
                  { value: "light" as ThemeOption, label: t("settings.themeLight") },
                  { value: "dark" as ThemeOption, label: t("settings.themeDark") },
                ] as const
              ).map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  variant={theme === opt.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => onThemeChange(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>{t("settings.uiScale")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.uiScaleHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {UI_SCALE_PRESETS.map((pct) => (
                <Button
                  key={pct}
                  type="button"
                  size="sm"
                  variant={prefs.uiScalePct === pct ? "default" : "outline"}
                  className="min-w-12 px-2"
                  onClick={() => patchPrefs({ uiScalePct: pct })}
                >
                  {pct}%
                </Button>
              ))}
            </div>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>{t("settings.density")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.densityHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={prefs.uiDensity === "comfortable" ? "default" : "outline"}
                onClick={() => patchPrefs({ uiDensity: "comfortable" })}
              >
                {t("settings.densityComfortable")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={prefs.uiDensity === "compact" ? "default" : "outline"}
                onClick={() => patchPrefs({ uiDensity: "compact" })}
              >
                {t("settings.densityCompact")}
              </Button>
            </div>
          </div>
          <Separator />
          <p className="text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t("settings.sectionBehavior")}
          </p>
          <div className="space-y-2">
            <Label>{t("settings.patchDefault")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.patchDefaultHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={prefs.patchDefaultMode === "alwaysLatest" ? "default" : "outline"}
                onClick={() => patchPrefs({ patchDefaultMode: "alwaysLatest" })}
              >
                {t("settings.patchAlwaysLatest")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={prefs.patchDefaultMode === "rememberSelection" ? "default" : "outline"}
                onClick={() => patchPrefs({ patchDefaultMode: "rememberSelection" })}
              >
                {t("settings.patchRemember")}
              </Button>
            </div>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>{t("settings.startupRoute")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.startupRouteHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={prefs.startupRouteMode === "home" ? "default" : "outline"}
                onClick={() => patchPrefs({ startupRouteMode: "home" })}
              >
                {t("settings.startupHome")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={prefs.startupRouteMode === "last" ? "default" : "outline"}
                onClick={() => patchPrefs({ startupRouteMode: "last" })}
              >
                {t("settings.startupLast")}
              </Button>
            </div>
          </div>
          <Separator />
          <p className="text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t("settings.sectionWindow")}
          </p>
          <div className="space-y-3">
            <Label>{t("settings.closeOnXTitle")}</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button
                type="button"
                size="sm"
                variant={!prefs.closeToTray ? "default" : "outline"}
                className="justify-start sm:min-w-48"
                onClick={() => patchPrefs({ closeToTray: false })}
              >
                {t("settings.closeOnXExit")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={prefs.closeToTray ? "default" : "outline"}
                className="justify-start sm:min-w-48"
                onClick={() => patchPrefs({ closeToTray: true })}
              >
                {t("settings.closeOnXTray")}
              </Button>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{t("settings.closeOnXHint")}</p>
          </div>
          <Separator />
          <div className="space-y-3">
            <Label>{t("settings.minimizeButtonTitle")}</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button
                type="button"
                size="sm"
                variant={!prefs.minimizeToTray ? "default" : "outline"}
                className="justify-start sm:min-w-48"
                onClick={() => patchPrefs({ minimizeToTray: false })}
              >
                {t("settings.minimizeToTaskbar")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={prefs.minimizeToTray ? "default" : "outline"}
                className="justify-start sm:min-w-48"
                onClick={() => patchPrefs({ minimizeToTray: true })}
              >
                {t("settings.minimizeToTray")}
              </Button>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{t("settings.minimizeButtonHint")}</p>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>{t("settings.autostart")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.autostartHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={autostartOn ? "default" : "outline"}
                onClick={() => void toggleAutostart(!autostartOn)}
                disabled={!isTauri()}
              >
                {autostartOn ? t("settings.autostartOn") : t("settings.autostartOff")}
              </Button>
            </div>
          </div>
          <Separator />
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-fit"
            disabled={!isTauri()}
            onClick={() => void invoke("exit_app")}
          >
            {t("settings.quitApp")}
          </Button>
          <Separator />
          <p className="text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t("settings.sectionAccessibility")}
          </p>
          <div className="space-y-2">
            <Label>{t("settings.reducedMotion")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.reducedMotionHint")}</p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["system", t("settings.reducedMotionSystem")],
                  ["on", t("settings.reducedMotionOn")],
                  ["off", t("settings.reducedMotionOff")],
                ] as const
              ).map(([k, label]) => (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={prefs.reducedMotion === k ? "default" : "outline"}
                  onClick={() => patchPrefs({ reducedMotion: k })}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>{t("settings.dateFormat")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.dateFormatHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={prefs.dateFormat === "relative" ? "default" : "outline"}
                onClick={() => patchPrefs({ dateFormat: "relative" })}
              >
                {t("settings.dateRelative")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={prefs.dateFormat === "absolute" ? "default" : "outline"}
                onClick={() => patchPrefs({ dateFormat: "absolute" })}
              >
                {t("settings.dateAbsolute")}
              </Button>
            </div>
          </div>
          <Separator />
          <p className="text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t("settings.sectionData")}
          </p>
          <div className="space-y-3">
            <Label>{t("settings.dataLocation")}</Label>
            <p className="break-all rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {dbPath || "—"}
            </p>
            <p className="text-sm text-muted-foreground">{t("settings.dataLocationHint")}</p>
            <Button type="button" size="sm" variant="secondary" disabled={!dbPath} onClick={() => void onRevealDb()}>
              {t("settings.openInExplorer")}
            </Button>
          </div>
          {isTauri() && import.meta.env.DEV ? (
            <>
              <Separator />
              <div className="space-y-3">
                <Label>{t("settings.devCacheToolsTitle")}</Label>
                <p className="text-sm text-muted-foreground">
                  {t("settings.devCacheToolsHint")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={cacheBusy}
                    onClick={() => {
                      setCacheBusy(true);
                      setCacheError("");
                      void runCacheStatus()
                        .catch((e) => setCacheError(String(e)))
                        .finally(() => setCacheBusy(false));
                    }}
                  >
                    {t("settings.devCacheActionStatus")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={cacheBusy}
                    onClick={() => {
                      setCacheBusy(true);
                      setCacheError("");
                      void runAssetValidation()
                        .catch((e) => setCacheError(String(e)))
                        .finally(() => setCacheBusy(false));
                    }}
                  >
                    {t("settings.devCacheActionValidate")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={cacheBusy}
                    onClick={() => {
                      setCacheBusy(true);
                      setCacheError("");
                      void runWarmFullCache()
                        .catch((e) => setCacheError(String(e)))
                        .finally(() => setCacheBusy(false));
                    }}
                  >
                    {t("settings.devCacheActionWarm")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={cacheBusy}
                    onClick={() => {
                      setCacheBusy(true);
                      setCacheError("");
                      void runClearAllCachedData()
                        .catch((e) => setCacheError(String(e)))
                        .finally(() => setCacheBusy(false));
                    }}
                  >
                    {t("settings.devCacheActionClear")}
                  </Button>
                </div>
                {cacheError ? (
                  <p className="text-sm text-destructive break-all">{cacheError}</p>
                ) : null}
                {cacheWarmResult ? (
                  <p className="text-sm text-muted-foreground break-all">{cacheWarmResult}</p>
                ) : null}
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">{t("settings.devCacheStatusResponse")}</p>
                  <pre className="max-h-40 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">
                    {cacheStatusJson || "—"}
                  </pre>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">{t("settings.devCacheValidateResponse")}</p>
                  <pre className="max-h-40 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">
                    {cacheValidationJson || "—"}
                  </pre>
                </div>
              </div>
            </>
          ) : null}
          <Separator />
          <p className="text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t("settings.sectionAbout")}
          </p>
          <div className="space-y-3 text-sm text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{t("settings.developer")}</span>
              <Button variant="link" className="h-auto p-0 text-sm" asChild>
                <a
                  href="https://github.com/Jab04kin"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5"
                >
                  <img
                    src="https://avatars.githubusercontent.com/Jab04kin"
                    alt="@Shpinat avatar"
                    width={24}
                    height={24}
                    className="rounded-full"
                  />
                  @Shpinat
                </a>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{t("settings.org")}</span>
              <Button variant="link" className="h-auto p-0 text-sm" asChild>
                <a href="https://github.com/RaspizDIYs" target="_blank" rel="noreferrer">
                  RaspizDIYs
                </a>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{t("settings.community")}</span>
              <Button variant="link" className="h-auto p-0 text-sm" asChild>
                <a href="https://discord.gg/dmx5GqHDcN" target="_blank" rel="noreferrer">
                  Discord
                </a>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
