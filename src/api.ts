// The REST surface over the v6 store.
//
// Every entity exposes the same five operations, so they are declared once in a
// registry rather than written out ten times. Entity-specific behaviour (the
// project next-action rule, the tool verdict rule, capture immutability) lives
// in the store modules, not here — this file only routes.

import type { Env } from "./store/index.ts";
import * as store from "./store/index.ts";

export interface Resource {
  list: (env: Env, userId: string, opts: any) => Promise<unknown>;
  get: (env: Env, userId: string, id: string) => Promise<unknown | null>;
  create: (env: Env, userId: string, input: any) => Promise<unknown>;
  update: (env: Env, userId: string, id: string, input: any) => Promise<unknown>;
  remove: (env: Env, userId: string, id: string) => Promise<boolean>;
  /** Query-string keys forwarded to `list` as filters. */
  filters: string[];
  /** Which store setter attaches a body document, if this entity has one. */
  setDocument?: (env: Env, userId: string, id: string, documentId: string) => Promise<void>;
  subjectType?: store.SubjectType;
}

export const RESOURCES: Record<string, Resource> = {
  areas: {
    list: (env, u) => store.listAreas(env, u),
    get: store.getArea, create: store.createArea, update: store.updateArea, remove: store.deleteArea,
    filters: [], subjectType: "area",
  },
  goals: {
    list: store.listGoals, get: store.getGoal, create: store.createGoal,
    update: store.updateGoal, remove: store.deleteGoal,
    filters: ["area_id", "status"], subjectType: "goal",
  },
  projects: {
    list: store.listProjects, get: store.getProject, create: store.createProject,
    update: store.updateProject, remove: store.deleteProject,
    filters: ["status", "area_id", "goal_id", "limit", "offset"],
    setDocument: store.setProjectDocument, subjectType: "project",
  },
  logs: {
    list: store.listLogs, get: store.getLog, create: store.createLog,
    update: store.updateLog, remove: store.deleteLog,
    filters: ["project_id", "entry_type", "content_seed_status", "limit"],
    setDocument: store.setLogDocument, subjectType: "project_log",
  },
  notes: {
    list: store.listNotes, get: store.getNote, create: store.createNote,
    update: store.updateNote, remove: store.deleteNote,
    filters: ["mastery", "note_type", "limit"],
    setDocument: store.setNoteDocument, subjectType: "knowledge_note",
  },
  tools: {
    list: store.listTools, get: store.getTool, create: store.createTool,
    update: store.updateTool, remove: store.deleteTool,
    filters: ["status", "limit"], subjectType: "tool",
  },
  sources: {
    list: store.listSources, get: store.getSource, create: store.createSource,
    update: store.updateSource, remove: store.deleteSource,
    filters: ["platform", "limit"], subjectType: "source",
  },
  content: {
    list: store.listContent, get: store.getContent, create: store.createContent,
    update: store.updateContent, remove: store.deleteContent,
    filters: ["status", "limit"],
    setDocument: store.setContentDocument, subjectType: "content_item",
  },
  captures: {
    list: store.listCaptures, get: store.getCapture, create: store.createCapture,
    update: store.updateCapture, remove: store.deleteCapture,
    filters: ["review_status", "processing_status", "limit"], subjectType: "capture",
  },
};

export function readFilters(url: URL, keys: string[]): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value === null || value === "") continue;
    opts[key] = key === "limit" || key === "offset" ? Number(value) : value;
  }
  return opts;
}

/**
 * Home (spec §4.2) answers three questions in one payload: what matters now,
 * what should I do next, what needs review. Assembled server-side so the client
 * makes a single request instead of six.
 */
export async function getHome(env: Env, userId: string) {
  const [active, stale, missingNextAction, inbox, testQueue, recentNotes, seedable] = await Promise.all([
    store.listProjects(env, userId, { status: "active", limit: 50 }),
    store.listStaleProjects(env, userId),
    store.listProjectsMissingNextAction(env, userId),
    store.listInbox(env, userId, 20),
    store.listTestQueue(env, userId),
    store.listNotes(env, userId, { limit: 10 }),
    store.listLogs(env, userId, { content_seed_status: "suggested", limit: 10 }),
  ]);
  return {
    active_projects: active.map((p) => ({ id: p.id, title: p.title, next_action: p.next_action })),
    stale_projects: stale.map((p) => ({ id: p.id, title: p.title, last_activity_at: p.last_activity_at })),
    projects_missing_next_action: missingNextAction.map((p) => ({ id: p.id, title: p.title })),
    inbox_count: inbox.length,
    inbox: inbox.slice(0, 5),
    test_queue: testQueue.map((t) => ({ id: t.id, name: t.name, status: t.status })),
    recent_learning: recentNotes.map((n) => ({ id: n.id, title: n.title, mastery: n.mastery })),
    content_opportunities: seedable.map((l) => ({ id: l.id, title: l.title, project_id: l.project_id })),
  };
}

/**
 * The guided weekly review (spec §3.8) as data: each step carries the items it
 * is about, so the client renders a sequence rather than a dashboard.
 */
export async function getReview(env: Env, userId: string) {
  const [inbox, stale, missingNextAction, testing, notes, seeds, areas] = await Promise.all([
    store.listInbox(env, userId, 50),
    store.listStaleProjects(env, userId),
    store.listProjectsMissingNextAction(env, userId),
    store.listTestQueue(env, userId),
    store.listNotes(env, userId, { mastery: "captured", limit: 20 }),
    store.listLogs(env, userId, { content_seed_status: "suggested", limit: 20 }),
    store.listAreas(env, userId),
  ]);
  return {
    steps: [
      { key: "process-captures", title: "Process captures awaiting review", items: inbox },
      { key: "stalled-projects", title: "Review stalled projects", items: stale },
      { key: "next-actions", title: "Confirm a next action for every active project", items: missingNextAction },
      { key: "tools", title: "Tools stuck in testing", items: testing },
      { key: "promote-learning", title: "Promote captured notes toward understanding", items: notes },
      { key: "content", title: "Content seeds from this week's work", items: seeds },
      { key: "balance", title: "Check goal progress and neglected areas", items: areas },
    ],
  };
}
