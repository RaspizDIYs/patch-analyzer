import type { DateFormatPref } from "@/lib/app-preferences";

function localeFromLang(lng: string): string {
  return lng === "en" ? "en-US" : "ru-RU";
}

export function formatAppDate(
  input: string | Date,
  format: DateFormatPref,
  lang: string,
): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return String(input);
  const loc = localeFromLang(lang);
  if (format === "absolute") {
    return new Intl.DateTimeFormat(loc, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  }
  const now = Date.now();
  const diffMs = d.getTime() - now;
  const rtf = new Intl.RelativeTimeFormat(loc, { numeric: "auto" });
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const week = Math.round(day / 7);
  const month = Math.round(day / 30);
  const year = Math.round(day / 365);
  if (Math.abs(sec) < 60) return rtf.format(sec, "second");
  if (Math.abs(min) < 60) return rtf.format(min, "minute");
  if (Math.abs(hr) < 24) return rtf.format(hr, "hour");
  if (Math.abs(day) < 7) return rtf.format(day, "day");
  if (Math.abs(week) < 5) return rtf.format(week, "week");
  if (Math.abs(month) < 12) return rtf.format(month, "month");
  return rtf.format(year, "year");
}
