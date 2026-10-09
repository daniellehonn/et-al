// et al. — bindings, vocabularies, and input validation.
// This is the one place the vocabulary lives; the store and MCP import from it.
import { z } from "zod";

// ---- Bindings ----------------------------------------------------------------

export interface Env {
  DB: D1Database;
  VAULT: R2Bucket;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  JOBS?: Queue<Job>;
  ET_AL_API_KEY?: string;
  APP_NAME?: string;
  EXTRACT_MODEL?: string;
}

/** Background work. Ingest fetches a captured link; embed indexes a note by meaning. */
export type Job =
  | { type: "ingest_source"; source_id: string }
  | { type: "embed_note"; note_id: string };

// ---- Vocabularies -------------------------------------------------------------

export const ENTITY_TYPES = ["note", "task", "source", "proposal"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** The block types a note body is made of: markdown, plus a link to another note. */
export const BLOCK_TYPES = [
  "paragraph", "heading", "bullet", "numbered", "todo", "code", "quote", "divider", "image", "table", "page_link",
] as const;

export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export const SOURCE_STATUSES = ["inbox", "done"] as const;
export const PROPOSAL_KINDS = ["patch", "insight"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

// ---- Notes ---------------------------------------------------------------------

export const createNoteInput = z.object({
  parent_id: z.string().nullish(),
  title: z.string().default(""),
  // Optional markdown body. Only the human surface may pass one: agents create a
  // note's body by proposing a patch to it (see mcp.ts).
  body: z.string().optional(),
});

export const updateNoteInput = z.object({
  title: z.string(),
});

export const moveNoteInput = z.object({
  parent_id: z.string().nullish(),
  position: z.number().optional(),
});

// One block operation in a patch or a direct write.
export const blockOp = z.discriminatedUnion("op", [
  // `parent` nests the new block under another block (a sub-bullet). Omitted
  // means the top level of the note.
  z.object({ op: z.literal("insert"), after: z.string().nullish(), parent: z.string().nullish(), type: z.enum(BLOCK_TYPES), content: z.record(z.string(), z.any()) }),
  z.object({ op: z.literal("update"), id: z.string(), type: z.enum(BLOCK_TYPES).optional(), content: z.record(z.string(), z.any()) }),
  z.object({ op: z.literal("delete"), id: z.string() }),
  z.object({ op: z.literal("move"), id: z.string(), after: z.string().nullish(), parent: z.string().nullish() }),
  // Replace the entire body from markdown — what an agent most naturally proposes.
  z.object({ op: z.literal("replace_content"), content: z.string() }),
]);
export type BlockOp = z.infer<typeof blockOp>;

/** A whole body as the editor holds it, reconciled against the stored blocks by id. */
export const blockTree = z.array(z.object({
  id: z.string().min(1),
  parent_block_id: z.string().nullable(),
  type: z.string().min(1),
  content: z.record(z.string(), z.any()),
  position: z.number(),
}));

// ---- Tasks ---------------------------------------------------------------------

export const createTaskInput = z.object({
  title: z.string().min(1),
  parent_id: z.string().nullish(),
  note_id: z.string().nullish(),
  due_at: z.number().int().nullish(),
});

export const updateTaskInput = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  due_at: z.number().int().nullish(),
  note_id: z.string().nullish(),
});

// ---- Sources -------------------------------------------------------------------

export const captureInput = z.object({
  title: z.string().nullish(),
  url: z.string().url().nullish(),
  text: z.string().nullish(),
  note_id: z.string().nullish(),
}).refine((d) => d.title?.trim() || d.url || d.text?.trim(), { message: "nothing to capture: pass a title, url or text" });

export const fileSourceInput = z.object({
  note_id: z.string().nullish(),
  title: z.string().optional(),
  status: z.enum(SOURCE_STATUSES).optional(),
});

// ---- Proposals -----------------------------------------------------------------

export const proposePatchInput = z.object({
  note_id: z.string(),
  ops: z.array(blockOp).min(1),
  summary: z.string().min(1),
});

/** What the extractor proposes from a source. */
export const insightPayload = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  segment: z.string(),
  importance: z.number(),
});
export type InsightPayload = z.infer<typeof insightPayload>;
