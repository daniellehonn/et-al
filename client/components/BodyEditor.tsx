"use client";

// Loads an object's document body, renders the block editor, and autosaves.
//
// The body document is created lazily by the Worker on first GET of
// `/api/{resource}/{id}/body`, so an object never carries an empty document it
// may never use — opening one is what brings it into existence.
//
// Saving also persists the [[wikilinks]] found in the text as relations, which
// is what makes backlinks work without a separate "link" action.

import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "./Editor";
import { emptyBlock, extractLinks, type BlockDraft } from "@/lib/blocks";
import { getBody, saveBody, createRelation, type Block } from "@/lib/api";

const SAVE_DEBOUNCE_MS = 700;

interface BodyEditorProps {
  /** REST collection name, e.g. "projects" | "notes" | "logs" | "content". */
  resource: string;
  /** The store's subject_type for this collection. */
  subjectType: string;
  id: string;
  title: string;
  linkTargets?: string[];
  onOpenLink?: (title: string) => void;
}

export default function BodyEditor({
  resource, subjectType, id, title, linkTargets, onOpenLink,
}: BodyEditorProps) {
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<BlockDraft[] | null>(null);
  const [sync, setSync] = useState<"idle" | "editing" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownLinks = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setBlocks(null);
    setDocumentId(null);
    getBody(resource, id)
      .then((doc) => {
        if (cancelled) return;
        setDocumentId(doc.id);
        setBlocks(doc.blocks.length ? doc.blocks.map(toDraft) : [emptyBlock()]);
        knownLinks.current = new Set(
          extractLinks(doc.blocks.map(toDraft)).map((l) => l.target.toLowerCase()),
        );
      })
      .catch(() => { if (!cancelled) setSync("error"); });
    return () => { cancelled = true; };
  }, [resource, id]);

  const persist = useCallback(async (next: BlockDraft[]) => {
    if (!documentId) return;
    setSync("saving");
    try {
      await saveBody(documentId, {
        blocks: next.map((b) => ({
          type: b.type, text: b.text, data: b.data ?? {}, is_ai: b.is_ai ?? false,
        })) as Array<Partial<Block>>,
        subject_type: subjectType,
        subject_id: id,
        title,
      });

      // New [[links]] become relations. Unresolved targets are kept as
      // `target_title`, so a link written before its page exists resolves the
      // moment that page is created.
      for (const link of extractLinks(next)) {
        const key = link.target.toLowerCase();
        if (knownLinks.current.has(key)) continue;
        knownLinks.current.add(key);
        await createRelation({
          source_type: subjectType, source_id: id,
          target_title: link.target, relation_type: "mentions", context: link.context,
        }).catch(() => knownLinks.current.delete(key));
      }
      setSync("saved");
    } catch {
      setSync("error");
    }
  }, [documentId, subjectType, id, title]);

  function onChange(next: BlockDraft[]) {
    setBlocks(next);
    setSync("editing");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(next), SAVE_DEBOUNCE_MS);
  }

  // Flush a pending save if the component unmounts mid-edit.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!blocks) {
    return <div className="card" aria-busy="true"><div className="skeleton" /><div className="skeleton" /></div>;
  }

  return (
    <>
      <Editor
        blocks={blocks}
        onChange={onChange}
        linkTargets={linkTargets}
        onOpenLink={onOpenLink}
      />
      <div className="sync" style={{ marginTop: 10 }}>
        {sync === "editing" && "editing…"}
        {sync === "saving" && "saving…"}
        {sync === "saved" && "saved"}
        {sync === "error" && <span style={{ color: "var(--error)" }}>could not save</span>}
      </div>
    </>
  );
}

function toDraft(block: Block): BlockDraft {
  return { id: block.id, type: block.type, text: block.text, data: block.data, is_ai: block.is_ai };
}
