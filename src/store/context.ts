// The Context Engine. The runtime assembles the right context deterministically;
// the agent interprets it. Layer 1 (the page + its inherited ancestors) and
// Layer 2 (search expansion + vector matches) are built; Layer 3 (global
// cross-page recall) is deferred.
//
// v8 note: a context package is now built for a *page*, and "child pages" has
// replaced "documents" — under the new model a document is not a separate kind
// of thing, it is just a page you nested.
import { Ctx } from "./db";
import { getAncestors, getPage, listChildren, type Page } from "./pages";
import { listCollections, type Collection } from "./collections";
import { listTasks, type RoleRow } from "./roles";
import { getBlocks, type Block } from "./blocks";
import { search, type SearchHit } from "./search";

export interface ContextPackage {
  page: Page;
  inherited: Page[];       // ancestors, root first
  body: Block[];           // the page's own content — in v7 this was never in context
  children: Page[];
  collections: Collection[];
  open_tasks: RoleRow[];
  related: SearchHit[];    // Layer 2: query matches across the graph
}

export async function buildContext(c: Ctx, pageId: string, query?: string): Promise<ContextPackage | null> {
  const page = await getPage(c, pageId);
  if (!page) return null;

  const [inherited, body, children, collections, tasks] = await Promise.all([
    getAncestors(c, pageId),
    getBlocks(c, pageId),
    listChildren(c, pageId),
    listCollections(c, pageId),
    listTasks(c, { pageId }),
  ]);

  // Layer 2: pull related material by the query (or the page title).
  const related = await search(c, query ?? page.title, { limit: 12 });

  return {
    page,
    inherited,
    body,
    children,
    collections,
    open_tasks: tasks.filter((t) => t.props.status !== "done"),
    related,
  };
}
