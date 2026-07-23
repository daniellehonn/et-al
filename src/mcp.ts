// MCP surface — v6.
//
// The v5 tools spoke one generic "page" vocabulary. v6 exposes the typed model
// instead, because the tool descriptions are how an agent learns the product's
// rules: an active project needs a next action, a tool needs a written verdict,
// AI must not write canonical records without review. Encoding those in the
// schema and the descriptions is what keeps agent-written data trustworthy.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SCHEMA_INFO,
  PROJECT_STATUS, PRIORITY, GOAL_TYPE, GOAL_TIMEFRAME, GOAL_STATUS,
  LOG_ENTRY_TYPE, NOTE_TYPE, MASTERY, TOOL_STATUS, SOURCE_PLATFORM,
  CONTENT_STATUS, CONTENT_FORMAT, CONTENT_CHANNEL, RELATION_TYPE, SUBJECT_TYPE,
  CAPTURE_INPUT_TYPE, CLASSIFICATION,
} from "./schema.ts";
import * as store from "./store/index.ts";
import type { Env } from "./store/index.ts";
import { getHome, getReview } from "./api.ts";
import { getIdentityStudio, getCompletionChecklist } from "./identity.ts";
import { buildExport, writeSnapshot } from "./export.ts";
import { getMetrics } from "./analytics.ts";

function mcpJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Wraps a handler so validation failures come back as readable tool output. */
function guard<T>(fn: (input: T) => Promise<unknown>) {
  return async (input: T) => {
    try { return mcpJson(await fn(input)); } catch (error) {
      return mcpJson({ error: error instanceof Error ? error.message : "Unknown error" });
    }
  };
}

