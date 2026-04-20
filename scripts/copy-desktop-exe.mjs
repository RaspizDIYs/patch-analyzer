import { copyFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "src-tauri", "target", "release", "lol-meta-analyzer.exe");
const dst = join(root, "PatchAnalyzer-local.exe");

if (!existsSync(src)) {
  console.error("Не найден:", src, "\nСначала: npm run tauri:build");
  process.exit(1);
}
copyFileSync(src, dst);
console.log("Скопировано:", dst);
