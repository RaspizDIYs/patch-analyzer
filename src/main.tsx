import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { invoke, isTauri } from "@tauri-apps/api/core";
import i18n from "./i18n";
import App from "./App";
import { applyDomFromPreferences, loadAppPreferences } from "./lib/app-preferences";
import "./index.css";

applyDomFromPreferences(loadAppPreferences());
document.documentElement.lang = i18n.language?.startsWith("en") ? "en" : "ru";

function hideBootLoader() {
  const loader = document.getElementById("boot-loader");
  if (!loader) return;
  loader.setAttribute("data-hidden", "true");
  window.setTimeout(() => loader.remove(), 260);
}

const failSafeHideTimer = window.setTimeout(() => hideBootLoader(), 8000);

function finishBootPhase() {
  window.clearTimeout(failSafeHideTimer);
  hideBootLoader();
}

if (isTauri() && import.meta.env.DEV) {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "F12") return;
      e.preventDefault();
      void invoke("plugin:webview|internal_toggle_devtools").catch((err) => {
        console.error("internal_toggle_devtools failed", err);
      });
    },
    true,
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <HashRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <App />
      </HashRouter>
    </I18nextProvider>
  </React.StrictMode>,
);

window.addEventListener("error", () => finishBootPhase(), { once: true });
window.addEventListener("unhandledrejection", () => finishBootPhase(), { once: true });
requestAnimationFrame(() => finishBootPhase());
