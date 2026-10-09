// Translation between et al.'s blocks and BlockNote's document.
//
// et al. stores one row per block with parent_block_id for nesting and a
// content_json payload; BlockNote works on a nested tree of {id,type,props,
// content,children}. The shapes are close enough that this is a mapping rather
// than a conversion, which is why BlockNote fits where a CRDT editor did not.
//
// Two rules govern the mapping:
//
//  1. `text` stays canonical. Agents read blocks over MCP and FTS indexes them,
//     so every block keeps a plain-markdown `text` field. BlockNote's richer
//     inline array is stored alongside under `rich` for fidelity — never
//     instead of it.
//  2. Unknown types round-trip untouched. et al. has block types BlockNote has
//     never heard of (collection, page_link). They are
//     carried through as opaque custom blocks so opening a page in the editor
//     can never silently delete them.
import type { Block } from "./api";

export type InlineContent =
  | { type: "text"; text: string; styles: Record<string, unknown> }
  | { type: "link"; href: string; content: Array<{ type: "text"; text: string; styles: Record<string, unknown> }> };

export interface BNBlock {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: InlineContent[] | unknown;
  children: BNBlock[];
}

// et al. type -> BlockNote type. Anything absent is preserved as a custom block.
const TO_BN: Record<string, string> = {
  paragraph: "paragraph",
  heading: "heading",
  bullet: "bulletListItem",
  numbered: "numberedListItem",
  todo: "checkListItem",
  code: "codeBlock",
  quote: "quote",
  divider: "divider",
  image: "image",
  table: "table",
};
const TO_ETAL: Record<string, string> = Object.fromEntries(
  Object.entries(TO_BN).map(([k, v]) => [v, k]),
);

/** Types BlockNote renders itself. Everything else becomes an `etAlBlock`. */
export const NATIVE_TYPES = new Set(Object.keys(TO_BN));

const parse = (json: string): Record<string, unknown> => {
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
};

// ---- markdown <-> inline content -------------------------------------------
// Only the inline marks et al. already round-trips through its own parser:
// **bold**, *italic*, `code`, [text](href). Anything else stays literal, which
// is the safe failure — text is never lost, only left unstyled.

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]*\]\([^)]+\))/g;

export function markdownToInline(md: string): InlineContent[] {
  if (!md) return [];
  const out: InlineContent[] = [];
  let last = 0;
  for (const m of md.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ type: "text", text: md.slice(last, i), styles: {} });
    const tok = m[0];
    if (tok.startsWith("**")) out.push({ type: "text", text: tok.slice(2, -2), styles: { bold: true } });
    else if (tok.startsWith("`")) out.push({ type: "text", text: tok.slice(1, -1), styles: { code: true } });
    else if (tok.startsWith("[")) {
      const link = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(tok);
      if (link) {
        // A link at the mention href IS a mention — this is what lets an agent
        // write one in plain markdown and have it render as a chip.
        if (link[2].startsWith(MENTION_HREF)) {
          out.push({ type: "pageMention", props: { pageId: link[2].slice(MENTION_HREF.length), title: link[1] } } as unknown as InlineContent);
        } else {
          out.push({ type: "link", href: link[2], content: [{ type: "text", text: link[1], styles: {} }] });
        }
      }
    } else out.push({ type: "text", text: tok.slice(1, -1), styles: { italic: true } });
    last = i + tok.length;
  }
  if (last < md.length) out.push({ type: "text", text: md.slice(last), styles: {} });
  return out.length ? out : [{ type: "text", text: md, styles: {} }];
}

/** A page mention serialises as a normal markdown link to the page. That keeps
 *  `text` readable to agents and indexable by FTS, and means a mention written
 *  by an agent as a plain link comes back as a real mention on load. */
export const MENTION_HREF = "/page/?id=";

export function inlineToMarkdown(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((n) => {
    const node = n as InlineContent & { styles?: Record<string, unknown> };
    if ((node as { type: string }).type === "pageMention") {
      const p = (n as { props?: { pageId?: string; title?: string } }).props ?? {};
      return `[${p.title || "Untitled"}](${MENTION_HREF}${p.pageId ?? ""})`;
    }
    if (node.type === "link") {
      const inner = inlineToMarkdown((node as { content: unknown }).content);
      return `[${inner}](${(node as { href: string }).href})`;
    }
    let t = (node as { text?: string }).text ?? "";
    const s = node.styles ?? {};
    if (s.code) t = `\`${t}\``;
    if (s.bold) t = `**${t}**`;
    if (s.italic) t = `*${t}*`;
    return t;
  }).join("");
}

