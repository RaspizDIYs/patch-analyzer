import { invoke } from "@tauri-apps/api/core";

export async function wikiEmbedOpen(url: string): Promise<void> {
  await invoke("wiki_embed_open", { url });
}

export async function wikiEmbedClose(): Promise<void> {
  await invoke("wiki_embed_close");
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
