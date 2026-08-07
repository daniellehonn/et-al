// et al. v8 — the object model, vocabularies, and the product's rules.
// This is the single place the vocabulary lives; the store and MCP import from it.
//
// v8 has two primitives, page and collection. The seven v7 entity types are not
// gone so much as demoted: what used to be a table is now a collection with a
// `role`, and what used to be a column is now a typed property. The vocabularies
// below (task statuses, source kinds, …) survive as the *option lists* of those
// properties, which is why they still matter.
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
  // Sendblue relays iMessage: Apple ships no API of its own.
  SENDBLUE_API_KEY_ID?: string;
  SENDBLUE_API_SECRET?: string;
  SENDBLUE_WEBHOOK_TOKEN?: string;
  SENDBLUE_OWNER_NUMBER?: string;
  SENDBLUE_FROM_NUMBER?: string;
  // Nudges are scheduled in the user's own time, not UTC.
  TIMEZONE?: string;
  NUDGE_EVENING_HOUR?: string;
  NUDGE_MORNING_HOUR?: string;
  EXTRACT_MODEL?: string;
}

// ---- Entity types & vocabularies --------------------------------------------

export const ENTITY_TYPES = ["page", "collection"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

// A collection's role is what keeps the agent layer alive after the tables went
// away: 'tasks' means "the pages in here are tasks", so list_tasks, weekly_review
// and suggest_daily3 stay meaningful without hard-coding a table. A collection
// with no role is just a collection the user made, and agents treat it generically.
export const COLLECTION_ROLES = ["tasks", "sources", "insights", "decisions"] as const;
export type CollectionRole = (typeof COLLECTION_ROLES)[number];

export const PROPERTY_TYPES = [
  "text", "number", "select", "multi_select", "date", "checkbox", "url", "person", "relation",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const VIEW_TYPES = ["table", "board", "list", "gallery", "calendar"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export const PAGE_STATUSES = ["active", "archived"] as const;

/** One column in a collection's schema. */
export const propertyDef = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(PROPERTY_TYPES),
  options: z.array(z.string()).optional(),
});
export type PropertyDef = z.infer<typeof propertyDef>;

// The property keys the role collections are expected to carry. Agents and the
// typed helpers read these; a user renaming a *column* is fine, renaming a key
// is what would break them, so keys stay stable and only `name` is cosmetic.
export const ROLE_PROPERTY_KEYS = {
  tasks: { status: "status", priority: "priority", due: "due_date", objective: "objective", notes: "notes" },
  sources: { kind: "kind", url: "url", status: "status", captured: "captured" },
  insights: { source: "source_id", isAi: "is_ai" },
  decisions: { decidedOn: "decided_on", impact: "impact" },
} as const;

export const WORKSPACE_TYPES = ["area", "project", "course", "organization"] as const;
// Finite workspaces move idea → active (in progress) → completed (done);
// paused/archived apply to any type.
export const WORKSPACE_STATUSES = ["idea", "active", "paused", "completed", "archived"] as const;
// Finite types have an outcome and can be completed; ongoing types are maintained.
export const FINITE_WORKSPACE_TYPES = ["project", "course"] as const;

export const OBJECTIVE_STATUSES = ["active", "done", "paused"] as const;

export const TASK_STATUSES = ["todo", "doing", "blocked", "done"] as const;

export const DOCUMENT_TYPES = ["design", "architecture", "roadmap", "readme", "note", "free", "overview"] as const;
export const DOCUMENT_STATUSES = ["draft", "active", "archived"] as const;
export const BLOCK_TYPES = [
  // Markdown blocks
  "paragraph", "heading", "bullet", "numbered", "todo", "code", "quote", "divider", "image", "table", "embed", "callout", "toc", "toggle", "columns",
  // An inline collection. content_json is {collection_id}: the collection is
  // *owned* by the page but *positioned* by this block, so a page body and its
  // databases interleave in one order the way Notion's do.
  "collection",
  // A link to another page, rendered inline. content_json is {page_id}.
  "page_link",
  // Live "widget" blocks (compute from workspace data) — a page mixes both freely
  "tasks", "deadlines", "child_progress", "objective_progress", "progress", "backlinks", "metric", "links", "career_summary",
  // Career blocks — structured career capital you recycle into a resume
  "accomplishment", "resume_bullet", "role", "project",
] as const;
// Block types that render a live widget rather than static content.
export const WIDGET_BLOCK_TYPES = [
  "tasks", "deadlines", "child_progress", "objective_progress", "progress", "backlinks", "metric", "links", "career_summary",
] as const;
// Structured career blocks — captured as you work, recycled into resume/LinkedIn.
export const CAREER_BLOCK_TYPES = ["accomplishment", "resume_bullet", "role", "project"] as const;

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

// ---- v8: pages and collections ----------------------------------------------

/** A property value. Kept deliberately loose — the collection's schema says what
 *  a key means, and a property's type can change without rewriting stored rows. */
export const propertyValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);

