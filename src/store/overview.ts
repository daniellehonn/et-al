// The customizable Overview: an ordered list of widgets per workspace. Widget
// data lives in config_json (kept small — tables here are dashboards, not
// datasets). child_progress is computed client-side from health, so the server
// only stores the widget's presence and title.
import { Ctx, RuleError, all, first, id, logEvent, now } from "./db";

export interface OverviewBlock {
  id: string;
  workspace_id: string;
  type: string;
  config_json: string;
  position: number;
  created_at: number;
  updated_at: number;
}

const WIDGET_TYPES = ["table", "child_progress", "tasks", "text", "progress"];

// Sensible starter config per widget type.
function defaultConfig(type: string): unknown {
  switch (type) {
    case "table":
      return { title: "Table", columns: [{ id: "c1", name: "Name" }, { id: "c2", name: "Status" }], rows: [] };
    case "child_progress": return { title: "Progress" };
    case "tasks": return { title: "Open tasks" };
    case "text": return { title: "Notes", text: "" };
    case "progress": return { title: "Progress toward done" };
    default: return {};
  }
}

export function listOverview(c: Ctx, workspaceId: string): Promise<OverviewBlock[]> {
  return all<OverviewBlock>(c, `SELECT * FROM overview_block WHERE workspace_id = ? ORDER BY position, created_at`, workspaceId);
}

export async function addOverviewBlock(c: Ctx, workspaceId: string, type: string): Promise<OverviewBlock> {
  if (!WIDGET_TYPES.includes(type)) throw new RuleError(`unknown widget type: ${type}`, 400);
  const bid = id("ovb");
  const t = now();
  const last = await first<{ p: number }>(c, `SELECT MAX(position) AS p FROM overview_block WHERE workspace_id = ?`, workspaceId);
  await c.db
    .prepare(`INSERT INTO overview_block (id, workspace_id, type, config_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(bid, workspaceId, type, JSON.stringify(defaultConfig(type)), (last?.p ?? 0) + 1, t, t)
    .run();
  await logEvent(c, "create", "overview_block", bid, { type });
  return (await first<OverviewBlock>(c, `SELECT * FROM overview_block WHERE id = ?`, bid))!;
}

export async function updateOverviewBlock(c: Ctx, bid: string, patch: { config?: unknown; position?: number }): Promise<OverviewBlock> {
  const existing = await first<OverviewBlock>(c, `SELECT * FROM overview_block WHERE id = ?`, bid);
  if (!existing) throw new RuleError(`overview block ${bid} not found`, 404);
  await c.db
    .prepare(`UPDATE overview_block SET config_json = ?, position = ?, updated_at = ? WHERE id = ?`)
    .bind(patch.config !== undefined ? JSON.stringify(patch.config) : existing.config_json, patch.position ?? existing.position, now(), bid)
    .run();
  return (await first<OverviewBlock>(c, `SELECT * FROM overview_block WHERE id = ?`, bid))!;
}

export async function deleteOverviewBlock(c: Ctx, bid: string): Promise<void> {
  const existing = await first<OverviewBlock>(c, `SELECT * FROM overview_block WHERE id = ?`, bid);
  if (!existing) throw new RuleError(`overview block ${bid} not found`, 404);
  await c.db.prepare(`DELETE FROM overview_block WHERE id = ?`).bind(bid).run();
  await logEvent(c, "delete", "overview_block", bid, { type: existing.type });
}
