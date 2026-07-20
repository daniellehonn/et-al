// Pure, runtime-free module: frontmatter + wikilink parsing/serialization and
// the block model. No Cloudflare or DOM dependencies, so it is unit-testable
// directly with `node --experimental-strip-types`. The R2 vault stores exactly
// what these functions emit; the D1 index is derived from what they parse.

export const SCHEMA_VERSION = 4;

export const TYPE_KEYS = ["page", "goal", "idea", "task", "link"] as const;
export const SPACE_KEYS = ["identity", "school", "career", "learning", "projects", "life", "saved"] as const;
export const STATUS_KEYS = ["active", "paused", "done", "archived", "inbox"] as const;
export const UNSORTED = "unsorted";

export type ItemType = (typeof TYPE_KEYS)[number];
export type ItemSpace = (typeof SPACE_KEYS)[number];
export type ItemStatus = (typeof STATUS_KEYS)[number];

export interface Frontmatter {
  id: string;
  title: string;
  type: ItemType;
  space: ItemSpace | null;
  status: ItemStatus;
  tags: string[];
  parent: string | null; // the linked title, e.g. "Creative AI-native dev identity"
  due: number | null; // unix seconds
  created_at: number;
  updated_at: number;
  extra: Record<string, string>; // unknown hand-authored keys, preserved round-trip
}

export interface ParsedPage {
  frontmatter: Frontmatter;
  body: string;
}

export interface WikiLink {
  target: string; // raw title as written
  targetNorm: string; // normalized for resolution
  alias: string | null;
  context: string; // the line it appeared in (backlink preview)
}

// --------------------------------------------------------------------------
// Normalization + slugs
// --------------------------------------------------------------------------

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "untitled";
}

export function pageKey(space: ItemSpace | null, title: string, disambig?: string): string {
  const folder = space ?? UNSORTED;
  const slug = slugify(title) + (disambig ? `-${disambig}` : "");
  return `${folder}/${slug}.md`;
}

// --------------------------------------------------------------------------
// Wikilinks
// --------------------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

export function extractWikiLinks(body: string): WikiLink[] {
  const links: WikiLink[] = [];
  const lines = body.split("\n");
  for (const line of lines) {
    // Skip fenced code — links inside code blocks are literal, not references.
    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(line)) !== null) {
      const target = match[1].trim();
      if (!target) continue;
      links.push({
        target,
        targetNorm: normalizeTitle(target),
        alias: match[2]?.trim() || null,
        context: line.trim().slice(0, 300),
      });
    }
  }
  return links;
}

// Strip fenced code blocks before link extraction so ``` [[x]] ``` isn't a link.
export function bodyWithoutCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export function extractBodyLinks(body: string): WikiLink[] {
  return extractWikiLinks(bodyWithoutCode(body));
}

