"use client";
// The page body, edited with BlockNote.
//
// This replaces a hand-rolled surface that was a list of textareas with one
// active at a time. That design cost three things you feel constantly: clicking
// into a sentence put the caret at the start rather than where you clicked,
// pressing Enter waited on a server round-trip before you could type, and the
// arrow keys could not cross a block boundary. All three are properties of the
// architecture, not bugs in it, which is why the surface is replaced rather
// than patched.
//
// What does NOT change: et al. still owns the data. BlockNote holds the document
// while you edit; every change is mapped back to et al.'s blocks and reconciled
// by id, so block identity, revision history, per-block AI provenance and the
// propose/accept patch gate all survive.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, filterSuggestionItems } from "@blocknote/core";
import {
  useCreateBlockNote, createReactBlockSpec, createReactInlineContentSpec,
  SuggestionMenuController,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/ariakit/style.css";
import { api, type Block } from "@/lib/api";
import { fromBlockNote, toBlockNote, type BNBlock } from "@/lib/blocknote-map";
import { CollectionBlock } from "./CollectionBlock";

/** The passthrough block. et al. has types BlockNote has never heard of —
 *  inline collections and page links. Rather than drop
 *  them (silent data loss) or teach BlockNote each one, they render through
 *  this single spec, which keeps the original type and payload in props so a
 *  round-trip is lossless even for types this editor cannot edit. */
const etAlBlock = createReactBlockSpec(
  { type: "etAlBlock", propSchema: { etype: { default: "" }, payload: { default: "{}" } }, content: "none" },
  {
    render: (props) => {
      const etype = String(props.block.props.etype);
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(String(props.block.props.payload)); } catch { /* keep empty */ }

      if (etype === "collection") {
        return <CollectionBlock collectionId={String(payload.collection_id ?? "")} />;
      }
      if (etype === "page_link") {
        return <PageLink pageId={String(payload.page_id ?? "")} />;
      }
      if (etype === "table") {
        return <SimpleTable columns={(payload.columns as string[]) ?? []} rows={(payload.rows as string[][]) ?? []} />;
      }
      // Anything else: named, visible, and preserved — never silently dropped.
      return (
        <div className="et-bn-opaque" contentEditable={false}>
          <span className="et-bn-opaque-tag">{etype}</span>
          <span className="et-bn-opaque-hint">preserved — not editable here</span>
        </div>
      );
    },
  },
);

/** An inline reference to another page — Notion's @-mention.
 *
 *  Stored with the title alongside the id so the text stays readable to agents
 *  and to FTS even though the id is what actually resolves. The title is a
 *  cached label: the link below reads the live page, so a rename shows through
 *  without rewriting every block that mentions it. */
const pageMention = createReactInlineContentSpec(
  { type: "pageMention", propSchema: { pageId: { default: "" }, title: { default: "" } }, content: "none" },
  {
    render: (props) => <MentionChip pageId={String(props.inlineContent.props.pageId)} fallback={String(props.inlineContent.props.title)} />,
  },
);

function MentionChip({ pageId, fallback }: { pageId: string; fallback: string }) {
  const { data } = useQuery({
    queryKey: ["page", pageId],
    queryFn: () => api.get<{ title: string; icon: string | null }>(`/pages/${pageId}`),
    enabled: !!pageId,
  });
  return (
    <a className="et-mention" href={`/page/?id=${pageId}`} contentEditable={false}>
      {data?.icon ?? "📄"} {data ? data.title || "Untitled" : fallback || "…"}
    </a>
  );
}

function PageLink({ pageId }: { pageId: string }) {
  const { data } = useQuery({
    queryKey: ["page", pageId],
    queryFn: () => api.get<{ title: string; icon: string | null }>(`/pages/${pageId}`),
    enabled: !!pageId,
  });
  if (!pageId) return null;
  return (
    <a className="et-page-link" href={`/page/?id=${pageId}`} contentEditable={false}>
      <span>{data?.icon ?? "📄"}</span>
      <span className="et-page-link-title">{data ? data.title || "Untitled" : "…"}</span>
    </a>
  );
}

function SimpleTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  if (!columns.length) return null;
  return (
    <div className="et-bn-table-wrap" contentEditable={false}>
      <table className="et-bn-table">
        <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// createReactBlockSpec returns a factory in 0.52; the schema wants the spec.
const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, etAlBlock: etAlBlock() },
  // Unlike createReactBlockSpec, the inline variant returns the spec directly.
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageMention },
});

