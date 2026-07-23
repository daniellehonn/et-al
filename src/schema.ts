// v6 schema: the typed object model, defined once and shared by the store, the
// API, and the MCP tools.
//
// Two things live here and nowhere else:
//   1. Drizzle table definitions mirroring migrations/0007_v6_schema.sql. The
//      migration is still the source of truth for the database; these must be
//      kept in step with it by hand (drizzle-kit is used for typing, not for
//      generating our migrations).
//   2. The per-type lifecycle vocabularies. v5 forced one `type`/`status` pair
//      onto every object; v6 gives each entity its own enum, because a tool test
//      and a job application do not share a lifecycle.
//
// Runtime-free: no Cloudflare or DOM imports, so it stays unit-testable with
// `node --experimental-strip-types` like markdown.ts.

import { sqliteTable, text, integer, real, primaryKey, index } from "drizzle-orm/sqlite-core";

export const SCHEMA_VERSION = 6;

// ---------------------------------------------------------------------------
// Lifecycle vocabularies (one per type — see docs/v6-implementation-plan.md §3)
// ---------------------------------------------------------------------------

export const AREA_STATUS = ["active", "inactive"] as const;
export const GOAL_TYPE = ["outcome", "habit", "identity"] as const;
export const GOAL_TIMEFRAME = ["quarter", "year", "long-term"] as const;
export const GOAL_STATUS = ["active", "paused", "completed"] as const;

/** Deliberately explicit: an `active` project must carry a next action. */
export const PROJECT_STATUS = ["idea", "planned", "active", "paused", "completed", "archived"] as const;
export const PRIORITY = ["low", "medium", "high"] as const;

export const LOG_ENTRY_TYPE = ["progress", "decision", "experiment", "problem", "learning", "reflection"] as const;
export const CONTENT_SEED_STATUS = ["none", "suggested", "created"] as const;

export const NOTE_TYPE = ["concept", "how-to", "reference", "comparison", "question", "mental-model"] as const;
export const MASTERY = ["captured", "learning", "understood", "applied"] as const;

export const CAPTURE_INPUT_TYPE = ["text", "url", "image", "audio", "file"] as const;
export const PROCESSING_STATUS = ["unprocessed", "processing", "ready", "failed"] as const;
export const CLASSIFICATION = ["project-idea", "tool", "knowledge", "content-idea", "task", "reference", "other"] as const;
export const REVIEW_STATUS = ["pending", "accepted", "partially-accepted", "dismissed"] as const;

export const BUNDLE_STATUS = ["pending", "applied", "partially-applied", "dismissed"] as const;
export const CHANGE_KIND = ["create", "update", "relate"] as const;
export const CHANGE_REVIEW_STATUS = ["pending", "accepted", "edited", "rejected", "auto-applied"] as const;

export const TOOL_STATUS = ["saved", "shortlisted", "testing", "tested", "adopted", "rejected"] as const;
/** A written verdict is required before a tool may reach any of these. */
export const TOOL_VERDICT_REQUIRED: readonly ToolStatus[] = ["tested", "adopted", "rejected"];

export const SOURCE_PLATFORM = ["youtube", "tiktok", "instagram", "article", "paper", "book", "podcast", "other"] as const;

export const CONTENT_STATUS = ["idea", "draft", "review", "scheduled", "published", "archived"] as const;
export const CONTENT_FORMAT = ["short-post", "thread", "video", "article", "newsletter", "case-study"] as const;
export const CONTENT_CHANNEL = ["linkedin", "x", "medium", "substack", "youtube", "instagram", "tiktok", "portfolio"] as const;

/** Generic blocks first, then the product-specific ones (spec §2.12). */
export const BLOCK_TYPE = [
  "paragraph", "heading", "bullet", "todo", "todo-done", "code", "quote", "callout", "image", "table",
  "decision", "experiment", "learning", "content-seed", "relation", "tool-card", "log-ref",
] as const;

export const RELATION_TYPE = [
  "learned-from", "used-in", "prerequisite-of", "inspired-by", "created-from", "mentions",
] as const;

/** Every entity that can own a document or be related/searched. */
export const SUBJECT_TYPE = [
  "area", "goal", "project", "project_log", "knowledge_note", "capture", "tool", "source", "content_item",
] as const;

export const JOB_TYPE = ["fetch", "transcribe", "extract", "embed", "export"] as const;
export const JOB_STATUS = ["queued", "running", "succeeded", "failed"] as const;
export const AUDIT_ACTOR = ["user", "ai", "system"] as const;

