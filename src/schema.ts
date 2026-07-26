// et al. v7 — the object model, per-entity vocabularies, and the product's rules.
// This is the single place the vocabulary lives; the store and MCP import from here.
import { z } from "zod";

// ---- Bindings ----------------------------------------------------------------

export interface Env {
  DB: D1Database;
  VAULT: R2Bucket;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  JOBS?: Queue;
  KV?: KVNamespace;
  ET_AL_API_KEY?: string;
  APP_NAME?: string;
}

// ---- Entity types & vocabularies --------------------------------------------

export const ENTITY_TYPES = [
  "workspace",
  "objective",
  "task",
  "document",
  "source",
  "insight",
  "decision",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const WORKSPACE_TYPES = ["area", "project", "course", "organization"] as const;
export const WORKSPACE_STATUSES = ["active", "paused", "archived"] as const;

export const OBJECTIVE_STATUSES = ["active", "done", "paused"] as const;

export const TASK_STATUSES = ["todo", "doing", "blocked", "done"] as const;

export const DOCUMENT_TYPES = ["design", "architecture", "roadmap", "readme", "note", "free"] as const;
export const DOCUMENT_STATUSES = ["draft", "active", "archived"] as const;
export const BLOCK_TYPES = [
  "paragraph", "heading", "bullet", "numbered", "todo", "code", "quote", "divider", "image",
] as const;

export const SOURCE_KINDS = [
  "note", "idea", "url", "pdf", "youtube", "book", "image", "voice", "github", "email", "document",
] as const;
export const SOURCE_STATUSES = ["inbox", "processing", "processed"] as const;

// Sources whose payload lives inline (no fetch needed) vs. needing async ingest.
export const INLINE_SOURCE_KINDS = ["note", "idea"] as const;

export const RELATIONSHIP_TYPES = [
  "references", "uses", "inspired_by", "generated_from",
  "related_to", "learned_from", "created_from", "depends_on",
] as const;

export const PATCH_STATUSES = ["pending", "accepted", "rejected"] as const;

// ---- Zod input schemas (validation lives with the vocabulary) ---------------

export const createWorkspaceInput = z.object({
  parent_id: z.string().nullish(),
  type: z.enum(WORKSPACE_TYPES).default("area"),
  title: z.string().min(1),
  description: z.string().nullish(),
});

export const updateWorkspaceInput = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullish(),
  type: z.enum(WORKSPACE_TYPES).optional(),
  status: z.enum(WORKSPACE_STATUSES).optional(),
  position: z.number().optional(),
});

export const createObjectiveInput = z.object({
  workspace_id: z.string(),
  parent_objective_id: z.string().nullish(),
  title: z.string().min(1),
  description: z.string().nullish(),
  priority: z.number().int().min(0).max(3).default(1),
});

export const updateObjectiveInput = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullish(),
  status: z.enum(OBJECTIVE_STATUSES).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  position: z.number().optional(),
});

export const createTaskInput = z.object({
  workspace_id: z.string(),
  objective_id: z.string().nullish(),
  title: z.string().min(1),
  notes: z.string().nullish(),
  priority: z.number().int().min(0).max(3).default(1),
  due_date: z.number().int().nullish(),
  estimate_min: z.number().int().nullish(),
});

export const updateTaskInput = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().nullish(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  due_date: z.number().int().nullish(),
  estimate_min: z.number().int().nullish(),
  objective_id: z.string().nullish(),
  position: z.number().optional(),
});

export const captureInput = z.object({
  kind: z.enum(SOURCE_KINDS),
  title: z.string().nullish(),
  url: z.string().url().nullish(),
  raw: z.string().nullish(),
  workspace_id: z.string().nullish(),
});

export const createInsightInput = z.object({
  workspace_id: z.string().nullish(),
  title: z.string().min(1),
  body: z.string().min(1),
  source_id: z.string().nullish(),
});

export const recordDecisionInput = z.object({
  workspace_id: z.string(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(z.string()).nullish(),
  impact: z.string().nullish(),
  decided_on: z.number().int().nullish(),
});

export const relateInput = z.object({
  source_type: z.enum(ENTITY_TYPES),
  source_id: z.string(),
  target_type: z.enum(ENTITY_TYPES),
  target_id: z.string(),
  type: z.enum(RELATIONSHIP_TYPES),
});

export const createDocumentInput = z.object({
  workspace_id: z.string(),
  title: z.string().min(1),
  type: z.enum(DOCUMENT_TYPES).default("free"),
});

// One block operation in a patch or a direct write.
export const blockOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), after: z.string().nullish(), type: z.enum(BLOCK_TYPES), content: z.record(z.string(), z.any()) }),
  z.object({ op: z.literal("update"), id: z.string(), type: z.enum(BLOCK_TYPES).optional(), content: z.record(z.string(), z.any()) }),
  z.object({ op: z.literal("delete"), id: z.string() }),
  z.object({ op: z.literal("move"), id: z.string(), after: z.string().nullish() }),
]);
export type BlockOp = z.infer<typeof blockOp>;

export const proposePatchInput = z.object({
  document_id: z.string(),
  ops: z.array(blockOp).min(1),
  summary: z.string().min(1),
});

export const setDaily3Input = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  task_ids: z.array(z.string()).max(3),
});