export const createPageInput = z.object({
  parent_page_id: z.string().nullish(),
  collection_id: z.string().nullish(),
  title: z.string().default(""),
  icon: z.string().nullish(),
  cover: z.string().nullish(),
  properties: z.record(z.string(), propertyValue).default({}),
  position: z.number().optional(),
});

export const updatePageInput = z.object({
  title: z.string().optional(),
  icon: z.string().nullish(),
  cover: z.string().nullish(),
  status: z.enum(PAGE_STATUSES).optional(),
  position: z.number().optional(),
  // Merged into the existing properties rather than replacing them, so setting
  // one property never silently drops the others.
  properties: z.record(z.string(), propertyValue).optional(),
});

export const movePageInput = z.object({
  new_parent_page_id: z.string().nullish(),
  position: z.number().optional(),
});

export const createCollectionInput = z.object({
  parent_page_id: z.string(),
  title: z.string().default(""),
  icon: z.string().nullish(),
  role: z.enum(COLLECTION_ROLES).nullish(),
  schema: z.array(propertyDef).default([]),
  position: z.number().optional(),
});

export const updateCollectionInput = z.object({
  title: z.string().optional(),
  icon: z.string().nullish(),
  schema: z.array(propertyDef).optional(),
});

export const createViewInput = z.object({
  collection_id: z.string(),
  name: z.string().default("Table"),
  type: z.enum(VIEW_TYPES).default("table"),
  filter: z.array(z.object({ key: z.string(), op: z.string(), value: propertyValue })).default([]),
  sort: z.array(z.object({ key: z.string(), dir: z.enum(["asc", "desc"]).default("asc") })).default([]),
  group_by: z.string().nullish(),
  position: z.number().optional(),
  // Pixel width per column key; '__title__' is the name column.
  widths: z.record(z.string(), z.number()).optional(),
});

export const updateViewInput = createViewInput.partial().omit({ collection_id: true });

// ---- v7 inputs (retained where the shape is still the right one) -------------

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
  icon: z.string().nullish(),
  cover: z.string().nullish(),
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
  recurrence: z.string().nullish(),
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
  recurrence: z.string().nullish(),
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
  // `parent` nests the new block under another block (a toggle's contents, a
  // sub-bullet). Omitted means the top level of the page.
  z.object({ op: z.literal("insert"), after: z.string().nullish(), parent: z.string().nullish(), type: z.enum(BLOCK_TYPES), content: z.record(z.string(), z.any()) }),
  z.object({ op: z.literal("update"), id: z.string(), type: z.enum(BLOCK_TYPES).optional(), content: z.record(z.string(), z.any()) }),
  z.object({ op: z.literal("delete"), id: z.string() }),
  z.object({ op: z.literal("move"), id: z.string(), after: z.string().nullish(), parent: z.string().nullish() }),
  // Replace the entire document body from a markdown (or plain-text) string —
  // what an agent most naturally proposes. Parsed into blocks on apply.
  z.object({ op: z.literal("replace_content"), content: z.string() }),
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
