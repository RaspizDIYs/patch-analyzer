import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(async ({ command }) => ({
  base: command === "build" ? "./" : "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@tauri-apps")) {
            return "tauri-vendor";
          }
          if (id.includes("@radix-ui")) {
            return "radix-vendor";
          }
          if (id.includes("i18next") || id.includes("react-i18next")) {
            return "i18n-vendor";
          }
          if (
            /[/\\]node_modules[/\\](?:react|react-dom|react-router|react-router-dom|scheduler|react-is|use-sync-external-store)[/\\]/.test(
              id,
            ) ||
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/")
          ) {
            return "react-vendor";
          }
        },
      },
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
