import { invoke } from "@tauri-apps/api/core";

export const WIKI_TOOLBAR_HEIGHT = 52;

export function getWikiEmbedRect(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return {
    x: 0,
    y: WIKI_TOOLBAR_HEIGHT,
    width,
    height: Math.max(0, height - WIKI_TOOLBAR_HEIGHT),
  };
}

export function pushWikiHistory(prev: string[], url: string): string[] {
  const last = prev[prev.length - 1];
  if (last === url) return prev;
  return [...prev, url].slice(-50);
}

export async function wikiEmbedOpen(url: string): Promise<void> {
  const r = getWikiEmbedRect();
  await invoke("wiki_embed_open", {
    url,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  });
}

export async function wikiEmbedClose(): Promise<void> {
  await invoke("wiki_embed_close");
}

export async function wikiEmbedResize(): Promise<void> {
  const r = getWikiEmbedRect();
  await invoke("wiki_embed_resize", {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  });
}

export async function wikiEmbedNavigate(url: string): Promise<void> {
  await invoke("wiki_embed_navigate", { url });
}

export async function wikiEmbedGoBack(): Promise<void> {
  await invoke("wiki_embed_go_back");
}

export function shortWikiUrlForList(u: string): string {
  try {
    const parsed = new URL(u);
    const p = parsed.pathname + parsed.search;
    return p.length > 0 ? p : u;
  } catch {
    return u;
  }
}