export type AreaStatus = (typeof AREA_STATUS)[number];
export type GoalType = (typeof GOAL_TYPE)[number];
export type GoalStatus = (typeof GOAL_STATUS)[number];
export type ProjectStatus = (typeof PROJECT_STATUS)[number];
export type Priority = (typeof PRIORITY)[number];
export type LogEntryType = (typeof LOG_ENTRY_TYPE)[number];
export type NoteType = (typeof NOTE_TYPE)[number];
export type Mastery = (typeof MASTERY)[number];
export type CaptureInputType = (typeof CAPTURE_INPUT_TYPE)[number];
export type ProcessingStatus = (typeof PROCESSING_STATUS)[number];
export type Classification = (typeof CLASSIFICATION)[number];
export type ReviewStatus = (typeof REVIEW_STATUS)[number];
export type ToolStatus = (typeof TOOL_STATUS)[number];
export type SourcePlatform = (typeof SOURCE_PLATFORM)[number];
export type ContentStatus = (typeof CONTENT_STATUS)[number];
export type BlockType = (typeof BLOCK_TYPE)[number];
export type RelationType = (typeof RELATION_TYPE)[number];
export type SubjectType = (typeof SUBJECT_TYPE)[number];
export type JobType = (typeof JOB_TYPE)[number];

// ---------------------------------------------------------------------------
// Tables (mirror of migration 0007)
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  name: text("name"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const areas = sqliteTable("areas", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon"),
  accent: text("accent"),
  status: text("status").$type<AreaStatus>().notNull().default("active"),
  sort: integer("sort"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  areaId: text("area_id"),
  title: text("title").notNull(),
  type: text("type").$type<GoalType>().notNull().default("outcome"),
  timeframe: text("timeframe").$type<(typeof GOAL_TIMEFRAME)[number] | null>(),
  metricName: text("metric_name"),
  targetValue: real("target_value"),
  currentValue: real("current_value"),
  status: text("status").$type<GoalStatus>().notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  status: text("status").$type<ProjectStatus>().notNull().default("idea"),
  priority: text("priority").$type<Priority | null>(),
  nextAction: text("next_action"),
  startDate: integer("start_date"),
  targetDate: integer("target_date"),
  repositoryUrl: text("repository_url"),
  liveUrl: text("live_url"),
  coverAssetId: text("cover_asset_id"),
  bodyDocumentId: text("body_document_id"),
  portfolioReady: integer("portfolio_ready").notNull().default(0),
  lastActivityAt: integer("last_activity_at"),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const projectAreas = sqliteTable("project_areas", {
  projectId: text("project_id").notNull(),
  areaId: text("area_id").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.areaId] })]);

export const projectGoals = sqliteTable("project_goals", {
  projectId: text("project_id").notNull(),
  goalId: text("goal_id").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.goalId] })]);

export const projectLogs = sqliteTable("project_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  entryType: text("entry_type").$type<LogEntryType>().notNull().default("progress"),
  title: text("title"),
  bodyDocumentId: text("body_document_id"),
  contentSeedStatus: text("content_seed_status")
    .$type<(typeof CONTENT_SEED_STATUS)[number]>().notNull().default("none"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("idx_logs_project").on(t.projectId, t.createdAt)]);

