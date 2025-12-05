import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
 
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Преобразует патчноут версию (25.24) в игровую (15.24.x) для DDragon/API Riot.
// Правило: отнимаем 10 от майнера года, добавляем .0 в конце. Если формат неизвестен, возвращаем исходное.
export function mapPatchVersion(patch: string): string {
  const match = patch.match(/^(\d{2})\.(\d{2})/);
  if (!match) return patch;
  const major = parseInt(match[1], 10);
  const minor = match[2];
  if (Number.isNaN(major)) return patch;
  const converted = `${Math.max(0, major - 10)}.${minor}.0`;
  return converted;
}