// ---- et al. -> BlockNote ----------------------------------------------------

/** Build BlockNote's nested document from et al.'s flat, parent-linked rows. */
export function toBlockNote(blocks: Block[]): BNBlock[] {
  const byParent = new Map<string | null, Block[]>();
  for (const b of blocks) {
    const k = b.parent_block_id;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(b);
  }

  const build = (parent: string | null, seen: Set<string>): BNBlock[] =>
    (byParent.get(parent) ?? [])
      .filter((b) => !seen.has(b.id))
      .map((b) => {
        seen.add(b.id);
        return one(b, build(b.id, seen));
      });

  const doc = build(null, new Set());
  // BlockNote refuses an empty document; give it somewhere to type.
  return doc.length ? doc : [{ id: "initial", type: "paragraph", props: {}, content: [], children: [] }];
}

function one(b: Block, children: BNBlock[]): BNBlock {
  const c = parse(b.content_json);
  const text = String(c.text ?? "");
  const bnType = TO_BN[b.type];

  if (!bnType) {
    // Opaque passthrough — the editor shows a placeholder, the data survives.
    return {
      id: b.id, type: "etAlBlock",
      props: { etype: b.type, payload: JSON.stringify(c) },
      content: undefined, children,
    };
  }

  // `rich` is BlockNote's own inline array from a previous save; prefer it so
  // styling round-trips exactly, and fall back to parsing the markdown.
  const content = Array.isArray(c.rich) ? (c.rich as InlineContent[]) : markdownToInline(text);

  switch (b.type) {
    case "heading":
      return { id: b.id, type: "heading", props: { level: Math.min(Number(c.level) || 1, 3) }, content, children };
    case "todo":
      return { id: b.id, type: "checkListItem", props: { checked: !!c.checked }, content, children };
    case "code":
      return { id: b.id, type: "codeBlock", props: { language: String(c.language ?? "") }, content: [{ type: "text", text, styles: {} }], children };
    case "divider":
      return { id: b.id, type: "divider", props: {}, content: undefined, children };
    case "image":
      return { id: b.id, type: "image", props: { url: String(c.url ?? ""), caption: String(c.caption ?? "") }, content: undefined, children };
    case "table":
      // BlockNote's table cells are its own shape; keep et al.'s columns/rows in
      // props so nothing is lost, and render a passthrough for now.
      return { id: b.id, type: "etAlBlock", props: { etype: "table", payload: JSON.stringify(c) }, content: undefined, children };
    default:
      return { id: b.id, type: bnType, props: {}, content, children };
  }
}

// ---- BlockNote -> et al. ----------------------------------------------------

export interface FlatBlock {
  id: string;
  parent_block_id: string | null;
  type: string;
  content: Record<string, unknown>;
  position: number;
}

/** Flatten BlockNote's tree back into et al. rows, in document order. */
export function fromBlockNote(doc: BNBlock[]): FlatBlock[] {
  const out: FlatBlock[] = [];
  const walk = (nodes: BNBlock[], parent: string | null) => {
    nodes.forEach((n, i) => {
      const { type, content } = decode(n);
      out.push({ id: n.id, parent_block_id: parent, type, content, position: i });
      if (n.children?.length) walk(n.children, n.id);
    });
  };
  walk(doc, null);
  return out;
}

function decode(n: BNBlock): { type: string; content: Record<string, unknown> } {
  if (n.type === "etAlBlock") {
    const etype = String(n.props.etype ?? "paragraph");
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(String(n.props.payload ?? "{}")) as Record<string, unknown>; } catch { /* keep empty */ }
    return { type: etype, content: payload };
  }

  const etype = TO_ETAL[n.type] ?? "paragraph";
  const text = inlineToMarkdown(n.content);
  // Both representations are written: `text` for agents and search, `rich` for
  // exact styling on the next load.
  const base: Record<string, unknown> = { text, rich: n.content };

  switch (n.type) {
    case "heading":     return { type: "heading", content: { ...base, level: Number(n.props.level) || 1 } };
    case "checkListItem": return { type: "todo", content: { ...base, checked: !!n.props.checked } };
    case "codeBlock":   return { type: "code", content: { text, language: String(n.props.language ?? "") } };
    case "divider":     return { type: "divider", content: {} };
    case "image":       return { type: "image", content: { url: String(n.props.url ?? ""), caption: String(n.props.caption ?? "") } };
    default:            return { type: etype, content: base };
  }
}
