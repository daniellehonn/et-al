// Workspaces: the strict tree. One parent, no cycles. The hierarchy doubles as
// the default AI context (a workspace inherits its ancestors' context).
import { z } from "zod";
import { createWorkspaceInput, updateWorkspaceInput } from "../schema";
import { Ctx, RuleError, all, first, id, logEvent, now } from "./db";
import { createDocument, writeBlocks } from "./documents";

export interface Workspace {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  description: string | null;
  status: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export async function listWorkspaces(c: Ctx, parentId?: string | null): Promise<Workspace[]> {
  if (parentId === undefined) {
    return all<Workspace>(c, `SELECT * FROM workspace ORDER BY position, title`);
  }
  if (parentId === null) {
    return all<Workspace>(c, `SELECT * FROM workspace WHERE parent_id IS NULL ORDER BY position, title`);
  }
  return all<Workspace>(c, `SELECT * FROM workspace WHERE parent_id = ? ORDER BY position, title`, parentId);
}

export async function getWorkspace(c: Ctx, wid: string): Promise<Workspace | null> {
  return first<Workspace>(c, `SELECT * FROM workspace WHERE id = ?`, wid);
}

/** The chain from a workspace up to its root — the inherited AI context. */
export async function ancestors(c: Ctx, wid: string): Promise<Workspace[]> {
  const chain: Workspace[] = [];
  let cur = await getWorkspace(c, wid);
  const seen = new Set<string>();
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const parent = await getWorkspace(c, cur.parent_id);
    if (!parent) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

export async function createWorkspace(c: Ctx, input: z.infer<typeof createWorkspaceInput>): Promise<Workspace> {
  const data = createWorkspaceInput.parse(input);
  if (data.parent_id) {
    const parent = await getWorkspace(c, data.parent_id);
    if (!parent) throw new RuleError(`parent workspace ${data.parent_id} does not exist`, 400);
  }
  const wid = id("ws");
  const t = now();
  await c.db
    .prepare(
      `INSERT INTO workspace (id, parent_id, type, title, description, status, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    )
    .bind(wid, data.parent_id ?? null, data.type, data.title, data.description ?? null, t, t)
    .run();
  await logEvent(c, "create", "workspace", wid, { title: data.title, type: data.type });
  await seedForType(c, wid, data.type);
  return (await getWorkspace(c, wid))!;
}

// Type drives starter scaffolding: a project opens with a Roadmap to fill in, a
// course with a Notes doc. Areas and organizations are containers — no seed.
async function seedForType(c: Ctx, wid: string, type: string): Promise<void> {
  if (type === "project") {
    const doc = await createDocument(c, { workspace_id: wid, title: "Roadmap", type: "roadmap" });
    // after:null prepends, so insert bottom-up to land in reading order.
    await writeBlocks(c, doc.id, [
      { op: "insert", after: null, type: "bullet", content: { text: "" } },
      { op: "insert", after: null, type: "heading", content: { text: "Milestones" } },
      { op: "insert", after: null, type: "paragraph", content: { text: "What does done look like?" } },
      { op: "insert", after: null, type: "heading", content: { text: "Outcome" } },
    ]);
  } else if (type === "course") {
    await createDocument(c, { workspace_id: wid, title: "Course Notes", type: "note" });
  }
}

export async function updateWorkspace(c: Ctx, wid: string, input: z.infer<typeof updateWorkspaceInput>): Promise<Workspace> {
  const data = updateWorkspaceInput.parse(input);
  const existing = await getWorkspace(c, wid);
  if (!existing) throw new RuleError(`workspace ${wid} not found`, 404);
  await c.db
    .prepare(
      `UPDATE workspace SET title = ?, description = ?, type = ?, status = ?, position = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      data.title ?? existing.title,
      data.description === undefined ? existing.description : data.description,
      data.type ?? existing.type,
      data.status ?? existing.status,
      data.position ?? existing.position,
      now(),
      wid,
    )
    .run();
  await logEvent(c, "update", "workspace", wid, data);
  return (await getWorkspace(c, wid))!;
}

/** Relocate a workspace under a new parent, rejecting cycles. */
export async function moveWorkspace(c: Ctx, wid: string, newParentId: string | null): Promise<Workspace> {
  const target = await getWorkspace(c, wid);
  if (!target) throw new RuleError(`workspace ${wid} not found`, 404);
  if (newParentId) {
    if (newParentId === wid) throw new RuleError("a workspace cannot be its own parent");
    // Walk up from the proposed parent; if we meet wid, this move makes a cycle.
    let cur: string | null = newParentId;
    const seen = new Set<string>();
    while (cur) {
      if (cur === wid) throw new RuleError("move would create a cycle in the workspace tree");
      if (seen.has(cur)) break;
      seen.add(cur);
      const parent = await getWorkspace(c, cur);
      cur = parent?.parent_id ?? null;
    }
  }
  await c.db.prepare(`UPDATE workspace SET parent_id = ?, updated_at = ? WHERE id = ?`).bind(newParentId, now(), wid).run();
  await logEvent(c, "update", "workspace", wid, { moved_to: newParentId });
  return (await getWorkspace(c, wid))!;
}

/** Delete a workspace and its own contents. Its sub-workspaces are NOT deleted —
 *  they are promoted up to this workspace's parent, so removing a grouping folder
 *  keeps everything inside it (moved up a level) instead of cascading the tree. */
export async function deleteWorkspace(c: Ctx, wid: string): Promise<void> {
  const existing = await getWorkspace(c, wid);
  if (!existing) throw new RuleError(`workspace ${wid} not found`, 404);
  // Promote direct children to this workspace's parent (root if it was a root).
  const children = await all<{ id: string }>(c, `SELECT id FROM workspace WHERE parent_id = ?`, wid);
  if (children.length) {
    await c.db.prepare(`UPDATE workspace SET parent_id = ?, updated_at = ? WHERE parent_id = ?`).bind(existing.parent_id, now(), wid).run();
    await logEvent(c, "update", "workspace", wid, { promoted_children: children.length, to: existing.parent_id });
  }

  // Clear FTS for every searchable entity that belongs to THIS workspace (the
  // promoted children keep their own contents), then the rows themselves.
  for (const type of ["task", "document", "source", "insight", "decision"]) {
    await c.db
      .prepare(`DELETE FROM search_fts WHERE entity_type = ? AND entity_id IN (SELECT id FROM ${type} WHERE workspace_id = ?)`)
      .bind(type, wid)
      .run();
  }
  await c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (SELECT b.id FROM block b JOIN document d ON b.document_id = d.id WHERE d.workspace_id = ?)`).bind(wid).run();
  await c.db.prepare(`DELETE FROM block WHERE document_id IN (SELECT id FROM document WHERE workspace_id = ?)`).bind(wid).run();
  await c.db.prepare(`DELETE FROM document_patch WHERE document_id IN (SELECT id FROM document WHERE workspace_id = ?)`).bind(wid).run();
  await c.db.prepare(`DELETE FROM daily_focus_slot WHERE task_id IN (SELECT id FROM task WHERE workspace_id = ?)`).bind(wid).run();
  for (const table of ["task", "objective", "document", "source", "insight", "decision"]) {
    await c.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(wid).run();
  }
  await c.db.prepare(`DELETE FROM search_fts WHERE entity_type = 'workspace' AND entity_id = ?`).bind(wid).run();
  await c.db.prepare(`DELETE FROM workspace WHERE id = ?`).bind(wid).run();
  await logEvent(c, "delete", "workspace", wid, { title: existing.title });
}

/** Resolve a "Life → Build → et al." style path to a workspace. */
export async function resolvePath(c: Ctx, path: string): Promise<Workspace | null> {
  const parts = path.split(/→|\/|>/).map((p) => p.trim()).filter(Boolean);
  let parentId: string | null = null;
  let match: Workspace | null = null;
  for (const part of parts) {
    const rows: Workspace[] = parentId === null
      ? await all<Workspace>(c, `SELECT * FROM workspace WHERE parent_id IS NULL AND title = ? COLLATE NOCASE`, part)
      : await all<Workspace>(c, `SELECT * FROM workspace WHERE parent_id = ? AND title = ? COLLATE NOCASE`, parentId, part);
    match = rows[0] ?? null;
    if (!match) return null;
    parentId = match.id;
  }
  return match;
}
