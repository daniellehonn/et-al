// A note body as plain data, and the pure functions over it.
//
// Block ops are applied here, in memory, rather than as a sequence of writes.
// That is what lets a proposal be previewed honestly: the reviewer is shown a
// diff of exactly the body this function produces, and accepting writes that
// same body. There is no second code path for the preview to drift from.
import type { BlockOp } from "../schema";
import { RuleError } from "./db";

// Parse markdown (or plain text) into blocks — enough for what agents write:
// headings, bullets, numbered items, todos, quotes, fenced code, dividers, and
// pipe tables. Indentation nests list items, which is what makes a pasted
// outline survive as an outline.
export type ParsedBlock = { type: string; content: Record<string, unknown>; depth: number };
const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);

export function markdownToBlocks(md: string): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let code: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      if (inCode) { out.push({ type: "code", content: { text: code.join("\n") }, depth: 0 }); code = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const s = line.trim();
    if (s === "") continue;
    // Two spaces or one tab per level, which is what both editors and agents emit.
    const indent = line.match(/^[\t ]*/)?.[0] ?? "";
    const depth = Math.floor((indent.replace(/\t/g, "  ").length) / 2);

    if (s.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const columns = cells(s);
      const rows: string[][] = [];
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(cells(lines[i])); i++; }
      i--; // the for-loop will i++ past the last consumed row
      out.push({ type: "table", content: { columns, rows }, depth: 0 });
      continue;
    }

    // A standalone image line is an image block, not a paragraph that happens to
    // contain markdown — otherwise an imported screenshot renders as its own
    // source text.
    const img = s.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) { out.push({ type: "image", content: { url: img[2], caption: img[1] }, depth: 0 }); continue; }

    if (/^#{1,6}\s+/.test(s)) out.push({ type: "heading", content: { text: s.replace(/^#{1,6}\s+/, ""), level: (s.match(/^#+/)?.[0].length ?? 1) }, depth: 0 });
    else if (/^(-|\*|\+)\s+\[[ xX]\]\s+/.test(s)) out.push({ type: "todo", content: { text: s.replace(/^(-|\*|\+)\s+\[[ xX]\]\s+/, ""), checked: /\[[xX]\]/.test(s) }, depth });
    else if (/^(-|\*|\+)\s+/.test(s)) out.push({ type: "bullet", content: { text: s.replace(/^(-|\*|\+)\s+/, "") }, depth });
    else if (/^\d+\.\s+/.test(s)) out.push({ type: "numbered", content: { text: s.replace(/^\d+\.\s+/, "") }, depth });
    else if (/^>\s?/.test(s)) out.push({ type: "quote", content: { text: s.replace(/^>\s?/, "") }, depth: 0 });
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) out.push({ type: "divider", content: {}, depth: 0 });
    else out.push({ type: "paragraph", content: { text: s }, depth: 0 });
  }
  if (inCode && code.length) out.push({ type: "code", content: { text: code.join("\n") }, depth: 0 });
  return out;
}

export interface BodyNode {
  id: string;
  parent_block_id: string | null;
  type: string;
  content: Record<string, unknown>;
  position: number;
}

/** Nodes in document order: depth-first, siblings by position. */
export function documentOrder(body: BodyNode[]): Array<BodyNode & { depth: number }> {
  const kids = new Map<string | null, BodyNode[]>();
  for (const n of body) {
    if (!kids.has(n.parent_block_id)) kids.set(n.parent_block_id, []);
    kids.get(n.parent_block_id)!.push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position);
  const out: Array<BodyNode & { depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  // A node whose parent is missing still shows: misplaced beats invisible.
  for (const n of body) if (!seen.has(n.id)) out.push({ ...n, depth: 0 });
  return out;
}

function subtree(body: BodyNode[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of body) {
      if (n.parent_block_id && out.has(n.parent_block_id) && !out.has(n.id)) { out.add(n.id); grew = true; }
    }
  }
  return out;
}

/** A position for a node placed after `afterId` among `parent`'s children:
 *  first when there is no anchor, last when the anchor is not a sibling. */
