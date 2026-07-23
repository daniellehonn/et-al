// Knowledge Notes — durable explanations and mental models.
//
// Two ideas make this more than a note table:
//
//   1. **Mastery is explicit** (captured → learning → understood → applied), so
//      learning progress is visible and "applied" can be evidenced by the
//      projects a note is linked to.
//   2. **AI prose is segregated.** `ai_sections` records which parts were
//      generated, because "My explanation" and "Where I applied it" are
//      first-class and a generated summary must never stand in for demonstrated
//      understanding (spec §5.7).

import { desc, eq, and } from "drizzle-orm";
import { knowledgeNotes, NOTE_TYPE, MASTERY, type NoteType, type Mastery } from "../schema.ts";
import {
  type Env, getDb, now, newId, requireText, optionalText, optionalEnum, requireEnum,
  normalizeTitle, audit, NotFoundError, removeFts,
} from "./db.ts";
import { deleteDocument } from "./documents.ts";
import { resolveRelationsTo } from "./relations.ts";
import { track } from "../analytics.ts";

export interface NoteInput {
  title?: string;
  note_type?: string;
  mastery?: string;
  ai_sections?: Record<string, unknown>;
}

export interface NoteDoc {
  id: string;
  title: string;
  title_norm: string;
  note_type: NoteType;
  mastery: Mastery;
  body_document_id: string | null;
  ai_sections: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

/** The sections a note is prompted for (spec Appendix B). */
export const NOTE_TEMPLATE = [
  "Plain-language explanation",
  "How it works",
  "Example",
  "Common mistakes",
  "My explanation",
  "Where I applied it",
  "Prerequisites and related concepts",
  "Sources",
] as const;

/** Sections that must always be the user's own words, never AI-filled. */
export const USER_ONLY_SECTIONS = ["My explanation", "Where I applied it"] as const;

function parseAiSections(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

function view(row: typeof knowledgeNotes.$inferSelect): NoteDoc {
  return {
    id: row.id, title: row.title, title_norm: row.titleNorm, note_type: row.noteType,
    mastery: row.mastery, body_document_id: row.bodyDocumentId,
    ai_sections: parseAiSections(row.aiSections),
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

export interface NoteListOptions {
  mastery?: string | null;
  note_type?: string | null;
  limit?: number;
}

export async function listNotes(env: Env, userId: string, opts: NoteListOptions = {}): Promise<NoteDoc[]> {
  const filters = [eq(knowledgeNotes.userId, userId)];
  if (opts.mastery) filters.push(eq(knowledgeNotes.mastery, requireEnum(opts.mastery, MASTERY, "mastery")));
  if (opts.note_type) filters.push(eq(knowledgeNotes.noteType, requireEnum(opts.note_type, NOTE_TYPE, "note_type")));
  const rows = await getDb(env).select().from(knowledgeNotes).where(and(...filters))
    .orderBy(desc(knowledgeNotes.updatedAt)).limit(Math.min(opts.limit ?? 100, 500));
  return rows.map(view);
}

export async function getNote(env: Env, userId: string, id: string): Promise<NoteDoc | null> {
  const rows = await getDb(env).select().from(knowledgeNotes)
    .where(and(eq(knowledgeNotes.id, id), eq(knowledgeNotes.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

/** Used by dedupe and by wikilink resolution. */
export async function findNoteByTitle(env: Env, userId: string, title: string): Promise<NoteDoc | null> {
  const rows = await getDb(env).select().from(knowledgeNotes)
    .where(and(eq(knowledgeNotes.titleNorm, normalizeTitle(title)), eq(knowledgeNotes.userId, userId)))
    .limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function createNote(env: Env, userId: string, input: NoteInput): Promise<NoteDoc> {
  const title = requireText(input.title, "title");
  const ts = now();
  const row = {
    id: newId(), userId, title, titleNorm: normalizeTitle(title),
    noteType: (optionalEnum(input.note_type, NOTE_TYPE, "note_type") ?? "concept") as NoteType,
    mastery: (optionalEnum(input.mastery, MASTERY, "mastery") ?? "captured") as Mastery,
    bodyDocumentId: null as string | null,
    aiSections: JSON.stringify(input.ai_sections ?? {}),
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(knowledgeNotes).values(row);
  // A note may have been referenced by [[wikilink]] before it existed.
  await resolveRelationsTo(env, userId, title, "knowledge_note", row.id);
  await audit(env, { userId, subjectType: "knowledge_note", subjectId: row.id, action: "created" });
  return view(row as typeof knowledgeNotes.$inferSelect);
}

export async function updateNote(env: Env, userId: string, id: string, input: NoteInput): Promise<NoteDoc> {
  const current = await getNote(env, userId, id);
  if (!current) throw new NotFoundError(`Note not found: ${id}`);

  const patch: Partial<typeof knowledgeNotes.$inferInsert> = { updatedAt: now() };
  let renamedTo: string | null = null;
  if (input.title !== undefined) {
    const title = requireText(input.title, "title");
    patch.title = title;
    patch.titleNorm = normalizeTitle(title);
    if (normalizeTitle(title) !== current.title_norm) renamedTo = title;
  }
  if (input.note_type !== undefined) patch.noteType = requireEnum(input.note_type, NOTE_TYPE, "note_type");
  if (input.ai_sections !== undefined) patch.aiSections = JSON.stringify(input.ai_sections ?? {});

  const masteryChanged = input.mastery !== undefined
    && requireEnum(input.mastery, MASTERY, "mastery") !== current.mastery;
  if (input.mastery !== undefined) patch.mastery = requireEnum(input.mastery, MASTERY, "mastery");

  await getDb(env).update(knowledgeNotes).set(patch)
    .where(and(eq(knowledgeNotes.id, id), eq(knowledgeNotes.userId, userId)));

  if (renamedTo) await resolveRelationsTo(env, userId, renamedTo, "knowledge_note", id);
  await audit(env, {
    userId, subjectType: "knowledge_note", subjectId: id,
    action: masteryChanged ? "status-changed" : "updated",
    detail: masteryChanged ? { from: current.mastery, to: patch.mastery } : {},
  });
  if (masteryChanged) await track(env, userId, "knowledge_mastery_changed", { from: current.mastery, to: patch.mastery });
  return (await getNote(env, userId, id))!;
}

export async function setNoteDocument(env: Env, userId: string, id: string, documentId: string): Promise<void> {
  await getDb(env).update(knowledgeNotes).set({ bodyDocumentId: documentId, updatedAt: now() })
    .where(and(eq(knowledgeNotes.id, id), eq(knowledgeNotes.userId, userId)));
}

export async function deleteNote(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getNote(env, userId, id);
  if (!current) return false;
  if (current.body_document_id) await deleteDocument(env, current.body_document_id);
  await getDb(env).delete(knowledgeNotes)
    .where(and(eq(knowledgeNotes.id, id), eq(knowledgeNotes.userId, userId)));
  await removeFts(env, id);
  await audit(env, { userId, subjectType: "knowledge_note", subjectId: id, action: "deleted" });
  return true;
}