export function PageEditor({ pageId }: { pageId: string }) {
  const qc = useQueryClient();
  const { data: blocks, isLoading } = useQuery({
    queryKey: ["blocks", pageId],
    queryFn: () => api.get<Block[]>(`/pages/${pageId}/blocks`),
  });

  const initial = useMemo(() => (blocks ? toBlockNote(blocks) : undefined), [blocks]);

  const editor = useCreateBlockNote(
    // Keyed on the page below, so this only runs once per page load — BlockNote
    // owns the document from then on and re-seeding it would fight the user.
    { schema, initialContent: initial as never },
    [pageId, !!blocks],
  );

  // Every page, for the @-menu. Small enough to hold in memory, and the menu has
  // to be able to reach anything — not just the current branch.
  const { data: allPages } = useQuery({
    queryKey: ["all-pages"],
    queryFn: () => api.get<Array<{ id: string; title: string; icon: string | null }>>("/pages"),
  });

  const saving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const persist = useCallback(async () => {
    dirty.current = false;
    const tree = fromBlockNote(editor.document as unknown as BNBlock[]);
    try {
      await api.put(`/pages/${pageId}/blocks`, { blocks: tree });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      qc.invalidateQueries({ queryKey: ["session"] });
      alert(/unauthor/i.test(msg)
        ? "Your session has ended. Sign in again to save."
        : `Couldn't save: ${msg}`);
    }
  }, [editor, pageId, qc]);

  const onChange = useCallback(() => {
    dirty.current = true;
    // Debounced: typing stays local and instant, the server hears about it after
    // a pause. Nothing blocks the keystroke.
    if (saving.current) clearTimeout(saving.current);
    saving.current = setTimeout(persist, 800);
  }, [persist]);

  // A pending edit must not be lost to a navigation or a closed tab.
  useEffect(() => {
    const flush = () => { if (dirty.current) void persist(); };
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("beforeunload", flush); flush(); };
  }, [persist]);

  if (isLoading) return <div className="et-bn-loading">Loading…</div>;

  return (
    <div className="et-bn">
      <BlockNoteView editor={editor} onChange={onChange} theme="light">
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                // Creating from the menu is the important half: mentioning a page
                // that does not exist yet is how an outline actually gets written.
                {
                  title: query ? `New page "${query}"` : "New page",
                  group: "Create",
                  onItemClick: async () => {
                    const child = await api.post<{ id: string; title: string }>("/pages", {
                      parent_page_id: pageId, title: query || "Untitled",
                    });
                    qc.invalidateQueries({ queryKey: ["tree"] });
                    qc.invalidateQueries({ queryKey: ["all-pages"] });
                    editor.insertInlineContent([
                      { type: "pageMention", props: { pageId: child.id, title: child.title } } as never,
                      " ",
                    ]);
                  },
                },
                ...(allPages ?? [])
                  .filter((p) => p.id !== pageId)
                  .map((p) => ({
                    title: p.title || "Untitled",
                    group: "Link to page",
                    icon: <span>{p.icon ?? "📄"}</span>,
                    onItemClick: () => {
                      editor.insertInlineContent([
                        { type: "pageMention", props: { pageId: p.id, title: p.title } } as never,
                        " ",
                      ]);
                    },
                  })),
              ],
              query,
            )
          }
        />
      </BlockNoteView>
      <EditorStyles />
    </div>
  );
}

function EditorStyles() {
  return (
    <style jsx global>{`
      /* BlockNote ships its own layout; these only reconcile it with et al.'s
         type scale and colours so the editor does not read as a bolted-on widget. */
      .et-bn { margin-left: -3rem; }
      .et-bn .bn-editor { padding-inline: 3rem; background: transparent; font-family: var(--font-sans); }
      /* BlockNote puts the level on the inner tag, not the block wrapper, and
         its defaults run larger than the page title. Match et al.'s scale. */
      .et-bn .bn-editor h1 { font-size: 1.75rem; font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; }
      .et-bn .bn-editor h2 { font-size: 1.35rem; font-weight: 600; line-height: 1.3; }
      .et-bn .bn-editor h3 { font-size: 1.1rem;  font-weight: 600; line-height: 1.35; }
      .et-bn .bn-block-content { font-size: 1rem; line-height: 1.6; }
      /* BlockNote hard-codes the side-menu height per block type (30px, and
         108px/84px for H1/H2) to match ITS heading scale. et al.'s headings are
         smaller, so the handle was centring on a box far taller than the text.
         These heights track the real line-heights instead. */
      /* Unscoped on purpose: BlockNote renders the side menu into a portal on
         document.body, so anything scoped under .et-bn never matches it. */
      .bn-side-menu { height: 26px !important; }
      .bn-side-menu[data-block-type="heading"][data-level="1"] { height: 46px !important; }
      .bn-side-menu[data-block-type="heading"][data-level="2"] { height: 38px !important; }
      .bn-side-menu[data-block-type="heading"][data-level="3"] { height: 32px !important; }
      /* The controls sit next to the text, not competing with it. */
      .bn-toggle-button { padding: 2px; opacity: 0.5; }
      .bn-toggle-button:hover { opacity: 1; }
      .bn-toggle-button > svg { width: 13px !important; height: 13px !important; }
      .bn-toggle-add-block-button { font-size: 13px; opacity: 0.5; margin-left: 16px; }
      .bn-toggle-add-block-button:hover { opacity: 1; }
      .et-bn-loading { padding: 1.5rem 0; color: var(--ink-faint); }
      .et-bn-opaque { display: flex; align-items: center; gap: 0.5rem; border: 1px dashed var(--rule); border-radius: 6px; padding: 0.35rem 0.6rem; margin: 0.2rem 0; }
      .et-bn-opaque-tag { font-family: var(--font-mono); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-iris); }
      .et-bn-opaque-hint { font-size: 0.75rem; color: var(--ink-faint); }
      .et-bn-table-wrap { overflow-x: auto; }
      .et-bn-table { border-collapse: collapse; font-size: 0.88rem; width: 100%; }
      .et-bn-table th, .et-bn-table td { border: 1px solid var(--rule); padding: 0.3rem 0.5rem; text-align: left; }
      .et-mention { display: inline; color: var(--color-iris); background: var(--color-iris-soft); padding: 0.02em 0.34em; border-radius: 5px; text-decoration: none; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
      .et-mention:hover { text-decoration: underline; }
      .et-page-link { display: inline-flex; align-items: center; gap: 0.4rem; color: inherit; text-decoration: none; }
      .et-page-link-title { border-bottom: 1px solid var(--line-strong); font-weight: 500; }
    `}</style>
  );
}
