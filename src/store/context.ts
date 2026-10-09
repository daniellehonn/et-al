// The context engine. The runtime assembles the right context deterministically;
// the agent interprets it. One call gives an agent what it needs to work on a
// note without walking the tree itself.
import { Ctx } from "./db";
import { getAncestors, listChildren, requireNote, type Note } from "./notes";
import { getBlocks, type Block } from "./blocks";
import { listTasks, type Task } from "./tasks";
import { listNoteSources, type Source } from "./sources";
import { search, type SearchHit } from "./search";

export interface ContextPackage {
  note: Note;
  inherited: Note[];   // ancestors, root first: what this note sits inside
  body: Block[];
  children: Note[];
  open_tasks: Task[];
  sources: Source[];   // what has been filed into this note
  related: SearchHit[]; // matches for the query (or the title) across everything
}

export async function buildContext(c: Ctx, noteId: string, query?: string): Promise<ContextPackage> {
  const note = await requireNote(c, noteId);
  const [inherited, body, children, open_tasks, sources, related] = await Promise.all([
    getAncestors(c, noteId),
    getBlocks(c, noteId),
    listChildren(c, noteId),
    listTasks(c, { note_id: noteId, open: true }),
    listNoteSources(c, noteId),
    search(c, query ?? note.title, { limit: 12 }),
  ]);
  return { note, inherited, body, children, open_tasks, sources, related: related.filter((h) => h.entity_id !== noteId) };
}
