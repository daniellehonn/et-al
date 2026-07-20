// Pure, runtime-free module: frontmatter + wikilink parsing/serialization and
// the block model. No Cloudflare or DOM dependencies, so it is unit-testable
// directly with `node --experimental-strip-types`. The R2 vault stores exactly
// what these functions emit; the D1 index is derived from what they parse.

export const SCHEMA_VERSION = 5;

export const TYPE_KEYS = ["page", "goal", "idea", "task", "link"] as const;
export const STATUS_KEYS = ["active", "paused", "done", "archived", "inbox"] as const;
// Spaces are folders now, not a fixed enum. These are only the *seed* top-level
// folders a fresh vault starts with; the user can nest and add freely, and the
// folder tree in R2 is the source of truth (there is no space enum to drift).
export const SEED_SPACES = ["career", "school", "life", "learning"] as const;
// The reserved filename that carries a folder's metadata + overview note.
export const SPACE_FILE = "_space.md";

export type ItemType = (typeof TYPE_KEYS)[number];
export type ItemStatus = (typeof STATUS_KEYS)[number];

export interface Frontmatter {
  id: string;
  title: string;
  type: ItemType;
  // No `space` field: a page's space IS the folder it lives in (its R2 key path).
  status: ItemStatus;
  tags: string[];
  parent: string | null; // the parent goal's title (goal breakdown), e.g. "Land a summer internship"
  due: number | null; // unix seconds
  created_at: number;
  updated_at: number;
  extra: Record<string, string>; // unknown hand-authored keys, preserved round-trip
}

export interface ParsedPage {
  frontmatter: Frontmatter;
  body: string;
}

// A folder's metadata + overview note, stored at `{spacePath}/_space.md`.
// Optional: a folder still exists if it merely contains pages.
export interface SpaceMeta {
  id: string;
  name: string;          // display name (folder segment is the slug)
  color: string | null;  // nav accent
  icon: string | null;   // emoji/glyph
  description: string | null;
  sort: number | null;   // nav ordering
  created_at: number;
  updated_at: number;
  extra: Record<string, string>;
}

export interface ParsedSpace {
  meta: SpaceMeta;
  body: string; // the space's overview note
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

// A folder segment slug (for a space/subspace name). Same rules as slugify.
export function segify(name: string): string {
  return slugify(name);
}

// Normalize a space path: strip slashes, drop any trailing _space.md, collapse
// empties. "" = the vault root (a page can live at the top level).
export function normalizeSpacePath(path: string | null | undefined): string {
  if (!path) return "";
  return String(path)
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== SPACE_FILE)
    .join("/");
}

export function pageKey(spacePath: string | null, title: string, disambig?: string): string {
  const folder = normalizeSpacePath(spacePath);
  const slug = slugify(title) + (disambig ? `-${disambig}` : "");
  return folder ? `${folder}/${slug}.md` : `${slug}.md`;
}

export function spaceFileKey(spacePath: string | null): string {
  const folder = normalizeSpacePath(spacePath);
  return folder ? `${folder}/${SPACE_FILE}` : SPACE_FILE;
}

export function isSpaceFile(key: string): boolean {
  return key === SPACE_FILE || key.endsWith(`/${SPACE_FILE}`);
}

// The folder a given object key lives in (its space path). "" = root.
export function spacePathOf(key: string): string {
  const idx = key.lastIndexOf("/");
  return idx === -1 ? "" : key.slice(0, idx);
}

// The immediate parent folder of a space path, or null at the top level.
export function parentSpacePath(spacePath: string): string | null {
  const norm = normalizeSpacePath(spacePath);
  if (!norm) return null;
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

// The last segment (the folder's own slug), e.g. "career/internships" -> "internships".
export function spaceLeaf(spacePath: string): string {
  const norm = normalizeSpacePath(spacePath);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
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
  "id", "title", "type", "status", "tags", "parent", "due", "created", "updated",
]);
const SPACE_KNOWN_KEYS = new Set([
  "id", "name", "color", "icon", "description", "sort", "created", "updated",
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
  const rawStatus = stripQuotes(fmMap.status ?? "");

  const frontmatter: Frontmatter = {
    id: stripQuotes(fmMap.id ?? "") || crypto.randomUUID(),
    title: stripQuotes(fmMap.title ?? "") || "Untitled",
    type: (TYPE_KEYS as readonly string[]).includes(rawType) ? (rawType as ItemType) : "page",
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

// Split a raw markdown file into its frontmatter map, extra (unknown) keys, and body.
function splitFrontmatter(raw: string, known: Set<string>): {
  fmMap: Record<string, string>; extra: Record<string, string>; body: string;
} {
  const fmMap: Record<string, string> = {};
  const extra: Record<string, string> = {};
  let body = raw;
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split("\n")) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (known.has(key)) fmMap[key] = value;
      else extra[key] = value;
    }
  }
  return { fmMap, extra, body: body.replace(/^\n+/, "") };
}

export function parseSpaceFile(raw: string, fallbackName?: string): ParsedSpace {
  const { fmMap, extra, body } = splitFrontmatter(raw, SPACE_KNOWN_KEYS);
  const now = Math.floor(Date.now() / 1000);
  const meta: SpaceMeta = {
    id: stripQuotes(fmMap.id ?? "") || crypto.randomUUID(),
    name: stripQuotes(fmMap.name ?? "") || fallbackName || "Untitled space",
    color: fmMap.color != null ? stripQuotes(fmMap.color) : null,
    icon: fmMap.icon != null ? stripQuotes(fmMap.icon) : null,
    description: fmMap.description != null ? stripQuotes(fmMap.description) : null,
    sort: fmMap.sort != null && /^-?\d+$/.test(stripQuotes(fmMap.sort)) ? parseInt(stripQuotes(fmMap.sort), 10) : null,
    created_at: fmMap.created != null ? (toEpoch(fmMap.created) ?? now) : now,
    updated_at: fmMap.updated != null ? (toEpoch(fmMap.updated) ?? now) : now,
    extra,
  };
  return { meta, body };
}

export function serializeSpaceFile(space: ParsedSpace): string {
  const m = space.meta;
  const lines: string[] = ["---"];
  lines.push(`id: ${m.id}`);
  lines.push(`name: ${yamlScalar(m.name)}`);
  if (m.color) lines.push(`color: ${yamlScalar(m.color)}`);
  if (m.icon) lines.push(`icon: ${yamlScalar(m.icon)}`);
  if (m.description) lines.push(`description: ${yamlScalar(m.description)}`);
  if (m.sort != null) lines.push(`sort: ${m.sort}`);
  lines.push(`created: ${isoOf(m.created_at)}`);
  lines.push(`updated: ${isoOf(m.updated_at)}`);
  for (const [key, value] of Object.entries(m.extra)) lines.push(`${key}: ${value}`);
  lines.push("---");
  const body = space.body.replace(/^\n+/, "").replace(/\n+$/, "");
  return lines.join("\n") + "\n\n" + body + "\n";
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