function positionAfter(body: BodyNode[], parent: string | null, afterId: string | null | undefined, moving?: string): number {
  const siblings = body
    .filter((n) => n.parent_block_id === parent && n.id !== moving)
    .sort((a, b) => a.position - b.position);
  if (!afterId) return (siblings[0]?.position ?? 1) - 1;
  const i = siblings.findIndex((n) => n.id === afterId);
  if (i === -1) return (siblings[siblings.length - 1]?.position ?? 0) + 1;
  const next = siblings[i + 1];
  return next ? (siblings[i].position + next.position) / 2 : siblings[i].position + 1;
}

function require(body: BodyNode[], id: string): BodyNode {
  const n = body.find((x) => x.id === id);
  if (!n) throw new RuleError(`block ${id} is not on this note`, 400);
  return n;
}

/** Apply ops to a body and return the new one. Throws, writing nothing, if any
 *  op names a block that is not there or would put a block inside itself — so a
 *  patch applies whole or not at all. */
export function applyOpsToBody(input: BodyNode[], ops: BlockOp[], newId: () => string): BodyNode[] {
  let body = input.map((n) => ({ ...n }));
  for (const op of ops) {
    if (op.op === "replace_content") {
      body = [];
      const stack: string[] = []; // stack[d]: the latest node at depth d, parent of d+1
      let pos = 1;
      for (const b of markdownToBlocks(op.content)) {
        const depth = Math.min(b.depth, stack.length); // never skip a level
        const id = newId();
        body.push({ id, parent_block_id: depth > 0 ? stack[depth - 1] : null, type: b.type, content: b.content, position: pos++ });
        stack[depth] = id;
        stack.length = depth + 1;
      }
    } else if (op.op === "insert") {
      const parent = op.parent ?? null;
      if (parent) require(body, parent);
      if (op.after) require(body, op.after);
      body.push({ id: newId(), parent_block_id: parent, type: op.type, content: op.content, position: positionAfter(body, parent, op.after) });
    } else if (op.op === "update") {
      const n = require(body, op.id);
      n.type = op.type ?? n.type;
      n.content = op.content;
    } else if (op.op === "delete") {
      require(body, op.id);
      const gone = subtree(body, op.id);
      body = body.filter((n) => !gone.has(n.id));
    } else if (op.op === "move") {
      const n = require(body, op.id);
      const parent = op.parent ?? null;
      if (parent) require(body, parent);
      if (op.after) require(body, op.after);
      if (parent && subtree(body, op.id).has(parent)) throw new RuleError("a block cannot move inside itself", 400);
      n.position = positionAfter(body, parent, op.after, n.id);
      n.parent_block_id = parent;
    }
  }
  return body;
}

// ---- markdown out ----------------------------------------------------------

function line(n: BodyNode & { depth: number }): string[] {
  const c = n.content;
  const text = typeof c.text === "string" ? c.text : "";
  const pad = "  ".repeat(n.depth);
  switch (n.type) {
    case "heading": return [`${"#".repeat(Math.min(Number(c.level) || 1, 6))} ${text}`];
    case "bullet": return [`${pad}- ${text}`];
    case "numbered": return [`${pad}1. ${text}`];
    case "todo": return [`${pad}- [${c.checked ? "x" : " "}] ${text}`];
    case "quote": return [`> ${text}`];
    case "divider": return ["---"];
    case "code": return ["```", ...text.split("\n"), "```"];
    case "image": return [`![${String(c.caption ?? "")}](${String(c.url ?? "")})`];
    case "page_link": return [`→ ${String(c.title ?? c.note_id ?? "")}`];
    case "table": {
      const cols = (c.columns as string[]) ?? [];
      const rows = (c.rows as string[][]) ?? [];
      const row = (r: string[]) => `| ${r.join(" | ")} |`;
      return [row(cols), row(cols.map(() => "---")), ...rows.map(row)];
    }
    default: return [`${pad}${text}`];
  }
}

/** A body as markdown, one line per line: what the reviewer reads, and what
 *  the diff is taken over. */
export function bodyLines(body: BodyNode[]): string[] {
  return documentOrder(body).flatMap(line);
}

// ---- diff ------------------------------------------------------------------

export interface DiffLine { kind: "same" | "add" | "del"; text: string }

/** Line diff by longest common subsequence. Quadratic, which is the right
 *  trade for a note: bodies are hundreds of lines, not hundreds of thousands,
 *  and LCS gives the minimal, most readable diff. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length, m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    // Deletions before additions at a change, so a replaced line reads "-old +new".
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}