// Rewrite every [[oldTitle]] / [[oldTitle|alias]] to the new title, preserving
// aliases and any #heading anchors. Used by rename propagation.
export function rewriteWikiLink(text: string, fromTitle: string, toTitle: string): string {
  const fromNorm = normalizeTitle(fromTitle);
  return text.replace(WIKILINK_RE, (whole, rawTarget: string, alias?: string) => {
    if (normalizeTitle(rawTarget) !== fromNorm) return whole;
    // Preserve a #anchor if present in the original.
    const anchorMatch = whole.match(/\[\[[^\]|#]+(#[^\]|]+)?/);
    const anchor = anchorMatch && anchorMatch[1] ? anchorMatch[1] : "";
    return alias ? `[[${toTitle}${anchor}|${alias}]]` : `[[${toTitle}${anchor}]]`;
  });
}

// --------------------------------------------------------------------------
// Frontmatter (deterministic subset of YAML; forgiving on read)
// --------------------------------------------------------------------------

const KNOWN_KEYS = new Set([
  "id", "title", "type", "space", "status", "tags", "parent", "due", "created", "updated",
]);

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return trimmed ? [stripQuotes(trimmed)] : [];
  const inner = trimmed.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((entry) => stripQuotes(entry.trim())).filter(Boolean);
}

function stripQuotes(value: string): string {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Extract the title out of a `parent: "[[Some Title]]"` value (or a bare title).
export function parentTitleFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = stripQuotes(value).trim();
  const m = cleaned.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return (m ? m[1] : cleaned).trim() || null;
}

function toEpoch(value: string): number | null {
  const t = stripQuotes(value).trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function parsePage(raw: string): ParsedPage {
  let body = raw;
  const fmMap: Record<string, string> = {};
  const extra: Record<string, string> = {};

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split("\n")) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (KNOWN_KEYS.has(key)) fmMap[key] = value;
      else extra[key] = value;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const rawType = stripQuotes(fmMap.type ?? "");
  const rawSpace = stripQuotes(fmMap.space ?? "");
  const rawStatus = stripQuotes(fmMap.status ?? "");

  const frontmatter: Frontmatter = {
    id: stripQuotes(fmMap.id ?? "") || crypto.randomUUID(),
    title: stripQuotes(fmMap.title ?? "") || "Untitled",
    type: (TYPE_KEYS as readonly string[]).includes(rawType) ? (rawType as ItemType) : "page",
    space:
      rawSpace && rawSpace !== UNSORTED && (SPACE_KEYS as readonly string[]).includes(rawSpace)
        ? (rawSpace as ItemSpace)
        : null,
    status: (STATUS_KEYS as readonly string[]).includes(rawStatus) ? (rawStatus as ItemStatus) : "inbox",
    tags: fmMap.tags ? parseInlineArray(fmMap.tags) : [],
    parent: parentTitleFrom(fmMap.parent),
    due: fmMap.due != null ? toEpoch(fmMap.due) : null,
    created_at: fmMap.created != null ? (toEpoch(fmMap.created) ?? now) : now,
    updated_at: fmMap.updated != null ? (toEpoch(fmMap.updated) ?? now) : now,
    extra,
  };

  return { frontmatter, body: body.replace(/^\n+/, "") };
}

function isoOf(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

export function serializePage(page: ParsedPage): string {
  const fm = page.frontmatter;
  const lines: string[] = ["---"];
  lines.push(`id: ${fm.id}`);
  lines.push(`title: ${yamlScalar(fm.title)}`);
  lines.push(`type: ${fm.type}`);
  if (fm.space) lines.push(`space: ${fm.space}`);
  lines.push(`status: ${fm.status}`);
  if (fm.tags.length) lines.push(`tags: [${fm.tags.map(yamlScalar).join(", ")}]`);
  if (fm.parent) lines.push(`parent: "[[${fm.parent}]]"`);
  if (fm.due != null) lines.push(`due: ${new Date(fm.due * 1000).toISOString().slice(0, 10)}`);
  lines.push(`created: ${isoOf(fm.created_at)}`);
  lines.push(`updated: ${isoOf(fm.updated_at)}`);
  for (const [key, value] of Object.entries(fm.extra)) lines.push(`${key}: ${value}`);
  lines.push("---");
  const body = page.body.replace(/^\n+/, "").replace(/\n+$/, "");
  return lines.join("\n") + "\n\n" + body + "\n";
}

// Quote a scalar only when needed (contains YAML-significant chars).
function yamlScalar(value: string): string {
  if (value === "") return '""';
  if (/[:#\[\]{}",'\n]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

// --------------------------------------------------------------------------
// Block model — the pure bridge between the editor and markdown.
// A block is a shape the editor renders; markdown is always the wire format.
// --------------------------------------------------------------------------

export type BlockType =
  | "paragraph" | "h1" | "h2" | "h3"
  | "todo" | "todo-done" | "bullet" | "number"
  | "quote" | "callout" | "code" | "divider";

export interface Block {
  type: BlockType;
  text: string; // markdown-inline text (may contain [[links]])
  lang?: string; // for code
}

export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = body.replace(/\n+$/, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push({ type: "code", text: buf.join("\n"), lang });
      continue;
    }
    if (/^\s*---\s*$/.test(line)) { blocks.push({ type: "divider", text: "" }); i++; continue; }
    if (/^\s*$/.test(line)) { i++; continue; }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^#\s+(.*)$/))) blocks.push({ type: "h1", text: m[1] });
    else if ((m = line.match(/^##\s+(.*)$/))) blocks.push({ type: "h2", text: m[1] });
    else if ((m = line.match(/^###\s+(.*)$/))) blocks.push({ type: "h3", text: m[1] });
    else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/)))
      blocks.push({ type: m[1].toLowerCase() === "x" ? "todo-done" : "todo", text: m[2] });
    else if ((m = line.match(/^\s*>\s*\[!\w+\]\s*(.*)$/))) blocks.push({ type: "callout", text: m[1] });
    else if ((m = line.match(/^\s*>\s+(.*)$/))) blocks.push({ type: "quote", text: m[1] });
    else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) blocks.push({ type: "number", text: m[1] });
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) blocks.push({ type: "bullet", text: m[1] });
    else blocks.push({ type: "paragraph", text: line });
    i++;
  }
  return blocks;
}

export function serializeBlocks(blocks: Block[]): string {
  const out: string[] = [];
  let numberRun = 0;
  for (const block of blocks) {
    if (block.type !== "number") numberRun = 0;
    switch (block.type) {
      case "h1": out.push(`# ${block.text}`); break;
      case "h2": out.push(`## ${block.text}`); break;
      case "h3": out.push(`### ${block.text}`); break;
      case "todo": out.push(`- [ ] ${block.text}`); break;
      case "todo-done": out.push(`- [x] ${block.text}`); break;
      case "bullet": out.push(`- ${block.text}`); break;
      case "number": out.push(`${++numberRun}. ${block.text}`); break;
      case "quote": out.push(`> ${block.text}`); break;
      case "callout": out.push(`> [!note] ${block.text}`); break;
      case "divider": out.push("---"); break;
      case "code": out.push("```" + (block.lang || "") + "\n" + block.text + "\n```"); break;
      default: out.push(block.text);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}