export const knowledgeNotes = sqliteTable("knowledge_notes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  titleNorm: text("title_norm").notNull(),
  noteType: text("note_type").$type<NoteType>().notNull().default("concept"),
  mastery: text("mastery").$type<Mastery>().notNull().default("captured"),
  bodyDocumentId: text("body_document_id"),
  aiSections: text("ai_sections").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const captures = sqliteTable("captures", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** Write-once. Processing must never mutate this. */
  rawInput: text("raw_input").notNull(),
  inputType: text("input_type").$type<CaptureInputType>().notNull().default("text"),
  sourceUrl: text("source_url"),
  platform: text("platform"),
  assetId: text("asset_id"),
  processingStatus: text("processing_status").$type<ProcessingStatus>().notNull().default("unprocessed"),
  processingError: text("processing_error"),
  classification: text("classification").$type<Classification | null>(),
  reviewStatus: text("review_status").$type<ReviewStatus>().notNull().default("pending"),
  proposalBundleId: text("proposal_bundle_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const proposalBundles = sqliteTable("proposal_bundles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  captureId: text("capture_id"),
  status: text("status").$type<(typeof BUNDLE_STATUS)[number]>().notNull().default("pending"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  schemaVersion: text("schema_version"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const proposedChanges = sqliteTable("proposed_changes", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull(),
  changeKind: text("change_kind").$type<(typeof CHANGE_KIND)[number]>().notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  payload: text("payload").notNull().default("{}"),
  confidence: real("confidence"),
  /** Only metadata-only changes are ever eligible for auto-apply. */
  isMetadataOnly: integer("is_metadata_only").notNull().default(0),
  duplicateOfId: text("duplicate_of_id"),
  reviewStatus: text("review_status")
    .$type<(typeof CHANGE_REVIEW_STATUS)[number]>().notNull().default("pending"),
  appliedAt: integer("applied_at"),
  createdAt: integer("created_at").notNull(),
});

export const tools = sqliteTable("tools", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  url: text("url"),
  status: text("status").$type<ToolStatus>().notNull().default("saved"),
  expectedUse: text("expected_use"),
  testCriteria: text("test_criteria"),
  verdict: text("verdict"),
  rating: integer("rating"),
  sourceId: text("source_id"),
  testedAt: integer("tested_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  url: text("url"),
  platform: text("platform").$type<SourcePlatform>().notNull().default("other"),
  author: text("author"),
  publishedAt: integer("published_at"),
  transcript: text("transcript"),
  /** AI-generated; must be labeled as such in the UI. */
  summary: text("summary"),
  captureId: text("capture_id"),
  processingVersion: text("processing_version"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const contentItems = sqliteTable("content_items", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  status: text("status").$type<ContentStatus>().notNull().default("idea"),
  format: text("format").$type<(typeof CONTENT_FORMAT)[number] | null>(),
  channel: text("channel").$type<(typeof CONTENT_CHANNEL)[number] | null>(),
  hook: text("hook"),
  audience: text("audience"),
  bodyDocumentId: text("body_document_id"),
  publishedUrl: text("published_url"),
  publishedAt: integer("published_at"),
  scheduledFor: integer("scheduled_for"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  ownerType: text("owner_type").$type<SubjectType>().notNull(),
  ownerId: text("owner_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const documentBlocks = sqliteTable("document_blocks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  position: integer("position").notNull(),
  type: text("type").$type<BlockType>().notNull(),
  text: text("text").notNull().default(""),
  data: text("data").notNull().default("{}"),
  /** AI-generated blocks are labeled, never silently indistinguishable. */
  isAi: integer("is_ai").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("idx_blocks_doc").on(t.documentId, t.position)]);

export const relations = sqliteTable("relations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sourceType: text("source_type").$type<SubjectType>().notNull(),
  sourceId: text("source_id").notNull(),
  targetType: text("target_type").$type<SubjectType | null>(),
  /** NULL until an unresolved [[wikilink]] target is created. */
  targetId: text("target_id"),
  targetNorm: text("target_norm"),
  relationType: text("relation_type").$type<RelationType>().notNull(),
  context: text("context").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  r2Key: text("r2_key").notNull(),
  filename: text("filename"),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  createdAt: integer("created_at").notNull(),
});

export const processingJobs = sqliteTable("processing_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** Idempotency key: a retried message must not duplicate output. */
  jobKey: text("job_key").notNull().unique(),
  jobType: text("job_type").$type<JobType>().notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  status: text("status").$type<(typeof JOB_STATUS)[number]>().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  failureStage: text("failure_stage"),
  error: text("error"),
  durationMs: integer("duration_ms"),
  tokenUsage: integer("token_usage"),
  version: text("version"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const embeddings = sqliteTable("embeddings", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  subjectType: text("subject_type").$type<SubjectType>().notNull(),
  subjectId: text("subject_id").notNull(),
  vectorId: text("vector_id").notNull(),
  model: text("model").notNull(),
  contentHash: text("content_hash"),
  createdAt: integer("created_at").notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  action: text("action").notNull(),
  actor: text("actor").$type<(typeof AUDIT_ACTOR)[number]>().notNull().default("user"),
  bundleId: text("bundle_id"),
  changeId: text("change_id"),
  detail: text("detail").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// Schema description, served at /api/schema and to MCP clients
// ---------------------------------------------------------------------------

export const SCHEMA_INFO = {
  version: SCHEMA_VERSION,
  storage: "D1 is canonical. R2 holds assets and Markdown exports. Vectorize holds embeddings.",
  principle: "Transformation over collection: every object supports a next step.",
  entities: {
    area: { status: AREA_STATUS },
    goal: { type: GOAL_TYPE, timeframe: GOAL_TIMEFRAME, status: GOAL_STATUS },
    project: { status: PROJECT_STATUS, priority: PRIORITY, rule: "an active project requires a next_action" },
    project_log: { entry_type: LOG_ENTRY_TYPE, content_seed_status: CONTENT_SEED_STATUS },
    knowledge_note: { note_type: NOTE_TYPE, mastery: MASTERY },
    capture: { input_type: CAPTURE_INPUT_TYPE, processing_status: PROCESSING_STATUS, review_status: REVIEW_STATUS },
    tool: { status: TOOL_STATUS, rule: "a written verdict is required before tested/adopted/rejected" },
    source: { platform: SOURCE_PLATFORM },
    content_item: { status: CONTENT_STATUS, format: CONTENT_FORMAT, channel: CONTENT_CHANNEL },
  },
  structures: {
    area: "identity / responsibility — a filter and context, not a workspace",
    goal: "why a project matters; projects may serve several goals and areas",
    relation: "semantic edges (learned-from, used-in, ...) between any two objects",
    document: "ordered blocks; expressive writing lives here, metadata lives in tables",
  },
  ai: "AI proposes, the user approves. Canonical records are never written without review; only high-confidence metadata may auto-apply.",
} as const;
