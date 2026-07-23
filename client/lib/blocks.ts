// Block vocabulary and inline rendering.
//
// Ported from the v5 editor in src/ui.ts (Decision G — we own a working block
// model, so we extend it rather than adopting TipTap or Lexical).
//
// One important change from v5: blocks are no longer parsed out of a markdown
// string. v6 stores them as rows (`document_blocks`), so `text` here is the
// block's own content and the *type* is data rather than syntax. Markdown
// parsing survives only for paste handling and the Phase 6 export.

import type { Block } from "./api";

export type BlockDraft = Pick<Block, "type" | "text"> & {
  id?: string;
  data?: Record<string, unknown>;
  is_ai?: boolean;
};

export interface SlashItem {
  type: string;
  icon: string;
  label: string;
  hint?: string;
  /** Product-specific blocks carry required fields (spec §2.12). */
  fields?: string[];
}

/** Generic blocks, then the ones that only make sense in this product. */
export const SLASH_ITEMS: SlashItem[] = [
  { type: "paragraph", icon: "¶", label: "Text" },
  { type: "heading", icon: "H", label: "Heading" },
  { type: "todo", icon: "☑", label: "To-do" },
  { type: "bullet", icon: "•", label: "Bulleted list" },
  { type: "number", icon: "1.", label: "Numbered list" },
  { type: "quote", icon: "“", label: "Quote" },
  { type: "callout", icon: "◆", label: "Callout" },
  { type: "code", icon: "</>", label: "Code" },
  { type: "divider", icon: "—", label: "Divider" },
  {
    type: "decision", icon: "⚖", label: "Decision",
    hint: "Interview-ready evidence of technical reasoning",
    fields: ["rationale", "alternatives"],
  },
  {
    type: "experiment", icon: "⚗", label: "Experiment",
    hint: "Makes results comparable against the next one",
    fields: ["hypothesis", "method", "result", "next_test"],
  },
  {
    type: "learning", icon: "✦", label: "Learning",
    hint: "Moves a note toward mastery",
    fields: ["own_explanation", "application"],
  },
  {
    type: "content-seed", icon: "✎", label: "Content seed",
    hint: "A low-friction draft starting point",
    fields: ["hook", "audience", "format"],
  },
];

export const PRODUCT_BLOCKS = new Set([
  "decision", "experiment", "learning", "content-seed", "relation", "tool-card", "log-ref",
]);

export function isProductBlock(type: string): boolean {
  return PRODUCT_BLOCKS.has(type);
}

export function fieldsFor(type: string): string[] {
  return SLASH_ITEMS.find((i) => i.type === type)?.fields ?? [];
}

export function labelFor(type: string): string {
  return SLASH_ITEMS.find((i) => i.type === type)?.label ?? type;
}

export function emptyBlock(type = "paragraph"): BlockDraft {
  return { type, text: "", data: {}, is_ai: false };
}

// ---------------------------------------------------------------------------
// Inline rendering: [[wikilinks]], `code`, **bold**
// ---------------------------------------------------------------------------

export interface InlineSegment {
  kind: "text" | "link" | "code" | "bold";
  value: string;
  /** For links: the target title, which may differ from the displayed label. */
  target?: string;
}

const INLINE_RE = /\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*/g;

/**
 * Splits block text into renderable segments. Returns data rather than HTML —
 * v5 built an HTML string because it had no framework; React renders the
 * segments directly, which also removes the escaping burden.
 */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;

  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ kind: "text", value: text.slice(last, match.index) });
    }
    last = INLINE_RE.lastIndex;

    if (match[1] !== undefined) {
      const target = match[1].trim();
      segments.push({ kind: "link", value: (match[2] ?? target).trim(), target });
    } else if (match[3] !== undefined) {
      segments.push({ kind: "code", value: match[3] });
    } else if (match[4] !== undefined) {
      segments.push({ kind: "bold", value: match[4] });
    }
  }
  if (last < text.length) segments.push({ kind: "text", value: text.slice(last) });
  return segments;
}

/** Every [[target]] referenced in a document — the relation edges to persist. */
export function extractLinks(blocks: BlockDraft[]): Array<{ target: string; context: string }> {
  const found: Array<{ target: string; context: string }> = [];
  for (const block of blocks) {
    for (const segment of parseInline(block.text ?? "")) {
      if (segment.kind === "link" && segment.target) {
        found.push({ target: segment.target, context: block.text });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Markdown interop (paste in, export out)
// ---------------------------------------------------------------------------

/** Parses pasted markdown into blocks. Mirrors v5's parseBlocks. */
export function parseMarkdown(body: string): BlockDraft[] {
  const blocks: BlockDraft[] = [];
  const lines = String(body ?? "").replace(/\n+$/, "").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buffer.push(lines[i++]);
      i++;
      blocks.push({ type: "code", text: buffer.join("\n"), data: { lang } });
      continue;
    }
    if (/^\s*---\s*$/.test(line)) { blocks.push({ type: "divider", text: "" }); i++; continue; }
    if (/^\s*$/.test(line)) { i++; continue; }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      blocks.push({ type: "heading", text: m[2], data: { level: m[1].length } });
    } else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
      blocks.push({ type: m[1].toLowerCase() === "x" ? "todo-done" : "todo", text: m[2] });
    } else if ((m = line.match(/^\s*>\s*\[!\w+\]\s*(.*)$/))) {
      blocks.push({ type: "callout", text: m[1] });
    } else if ((m = line.match(/^\s*>\s+(.*)$/))) {
      blocks.push({ type: "quote", text: m[1] });
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      blocks.push({ type: "number", text: m[1] });
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      blocks.push({ type: "bullet", text: m[1] });
    } else {
      blocks.push({ type: "paragraph", text: line });
    }
    i++;
  }
  return blocks.length ? blocks : [emptyBlock()];
}

/** Blocks back to markdown. Mirrors v5's serializeBlocks. */
export function toMarkdown(blocks: BlockDraft[]): string {
  const out: string[] = [];
  let n = 0;
  for (const b of blocks) {
    if (b.type !== "number") n = 0;
    switch (b.type) {
      case "heading": out.push("#".repeat(Number(b.data?.level ?? 2)) + " " + b.text); break;
      case "todo": out.push("- [ ] " + b.text); break;
      case "todo-done": out.push("- [x] " + b.text); break;
      case "bullet": out.push("- " + b.text); break;
      case "number": out.push(`${++n}. ${b.text}`); break;
      case "quote": out.push("> " + b.text); break;
      case "callout": out.push("> [!note] " + b.text); break;
      case "divider": out.push("---"); break;
      case "code": out.push("```" + String(b.data?.lang ?? "") + "\n" + b.text + "\n```"); break;
      default: out.push(b.text);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}
