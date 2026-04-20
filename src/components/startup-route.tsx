import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { loadAppPreferences, saveAppPreferences } from "@/lib/app-preferences";

const ALLOWED = new Set(["/", "/tier", "/history", "/augments", "/settings", "/community"]);

export function StartupRouteSync() {
  const navigate = useNavigate();
  const location = useLocation();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const p = loadAppPreferences();
    if (p.startupRouteMode === "last") {
      const path = p.lastPathname || "/";
      if (ALLOWED.has(path)) {
        navigate(path, { replace: true });
      }
    }
  }, [navigate]);

  useEffect(() => {
    const path = location.pathname;
    if (!ALLOWED.has(path)) return;
    saveAppPreferences({ lastPathname: path });
  }, [location.pathname]);

  return null;
}
