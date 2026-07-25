// The Context Engine. The runtime assembles the right context deterministically;
// the agent interprets it. Layer 1 (explicit workspace + inherited ancestors) and
// Layer 2 (graph expansion + vector matches) are built; Layer 3 (global
// cross-workspace recall) is deferred.
import { Ctx, all } from "./db";
import { ancestors, getWorkspace, type Workspace } from "./workspaces";
import { listObjectives, type Objective } from "./objectives";
import { listTasks, type Task } from "./tasks";
import { listDocuments, type Document } from "./documents";
import { listDecisions, type Decision } from "./decisions";
import { search } from "./search";
import type { SearchHit } from "./search";

export interface ContextPackage {
  workspace: Workspace;
  inherited: Workspace[]; // ancestors, root last
  objectives: Objective[];
  open_tasks: Task[];
  documents: Document[];
  recent_decisions: Decision[];
  related: SearchHit[]; // Layer 2: query matches across the graph
}

export async function buildContext(
  c: Ctx,
  workspaceId: string,
  query?: string,
): Promise<ContextPackage | null> {
  const workspace = await getWorkspace(c, workspaceId);
  if (!workspace) return null;

  const [inherited, objectives, openTasks, documents, decisions] = await Promise.all([
    ancestors(c, workspaceId),
    listObjectives(c, workspaceId),
    listTasks(c, workspaceId, {}).then((ts) => ts.filter((t) => t.status !== "done")),
    listDocuments(c, workspaceId),
    all<Decision>(c, `SELECT * FROM decision WHERE workspace_id = ? ORDER BY decided_on DESC LIMIT 10`, workspaceId),
  ]);

  // Layer 2: pull related material by the query (or the workspace title).
  const related = await search(c, query ?? workspace.title, { limit: 12 });

  return {
    workspace,
    inherited,
    objectives,
    open_tasks: openTasks,
    documents,
    recent_decisions: decisions,
    related,
  };
}
