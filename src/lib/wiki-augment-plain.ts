function stripHtmlToSpaces(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ". ")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
}

function stripWikiBold(s: string): string {
  return s.replace(/'''+/g, "").replace(/''/g, "")
}

function isPpNamedParam(part: string): boolean {
  const pl = part.trim().toLowerCase()
  return /^(?:regeneratekey|key|type|formula|label\d*|display|stext|color|skey|ikey|shown)=/i.test(
    pl,
  )
}

function expandPpTemplate(parts: string[]): string {
  const rest = parts.slice(1).filter((p) => p.trim() !== "")
  const kept: string[] = []
  for (const p of rest) {
    if (isPpNamedParam(p)) continue
    const t = p.trim()
    if (t === "true" || t === "false") continue
    kept.push(t)
  }
  if (kept.length === 0) return ""
  const joined = kept.join(" ")
  const semiChunks = joined.split(";").filter((x) => x.trim() !== "")
  if (semiChunks.length >= 12) {
    return "scaling per level"
  }
  return joined.replace(/;/g, ", ")
}

function expandInnermostTemplate(inner: string): string {
  const parts = inner.split("|").map((p) => p.trim())
  const h = (parts[0] || "").toLowerCase()

  if (!h || h.startsWith("#")) return ""
  if (h === "vardefine" || h === "var" || h === "ifeq" || h === "switch" || h === "if") {
    return ""
  }
  if (h === "minus") return "−"
  if (h === "times") return "×"

  if (["fd", "gcd", "cs", "lc", "ms", "kis", "kis2", "rounds", "ft"].includes(h) && parts[1]) {
    return parts[1]
  }
  if (h === "pp" && parts.length >= 2) {
    return expandPpTemplate(parts)
  }
  if (h === "tip") {
    if (parts.length >= 3) {
      const v = parts[2]
      if (/icononly|=\s*true/i.test(v)) return ""
      return v
    }
    if (parts.length >= 2) return parts[1]
    return ""
  }
  if (h === "as" && parts.length >= 2) {
    return stripWikiBold(parts[1]).trim()
  }
  if (h === "ii" && parts.length >= 2) {
    return parts[1].replace(/_/g, " ")
  }
  if (h === "cai" && parts.length >= 2) {
    return parts.slice(1, 3).filter(Boolean).join(" — ")
  }
  if (h === "sbc" && parts.length >= 2) {
    return parts[1]
  }
  if (h === "sti" && parts.length >= 2) {
    return parts.slice(1).join(" ")
  }
  if (h === "nie" || h === "iis" || h === "ca") {
    return parts.length >= 3 ? parts[2] : parts[1] || ""
  }
  if (h === "small" || h === "font" || h === "main") {
    return parts[1] || ""
  }
  if (h.includes("citation")) {
    return ""
  }
  if (h === "range" && parts.length >= 2) {
    return parts.slice(1).join(" ")
  }
  if (h === "tt" && parts.length >= 2) {
    return stripWikiBold(parts.slice(1).join(" ")).trim()
  }
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]
    if (last.length <= 2 && parts.length >= 3) {
      return parts[parts.length - 2]
    }
    return stripWikiBold(last).trim()
  }
  return parts[0] || ""
}

export function expandWikiTemplatesToPlain(s: string): string {
  let out = s
  let guard = 0
  while (/\{\{[^{}]+\}\}/.test(out) && guard < 500) {
    guard += 1
    out = out.replace(/\{\{([^{}]+)\}\}/g, (_, inner: string) => expandInnermostTemplate(inner))
  }
  return out
}

function stripWikiTableBlocks(s: string): string {
  let out = s
  let guard = 0
  while (out.includes("{|") && guard < 20) {
    guard += 1
    const start = out.indexOf("{|")
    if (start === -1) break
    const end = out.indexOf("|}", start)
    if (end === -1) {
      out = out.slice(0, start).trimEnd()
      break
    }
    out = (out.slice(0, start) + " " + out.slice(end + 2)).trim()
  }
  return out
}

function collapseSpaces(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim()
}

function expandWikiLinks(s: string): string {
  return s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, page: string, display?: string) => {
    const t = (display ?? page).trim()
    return t.replace(/#/g, " — ")
  })
}

function scrubLeakedWikiFragments(s: string): string {
  let o = s
  o = o.replace(/\bpp\s*=\s*true\b/gi, "")
  o = o.replace(/\bkey=%\s*/gi, "")
  o = o.replace(/\bregeneratekey=%\s*/gi, "regenerate ")
  o = o.replace(/\bformula=\s*[\s\S]+?\.(?:\s|\n)+(?=[A-Z*])/gi, "")
  o = o.replace(/(?:\d+(?:\.\d+)?\s*;\s*){8,}\d+(?:\.\d+)?/g, " (level-scaled) ")
  o = o.replace(/\b([a-z]{4,})(\d)/gi, "$1 $2")
  return o
}

export type WikiAugmentPlainOptions = {
  maxChars?: number
}

export function wikiAugmentToPlain(raw: string, opts?: WikiAugmentPlainOptions): string {
  const maxChars = opts?.maxChars
  if (!raw.trim()) return ""

  let s = stripHtmlToSpaces(raw)
  s = stripWikiTableBlocks(s)
  s = expandWikiLinks(s)
  s = expandWikiTemplatesToPlain(s)
  s = expandWikiLinks(s)
  s = stripWikiBold(s)
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  s = scrubLeakedWikiFragments(s)
  s = collapseSpaces(s)

  if (maxChars && s.length > maxChars) {
    const cut = s.slice(0, maxChars)
    const dot = cut.lastIndexOf(". ")
    const end = dot > maxChars * 0.45 ? dot + 1 : maxChars
    return cut.slice(0, end).trim() + "…"
  }

  return s
}
