// Proposals: everything a machine wants to change, waiting for a human.
//
//   patch    an agent's edit to a note's body. Agents have no other way to
//            change a body; MCP exposes this and nothing that writes blocks.
//   insight  a fact the extractor drew from a saved source. It is not a note,
//            so it is in no search, no context and no tree until accepted.
//
// Resolving is the human's half, and only REST exposes it. Accepting runs the
// change under the proposer's name, so provenance survives approval.
import { z } from "zod";
import { insightPayload, proposePatchInput, type BlockOp, type InsightPayload, type ProposalKind } from "../schema";
import { Ctx, RuleError, all, first, id, logEvent, now } from "./db";
import { applyOps, previewOps } from "./blocks";
import type { DiffLine } from "./body";
import { createNote, requireNote } from "./notes";
import { requireSource } from "./sources";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  note_id: string | null;
  source_id: string | null;
  summary: string;
  payload: string;
  status: "pending" | "accepted" | "rejected";
  actor: string;
  result_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

/** A proposal with what a reviewer needs beside it. */
export interface ProposalView extends Proposal {
  note_title: string | null;
  source_title: string | null;
}

export function getProposal(c: Ctx, pid: string): Promise<Proposal | null> {
  return first<Proposal>(c, `SELECT * FROM proposal WHERE id = ?`, pid);
}

async function insert(c: Ctx, p: Pick<Proposal, "kind" | "note_id" | "source_id" | "summary"> & { payload: unknown }): Promise<Proposal> {
  const pid = id("prop");
  await c.db
    .prepare(`INSERT INTO proposal (id, kind, note_id, source_id, summary, payload, status, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(pid, p.kind, p.note_id, p.source_id, p.summary, JSON.stringify(p.payload), c.actor, now())
    .run();
  await logEvent(c, "propose", "proposal", pid, { kind: p.kind, summary: p.summary });
  return (await getProposal(c, pid))!;
}

/** An agent's proposed change to a note's body. Validated now, so a malformed
 *  patch fails for the agent that wrote it rather than for the human accepting it. */
export async function proposePatch(c: Ctx, input: z.input<typeof proposePatchInput>): Promise<Proposal> {
  const parsed = proposePatchInput.safeParse(input);
  if (!parsed.success) {
    throw new RuleError(`invalid patch — ops are insert, update, delete, move, replace_content. ${parsed.error.issues[0]?.message ?? ""}`, 400);
  }
  await requireNote(c, parsed.data.note_id);
  // A dry run against the note as it is now: an op naming a block that is not
  // there fails here, for the agent, rather than later for the reviewer.
  await previewOps(c, parsed.data.note_id, parsed.data.ops);
  return insert(c, { kind: "patch", note_id: parsed.data.note_id, source_id: null, summary: parsed.data.summary, payload: { ops: parsed.data.ops } });
}

/** A fact the extractor drew from a source. */
export async function proposeInsight(c: Ctx, sourceId: string, insight: InsightPayload): Promise<Proposal> {
  await requireSource(c, sourceId);
  const payload = insightPayload.parse(insight);
  return insert(c, { kind: "insight", note_id: null, source_id: sourceId, summary: payload.title, payload });
}

/** Pending proposals, newest first, optionally for one note or one source. */
export function listProposals(c: Ctx, opts: { note_id?: string; source_id?: string } = {}): Promise<ProposalView[]> {
  const where = ["p.status = 'pending'", opts.note_id ? "p.note_id = ?" : null, opts.source_id ? "p.source_id = ?" : null].filter(Boolean);
  return all<ProposalView>(
    c,
    `SELECT p.*, n.title AS note_title, s.title AS source_title
       FROM proposal p LEFT JOIN note n ON n.id = p.note_id LEFT JOIN source s ON s.id = p.source_id
      WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC, p.rowid DESC`,
    ...[opts.note_id, opts.source_id].filter((x): x is string => !!x),
  );
}

/** What accepting would do. For a patch: the note's body before and after, as
 *  markdown, and the line diff between them — computed by the same function
 *  accept uses, so the reviewer sees exactly what will be written. A patch the
 *  note has moved on from is reported as stale rather than thrown. */
export type ProposalPreview =
  | { kind: "patch"; before: string[]; after: string[]; diff: DiffLine[] }
  | { kind: "patch"; stale: string }
  | { kind: "insight"; insight: InsightPayload };

export async function previewProposal(c: Ctx, pid: string): Promise<ProposalPreview> {
  const p = await getProposal(c, pid);
  if (!p) throw new RuleError(`proposal ${pid} not found`, 404);
  if (p.kind === "insight") return { kind: "insight", insight: JSON.parse(p.payload) as InsightPayload };
  try {
    await requireNote(c, p.note_id!);
    return { kind: "patch", ...(await previewOps(c, p.note_id!, (JSON.parse(p.payload) as { ops: BlockOp[] }).ops)) };
  } catch (e) {
    if (e instanceof RuleError) return { kind: "patch", stale: e.message };
    throw e;
  }
}

async function requirePending(c: Ctx, pid: string): Promise<Proposal> {
  const p = await getProposal(c, pid);
  if (!p) throw new RuleError(`proposal ${pid} not found`, 404);
  if (p.status !== "pending") throw new RuleError(`proposal ${pid} is already ${p.status}`, 409);
  return p;
}

/** Accept: a patch is applied to its note, an insight becomes a note. Either way
 *  the result is written under the proposer's name, not the reviewer's. */
export async function acceptProposal(c: Ctx, pid: string): Promise<Proposal> {
  const p = await requirePending(c, pid);
  let resultId: string | null = null;
  if (p.kind === "patch") {
    await requireNote(c, p.note_id!);
    const { ops } = JSON.parse(p.payload) as { ops: BlockOp[] };
    await applyOps(c, p.note_id!, ops, p.actor);
    resultId = p.note_id;
  } else {
    const insight = JSON.parse(p.payload) as InsightPayload;
    // The note lands wherever its source was filed, or at the root if it was
    // never filed or that note has since been trashed.
    const home = p.source_id ? await first<{ id: string }>(
      c, `SELECT n.id FROM source s JOIN note n ON n.id = s.note_id WHERE s.id = ? AND n.trashed_at IS NULL`, p.source_id,
    ) : null;
    const note = await createNote({ ...c, actor: p.actor }, {
      parent_id: home?.id ?? null, title: insight.title, body: insight.content, source_id: p.source_id,
    });
    resultId = note.id;
    if (c.env.JOBS) await c.env.JOBS.send({ type: "embed_note", note_id: note.id });
  }
  await c.db.prepare(`UPDATE proposal SET status = 'accepted', result_id = ?, resolved_at = ? WHERE id = ?`).bind(resultId, now(), pid).run();
  await logEvent(c, "accept", "proposal", pid, { kind: p.kind, result_id: resultId });
  return (await getProposal(c, pid))!;
}

export async function rejectProposal(c: Ctx, pid: string): Promise<Proposal> {
  const p = await requirePending(c, pid);
  await c.db.prepare(`UPDATE proposal SET status = 'rejected', resolved_at = ? WHERE id = ?`).bind(now(), pid).run();
  await logEvent(c, "reject", "proposal", pid, { kind: p.kind });
  return (await getProposal(c, pid))!;
}