export function createEtAlMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "et-al", version: "0.6.0" });
  const user = () => store.ensureUser(env);

  server.registerTool("get_schema", {
    description:
      "The canonical et al. object model (v6): entities, their per-type lifecycle vocabularies, and the storage model. " +
      "Call this first when unsure what to write. Key rules: an ACTIVE project must have a next_action; a tool needs a " +
      "written verdict before tested/adopted/rejected; captures are immutable.",
    inputSchema: {},
  }, guard(async () => SCHEMA_INFO));

  // ---- orientation ----
  server.registerTool("get_home", {
    description:
      "What matters now: active projects and their next actions, stale projects, projects missing a next action, " +
      "inbox count, tools awaiting a verdict, recent learning, and content opportunities. Start here to orient.",
    inputSchema: {},
  }, guard(async () => getHome(env, await user())));

  server.registerTool("get_weekly_review", {
    description:
      "The guided weekly review as an ordered list of steps, each carrying its items: process captures, review stalled " +
      "projects, confirm next actions, check tools in testing, promote learning, review content seeds, check balance.",
    inputSchema: {},
  }, guard(async () => getReview(env, await user())));

  // ---- capture ----
  server.registerTool("capture", {
    description:
      "Save a raw thought, link, or note immediately, before deciding where it belongs. The raw input is stored " +
      "immutably and never modified by later processing. This is the low-friction entry point — prefer it over " +
      "creating a typed record when the destination is not yet obvious.",
    inputSchema: {
      raw_input: z.string().min(1).describe("Exactly what the user said or pasted"),
      input_type: z.enum(CAPTURE_INPUT_TYPE).optional().describe("Auto-detected from the text when omitted"),
      source_url: z.string().nullable().optional(),
    },
  }, guard(async (input) => store.createCapture(env, await user(), input)));

  server.registerTool("list_inbox", {
    description: "Captures still awaiting review — the inbox queue.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, guard(async ({ limit }) => ({ inbox: await store.listInbox(env, await user(), limit ?? 50) })));

  server.registerTool("get_capture_status", {
    description:
      "Processing state for a capture and its jobs. A capture whose fetch failed is still fully reviewable — " +
      "the raw input is always preserved — so report the failure rather than treating the capture as lost.",
    inputSchema: { capture_id: z.string().min(1) },
  }, guard(async ({ capture_id }) => {
    const u = await user();
    const capture = await store.getCapture(env, u, capture_id);
    if (!capture) return { error: "Capture not found" };
    return { capture, jobs: await store.listJobs(env, u, { subject_id: capture_id }) };
  }));

  server.registerTool("retry_capture", {
    description:
      "Re-run processing for a capture whose fetch failed. Never creates a duplicate capture or a duplicate " +
      "downstream record — the existing job is reset rather than a new one enqueued.",
    inputSchema: { capture_id: z.string().min(1) },
  }, guard(async ({ capture_id }) => store.resetForRetry(env, await user(), capture_id)));

  // ---- areas & goals ----
  server.registerTool("triage_capture", {
    description:
      "Resolve a capture in the inbox. Set review_status to 'accepted' once you have created whatever it should " +
      "become (a note, tool, project, or source), or 'dismissed' if it needs nothing. The raw capture is kept " +
      "either way as the anchor its provenance points back to — triage never deletes the original.",
    inputSchema: {
      capture_id: z.string().min(1),
      review_status: z.enum(["accepted", "partially-accepted", "dismissed"]),
      classification: z.enum(CLASSIFICATION).optional().describe("What this capture turned out to be"),
    },
  }, guard(async ({ capture_id, ...updates }) => store.updateCapture(env, await user(), capture_id, updates)));

  server.registerTool("get_agent_activity", {
    description:
      "What has been created or changed by an agent (actor='ai'), newest first. Every write made through this " +
      "MCP server is attributed automatically, so this is the honest record of what you did on the user's behalf.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, guard(async ({ limit }) => ({ activity: await store.listAgentActivity(env, await user(), limit ?? 50) })));

  server.registerTool("list_areas", {
    description: "Life Areas — long-term identities and responsibilities. Areas are filters and context, not folders; a project may belong to several.",
    inputSchema: {},
  }, guard(async () => ({ areas: await store.listAreas(env, await user()) })));

  server.registerTool("create_area", {
    description: "Create a Life Area (e.g. 'Software Development', 'Student').",
    inputSchema: {
      name: z.string().min(1),
      description: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      accent: z.string().nullable().optional(),
    },
  }, guard(async (input) => store.createArea(env, await user(), input)));

  server.registerTool("list_goals", {
    description: "Goals — measurable direction inside an Area. They answer why a project matters.",
    inputSchema: { area_id: z.string().optional(), status: z.enum(GOAL_STATUS).optional() },
  }, guard(async (opts) => ({ goals: await store.listGoals(env, await user(), opts) })));

  server.registerTool("create_goal", {
    description: "Create a goal inside an Area.",
    inputSchema: {
      title: z.string().min(1),
      area_id: z.string().nullable().optional(),
      type: z.enum(GOAL_TYPE).optional(),
      timeframe: z.enum(GOAL_TIMEFRAME).nullable().optional(),
      metric_name: z.string().nullable().optional(),
      target_value: z.number().nullable().optional(),
    },
  }, guard(async (input) => store.createGoal(env, await user(), input)));

  // ---- projects ----
  server.registerTool("list_projects", {
    description: "Projects, optionally filtered by status, area, or goal. Default ordering is most recently updated.",
    inputSchema: {
      status: z.enum(PROJECT_STATUS).optional(),
      area_id: z.string().optional(),
      goal_id: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, guard(async (opts) => ({ projects: await store.listProjects(env, await user(), opts) })));

  server.registerTool("get_project", {
    description: "One project with its area and goal membership.",
    inputSchema: { id: z.string().min(1) },
  }, guard(async ({ id }) => (await store.getProject(env, await user(), id)) ?? { error: "Project not found" }));

  server.registerTool("create_project", {
    description:
      "Create a project. IMPORTANT: if you set status to 'active' you MUST also give a next_action — the next physical, " +
      "visible step. Use 'idea' or 'planned' when that step is not known yet. A project may serve several areas and goals.",
    inputSchema: {
      title: z.string().min(1),
      summary: z.string().nullable().optional().describe("One-sentence outcome"),
      status: z.enum(PROJECT_STATUS).optional(),
      next_action: z.string().nullable().optional().describe("Required when status is 'active'"),
      priority: z.enum(PRIORITY).nullable().optional(),
      area_ids: z.array(z.string()).optional(),
      goal_ids: z.array(z.string()).optional(),
      target_date: z.union([z.number(), z.string()]).nullable().optional(),
      repository_url: z.string().nullable().optional(),
    },
  }, guard(async (input) => store.createProject(env, await user(), input)));

  server.registerTool("update_project", {
    description:
      "Update a project, including advancing its status. Activating a project without a next_action is rejected. " +
      "Completing one stamps completed_at and should be followed by a retrospective log entry.",
    inputSchema: {
      id: z.string().min(1),
      title: z.string().optional(),
      summary: z.string().nullable().optional(),
      status: z.enum(PROJECT_STATUS).optional(),
      next_action: z.string().nullable().optional(),
      priority: z.enum(PRIORITY).nullable().optional(),
      area_ids: z.array(z.string()).optional(),
      goal_ids: z.array(z.string()).optional(),
      portfolio_ready: z.boolean().optional(),
      live_url: z.string().nullable().optional(),
    },
  }, guard(async ({ id, ...updates }) => store.updateProject(env, await user(), id, updates)));

  server.registerTool("list_stale_projects", {
    description: "Active projects with no recent activity — the work that has quietly stalled.",
    inputSchema: { days: z.number().int().min(1).max(365).optional() },
  }, guard(async ({ days }) => ({ stale: await store.listStaleProjects(env, await user(), days ?? 14) })));

  // ---- engineer log ----
  server.registerTool("add_log", {
    description:
      "Add an entry to a project's engineer log. Entry types shape what to record: decision (rationale + alternatives), " +
      "experiment (hypothesis/method/result/next test), problem, learning, reflection, or plain progress. " +
      "Logging also marks the project as active work, keeping it out of the stale list.",
    inputSchema: {
      project_id: z.string().min(1),
      entry_type: z.enum(LOG_ENTRY_TYPE).optional(),
      title: z.string().nullable().optional(),
    },
  }, guard(async (input) => store.createLog(env, await user(), input)));

  server.registerTool("list_logs", {
    description: "Log entries, newest first. Filter by project or entry type.",
    inputSchema: {
      project_id: z.string().optional(),
      entry_type: z.enum(LOG_ENTRY_TYPE).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, guard(async (opts) => ({ logs: await store.listLogs(env, await user(), opts) })));

  // ---- knowledge ----
  server.registerTool("list_notes", {
    description: "Knowledge notes, filterable by mastery (captured/learning/understood/applied) or note type.",
    inputSchema: {
      mastery: z.enum(MASTERY).optional(),
      note_type: z.enum(NOTE_TYPE).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, guard(async (opts) => ({ notes: await store.listNotes(env, await user(), opts) })));

  server.registerTool("create_note", {
    description:
      "Create a knowledge note. Mastery starts at 'captured' and advances only when the user can explain it themselves — " +
      "do not set 'understood' or 'applied' on the user's behalf. Any prose you generate must be recorded in ai_sections " +
      "so it can be labeled; never present it as the user's own explanation.",
    inputSchema: {
      title: z.string().min(1),
      note_type: z.enum(NOTE_TYPE).optional(),
      mastery: z.enum(MASTERY).optional(),
      ai_sections: z.record(z.string(), z.unknown()).optional().describe("Which sections were AI-generated"),
    },
  }, guard(async (input) => store.createNote(env, await user(), input)));

  server.registerTool("update_note", {
    description: "Update a note, including advancing its mastery.",
    inputSchema: {
      id: z.string().min(1),
      title: z.string().optional(),
      note_type: z.enum(NOTE_TYPE).optional(),
      mastery: z.enum(MASTERY).optional(),
    },
  }, guard(async ({ id, ...updates }) => store.updateNote(env, await user(), id, updates)));

  // ---- tools (test later) ----
  server.registerTool("get_note", {
    description: "One knowledge note with its mastery and which sections are AI-generated.",
    inputSchema: { id: z.string().min(1) },
  }, guard(async ({ id }) => (await store.getNote(env, await user(), id)) ?? { error: "Note not found" }));

  server.registerTool("find_note_by_title", {
    description:
      "Look up a note by exact title before creating one. Use this to avoid duplicates — the same concept " +
      "written twice under slightly different titles is the main way a knowledge base rots.",
    inputSchema: { title: z.string().min(1) },
  }, guard(async ({ title }) =>
    (await store.findNoteByTitle(env, await user(), title)) ?? { found: false }));

  server.registerTool("list_tools", {
    description: "Saved tools and their test lifecycle state.",
    inputSchema: { status: z.enum(TOOL_STATUS).optional() },
  }, guard(async (opts) => ({ tools: await store.listTools(env, await user(), opts) })));

  server.registerTool("save_tool", {
    description:
      "Save a tool to test later. Include expected_use ('why might this be useful?') whenever the user hints at it — " +
      "shortlisting requires it, and a saved tool without a purpose tends to become a dead bookmark.",
    inputSchema: {
      name: z.string().min(1),
      url: z.string().nullable().optional(),
      expected_use: z.string().nullable().optional(),
      status: z.enum(TOOL_STATUS).optional(),
      source_id: z.string().nullable().optional(),
    },
  }, guard(async (input) => store.createTool(env, await user(), input)));

  server.registerTool("update_tool", {
    description:
      "Advance a tool through its lifecycle. A written verdict is REQUIRED before tested, adopted, or rejected — " +
      "what worked, what failed, would you use it again. A rating alone is not a verdict.",
    inputSchema: {
      id: z.string().min(1),
      status: z.enum(TOOL_STATUS).optional(),
      expected_use: z.string().nullable().optional(),
      test_criteria: z.string().nullable().optional(),
      verdict: z.string().nullable().optional(),
      rating: z.number().int().min(1).max(5).nullable().optional(),
    },
  }, guard(async ({ id, ...updates }) => store.updateTool(env, await user(), id, updates)));

  // ---- sources & content ----
  server.registerTool("create_source", {
    description: "Record external material the user consumed (video, article, paper, podcast). Distinct from the knowledge made from it.",
    inputSchema: {
      title: z.string().min(1),
      url: z.string().nullable().optional(),
      platform: z.enum(SOURCE_PLATFORM).optional(),
      author: z.string().nullable().optional(),
      summary: z.string().nullable().optional().describe("AI-generated summaries are labeled as such"),
    },
  }, guard(async (input) => store.createSource(env, await user(), input)));

  server.registerTool("list_sources", {
    description:
      "External material already ingested — videos, articles, papers. Each carries the title, author, and " +
      "fetched text. Use this to find something to digest into knowledge notes.",
    inputSchema: { platform: z.enum(SOURCE_PLATFORM).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, guard(async (opts) => ({ sources: await store.listSources(env, await user(), opts) })));

  server.registerTool("get_source", {
    description:
      "One source INCLUDING its fetched transcript or article text. This is the raw material for writing " +
      "knowledge notes from a video or article. The text was fetched deterministically; any summary you write " +
      "from it is yours and must be recorded as an AI section on the note, not passed off as the user's words.",
    inputSchema: { id: z.string().min(1) },
  }, guard(async ({ id }) => (await store.getSource(env, await user(), id)) ?? { error: "Source not found" }));

  server.registerTool("list_content", {
    description: "Content items from idea through published.",
    inputSchema: { status: z.enum(CONTENT_STATUS).optional() },
  }, guard(async (opts) => ({ content: await store.listContent(env, await user(), opts) })));

  server.registerTool("create_content_seed", {
    description:
      "Turn real work into a content starting point, preserving provenance. Pass the origin (a project log, tested tool, " +
      "note, or project) so the draft is grounded in actual evidence rather than starting from a blank page.",
    inputSchema: {
      title: z.string().min(1),
      origin_type: z.enum(SUBJECT_TYPE).describe("What this content came from"),
      origin_id: z.string().min(1),
      hook: z.string().nullable().optional(),
      audience: z.string().nullable().optional(),
      format: z.enum(CONTENT_FORMAT).nullable().optional(),
      channel: z.enum(CONTENT_CHANNEL).nullable().optional(),
    },
  }, guard(async ({ origin_type, origin_id, ...input }) =>
    store.createSeedFrom(env, await user(), { type: origin_type, id: origin_id }, input)));

  server.registerTool("update_content", {
    description:
      "Update a content item, including moving it along idea -> draft -> review -> scheduled -> published. " +
      "Marking something published REQUIRES a published_url: claiming work shipped without evidence is exactly " +
      "the drift this system exists to prevent.",
    inputSchema: {
      id: z.string().min(1),
      title: z.string().optional(),
      status: z.enum(CONTENT_STATUS).optional(),
      format: z.enum(CONTENT_FORMAT).nullable().optional(),
      channel: z.enum(CONTENT_CHANNEL).nullable().optional(),
      hook: z.string().nullable().optional(),
      audience: z.string().nullable().optional(),
      published_url: z.string().nullable().optional(),
    },
  }, guard(async ({ id, ...updates }) => store.updateContent(env, await user(), id, updates)));

  // ---- graph & search ----
  server.registerTool("relate", {
    description:
      "Connect two objects with a typed semantic edge (learned-from, used-in, prerequisite-of, inspired-by, " +
      "created-from, mentions). This is how applied knowledge becomes visible — link a note to the project it was used in.",
    inputSchema: {
      source_type: z.enum(SUBJECT_TYPE),
      source_id: z.string().min(1),
      target_type: z.enum(SUBJECT_TYPE).optional(),
      target_id: z.string().optional(),
      target_title: z.string().optional().describe("Use when the target may not exist yet"),
      relation_type: z.enum(RELATION_TYPE),
      context: z.string().optional(),
    },
  }, guard(async (input) => store.createRelation(env, await user(), input)));

  server.registerTool("get_backlinks", {
    description: "Everything that references this object, with context.",
    inputSchema: { subject_type: z.enum(SUBJECT_TYPE), id: z.string().min(1) },
  }, guard(async ({ subject_type, id }) =>
    ({ backlinks: await store.getBacklinks(env, await user(), subject_type, id) })));

  server.registerTool("search", {
    description:
      "Hybrid search across projects, notes, logs, tools, sources, and content. Combines exact keyword matching " +
      "with semantic similarity, so it finds the right idea even when the wording differs. Each hit reports which " +
      "layers matched.",
    inputSchema: {
      query: z.string().min(1),
      subject_type: z.enum(SUBJECT_TYPE).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, guard(async ({ query, ...opts }) =>
    ({ results: await store.hybridSearch(env, await user(), query, opts) })));

  server.registerTool("list_unresolved_links", {
    description: "Referenced titles with no object behind them yet — the graph's growth edges.",
    inputSchema: {},
  }, guard(async () => ({ unresolved: await store.listUnresolved(env, await user()) })));

  // ---- documents ----
  server.registerTool("get_body", {
    description:
      "Read an object's document body as ordered blocks. Blocks carry an is_ai flag; generated content must stay labeled.",
    inputSchema: { document_id: z.string().min(1) },
  }, guard(async ({ document_id }) => (await store.getDocument(env, document_id)) ?? { error: "Document not found" }));

  server.registerTool("open_body", {
    description:
      "Read an object's document body by its OWN id, creating the document if it does not exist yet. Prefer this " +
      "over get_body: it takes the project/note/log/content id you already have, and returns the document_id you " +
      "need for write_body.",
    inputSchema: {
      resource: z.enum(["projects", "notes", "logs", "content"]),
      id: z.string().min(1),
    },
  }, guard(async ({ resource, id }) => {
    const u = await user();
    const map = {
      projects: { type: "project", get: store.getProject, set: store.setProjectDocument },
      notes: { type: "knowledge_note", get: store.getNote, set: store.setNoteDocument },
      logs: { type: "project_log", get: store.getLog, set: store.setLogDocument },
      content: { type: "content_item", get: store.getContent, set: store.setContentDocument },
    } as const;
    const entry = map[resource];
    const record = (await entry.get(env, u, id)) as { body_document_id?: string | null } | null;
    if (!record) return { error: `${resource} not found: ${id}` };
    const documentId = await store.ensureDocument(
      env, u, record.body_document_id ?? null, entry.type as store.SubjectType, id,
    );
    if (documentId !== record.body_document_id) await entry.set(env, u, id, documentId);
    return store.getDocument(env, documentId);
  }));

  server.registerTool("write_body", {
    description:
      "Replace an object's document body with an ordered list of blocks. Set is_ai on any block you generated. " +
      "Block types include paragraph, heading, bullet, todo, code, quote, callout, plus the product blocks: " +
      "decision, experiment, learning, content-seed, relation, tool-card.",
    inputSchema: {
      document_id: z.string().min(1),
      subject_type: z.enum(SUBJECT_TYPE),
      subject_id: z.string().min(1),
      title: z.string().describe("Owner title, used for the search index"),
      blocks: z.array(z.object({
        type: z.string(),
        text: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        is_ai: z.boolean().optional(),
      })),
    },
  }, guard(async ({ document_id, subject_type, subject_id, title, blocks }) => {
    await store.saveBody(env, document_id, blocks as store.BlockInput[], subject_type, subject_id, title, await user());
    return store.getDocument(env, document_id);
  }));

  server.registerTool("get_identity_studio", {
    description:
      "Evidence-based view of what the user's work actually demonstrates: recurring themes by Area, completed " +
      "projects, applied knowledge, adopted tools, published output, plus a portfolio queue of finished work that " +
      "produced nothing shareable, and explicit gaps. Everything is derived from records — do not embellish it " +
      "into claims the evidence does not support.",
    inputSchema: { days: z.number().int().min(7).max(1095).optional() },
  }, guard(async ({ days }) => getIdentityStudio(env, await user(), days ?? 180)));

  server.registerTool("get_completion_checklist", {
    description:
      "What a project still owes before it is really finished: a retrospective, learnings worth promoting into " +
      "knowledge notes, reusable decisions, and whether it produced any output. Use when the user completes a " +
      "project — completion is the moment work becomes evidence, not a silent status change.",
    inputSchema: { project_id: z.string().min(1) },
  }, guard(async ({ project_id }) => getCompletionChecklist(env, await user(), project_id)));

  server.registerTool("export_markdown", {
    description:
      "Export everything as portable Markdown with stable ids, typed frontmatter, and relations — Obsidian-" +
      "compatible. Since D1 is the source of truth in v6, this is the real backup path. Returns the file list.",
    inputSchema: {},
  }, guard(async () => {
    const files = await buildExport(env, await user());
    return { files: files.length, paths: files.map((f) => f.path) };
  }));

  server.registerTool("write_snapshot", {
    description: "Write a timestamped Markdown snapshot of everything into R2. This is the backup; run it before any bulk change.",
    inputSchema: {},
  }, guard(async () => writeSnapshot(env, await user())));

  server.registerTool("get_metrics", {
    description:
      "The product's own success metrics (spec §1.7), led by the north-star: weekly active TRANSFORMATION rate — " +
      "the share of weeks where something captured actually became a project, note, tested tool, or content seed. " +
      "Volume of captures is deliberately not a success measure; report these honestly rather than flatteringly.",
    inputSchema: {},
  }, guard(async () => getMetrics(env, await user())));

  server.registerTool("rebuild_search_index", {
    description:
      "Rebuild the full-text index from canonical D1 rows. Note: in v6 D1 IS the source of truth, so this repairs " +
      "search only — it is not a data recovery path.",
    inputSchema: {},
  }, guard(async () => store.rebuildSearchIndex(env, await user())));

  return server;
}
