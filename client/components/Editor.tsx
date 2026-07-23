"use client";

// The block editor, ported from src/ui.ts.
//
// Design decisions carried over from v5 because they were right:
//   * One textarea per block, not a single contentEditable document. It keeps
//     the DOM honest (a block is a row, and stays one), makes autosave trivially
//     diffable, and sidesteps the entire class of contentEditable selection bugs.
//   * `/` opens the block menu, `[[` opens page autocomplete.
//   * Enter splits into a new block; Backspace at position 0 merges upward.
//
// New in v6: product-specific blocks (Decision, Experiment, Learning, Content
// Seed) render their required fields as real inputs, because those fields are
// the point of the block — a Decision without a rationale is just a paragraph.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SLASH_ITEMS, emptyBlock, fieldsFor, isProductBlock, labelFor,
  parseInline, type BlockDraft,
} from "@/lib/blocks";

interface EditorProps {
  blocks: BlockDraft[];
  onChange: (blocks: BlockDraft[]) => void;
  /** Titles offered by `[[` autocomplete. */
  linkTargets?: string[];
  onOpenLink?: (title: string) => void;
  placeholder?: string;
}

interface MenuState {
  kind: "slash" | "link";
  index: number;
  query: string;
  selected: number;
  /**
   * Exact character range of the trigger token ("/query" or "[[query").
   *
   * Recorded rather than re-derived: an end-anchored regex looks correct until
   * someone types the trigger in the MIDDLE of a block, at which point it
   * happily eats everything after the caret too. Splicing an explicit range is
   * the only version that survives a caret that is not at the end.
   */
  from: number;
  to: number;
}

export default function Editor({
  blocks, onChange, linkTargets = [], onOpenLink, placeholder = "Write, or press / for blocks…",
}: EditorProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const refs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const [focused, setFocused] = useState<number | null>(null);
  /** Index whose block handle menu is open (Notion's ⋮⋮ affordance). */
  const [handleAt, setHandleAt] = useState<number | null>(null);

  const update = useCallback((index: number, patch: Partial<BlockDraft>) => {
    onChange(blocks.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }, [blocks, onChange]);

  const insertAfter = useCallback((index: number, block = emptyBlock()) => {
    const next = [...blocks];
    next.splice(index + 1, 0, block);
    onChange(next);
    // Focus the new block after React commits it.
    requestAnimationFrame(() => refs.current[index + 1]?.focus());
  }, [blocks, onChange]);

  const duplicateAt = useCallback((index: number) => {
    const copy = { ...blocks[index], id: undefined };
    const next = [...blocks];
    next.splice(index + 1, 0, copy);
    onChange(next);
  }, [blocks, onChange]);

  const moveBy = useCallback((index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onChange(next);
  }, [blocks, onChange]);

  const removeAt = useCallback((index: number) => {
    if (blocks.length === 1) { onChange([emptyBlock()]); return; }
    const next = blocks.filter((_, i) => i !== index);
    onChange(next);
    requestAnimationFrame(() => {
      const target = refs.current[Math.max(0, index - 1)];
      target?.focus();
      target?.setSelectionRange(target.value.length, target.value.length);
    });
  }, [blocks, onChange]);

  const menuItems = menu
    ? menu.kind === "slash"
      ? SLASH_ITEMS.filter((i) =>
          !menu.query || i.label.toLowerCase().includes(menu.query.toLowerCase()) ||
          i.type.includes(menu.query.toLowerCase()))
      : linkTargets
          .filter((t) => !menu.query || t.toLowerCase().includes(menu.query.toLowerCase()))
          .slice(0, 8)
    : [];

  function applyMenuChoice(choiceIndex: number) {
    if (!menu) return;
    const block = blocks[menu.index];
    const before = block.text.slice(0, menu.from);
    const after = block.text.slice(menu.to);

    if (menu.kind === "slash") {
      const item = (menuItems as typeof SLASH_ITEMS)[choiceIndex];
      if (!item) return;
      // The trigger token disappears; the rest of the block is untouched.
      const text = before + after;
      update(menu.index, { type: item.type, text, data: block.data ?? {} });
      setCaretAfter(menu.index, menu.from);
    } else {
      const title = (menuItems as string[])[choiceIndex];
      if (!title) return;
      const link = `[[${title}]]`;
      update(menu.index, { text: before + link + after });
      setCaretAfter(menu.index, menu.from + link.length);
    }
    setMenu(null);
  }

  /** Restores the caret after React re-renders the textarea. */
  function setCaretAfter(index: number, position: number) {
    requestAnimationFrame(() => {
      const el = refs.current[index];
      if (!el) return;
      el.focus();
      el.setSelectionRange(position, position);
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>, index: number) {
    const el = event.currentTarget;

    if (menu) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenu({ ...menu, selected: (menu.selected + 1) % Math.max(1, menuItems.length) });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenu({ ...menu, selected: (menu.selected - 1 + menuItems.length) % Math.max(1, menuItems.length) });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMenuChoice(menu.selected);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setMenu(null); return; }
    }

    // Enter splits the block; Shift+Enter is a literal newline (code blocks keep
    // plain Enter, since a newline is almost always what is meant there).
    if (event.key === "Enter" && !event.shiftKey && blocks[index].type !== "code") {
      event.preventDefault();
      const before = el.value.slice(0, el.selectionStart);
      const after = el.value.slice(el.selectionStart);
      update(index, { text: before });
      // A list block continues its own type; everything else returns to text.
      const carry = ["bullet", "number", "todo"].includes(blocks[index].type);
      const nextType = carry && before.trim() ? blocks[index].type : "paragraph";
      const next = [...blocks];
      next[index] = { ...next[index], text: before };
      next.splice(index + 1, 0, { ...emptyBlock(nextType), text: after });
      onChange(next);
      requestAnimationFrame(() => refs.current[index + 1]?.focus());
      return;
    }

    if (event.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (blocks[index].type !== "paragraph") {
        event.preventDefault();
        update(index, { type: "paragraph" });   // first Backspace resets the type
        return;
      }
      if (index > 0) {
        event.preventDefault();
        const previous = blocks[index - 1];
        const merged = previous.text + blocks[index].text;
        const next = blocks.filter((_, i) => i !== index);
        next[index - 1] = { ...previous, text: merged };
        onChange(next);
        requestAnimationFrame(() => {
          const target = refs.current[index - 1];
          target?.focus();
          target?.setSelectionRange(previous.text.length, previous.text.length);
        });
      }
      return;
    }

    if (event.key === "ArrowUp" && el.selectionStart === 0 && index > 0) {
      event.preventDefault(); refs.current[index - 1]?.focus();
    }
    if (event.key === "ArrowDown" && el.selectionStart === el.value.length && index < blocks.length - 1) {
      event.preventDefault(); refs.current[index + 1]?.focus();
    }
  }

  function onInput(event: React.ChangeEvent<HTMLTextAreaElement>, index: number) {
    const text = event.target.value;
    const caret = event.target.selectionStart;
    update(index, { text });

    // Trigger detection looks only at the text before the caret, and records
    // where the token starts so it can be replaced precisely later.
    const upToCaret = text.slice(0, caret);

    const link = upToCaret.match(/\[\[([^\]]*)$/);
    if (link) {
      setMenu({ kind: "link", index, query: link[1], selected: 0, from: link.index!, to: caret });
      return;
    }

    const slash = upToCaret.match(/(?:^|\s)(\/[^/\s]*)$/);
    if (slash) {
      // match.index points at the leading space (or start of line); the token
      // itself begins where capture group 1 does.
      const from = slash.index! + slash[0].length - slash[1].length;
      setMenu({ kind: "slash", index, query: slash[1].slice(1), selected: 0, from, to: caret });
      return;
    }

    setMenu(null);
  }

  return (
    <div className="editor">
      {blocks.map((block, index) => (
        <div key={block.id ?? index} className={`blk blk-${block.type}`}>
          <button
            type="button"
            className={`blk-handle ${handleAt === index ? "open" : ""}`}
            aria-label="Block actions"
            aria-expanded={handleAt === index}
            onClick={() => setHandleAt(handleAt === index ? null : index)}
          >⋮⋮</button>

          <BlockAffix block={block} onToggle={() => update(index, {
            type: block.type === "todo" ? "todo-done" : "todo",
          })} />

          <div className="blk-body">
            {block.type === "divider" ? (
              <hr className="blk-divider" />
            ) : (
              <>
                <textarea
                  ref={(el) => { refs.current[index] = el; }}
                  className="blk-input"
                  value={block.text}
                  rows={1}
                  placeholder={index === 0 && blocks.length === 1 ? placeholder : undefined}
                  onChange={(e) => onInput(e, index)}
                  onKeyDown={(e) => onKeyDown(e, index)}
                  onFocus={() => setFocused(index)}
                  onBlur={() => { setFocused((f) => (f === index ? null : f)); setTimeout(() => setMenu(null), 150); }}
                  onInput={(e) => {
                    // Grow to fit: textareas do not auto-size.
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                />
                {/* Rendered view sits under the input so wikilinks stay clickable
                    when the block is not being edited. */}
                {focused !== index && block.text && (
                  <div className="blk-render" aria-hidden={false}>
                    {parseInline(block.text).map((seg, i) =>
                      seg.kind === "link" ? (
                        <button
                          key={i} type="button" className="wikilink"
                          onClick={() => seg.target && onOpenLink?.(seg.target)}
                        >{seg.value}</button>
                      ) : seg.kind === "code" ? <code key={i}>{seg.value}</code>
                        : seg.kind === "bold" ? <b key={i}>{seg.value}</b>
                        : <span key={i}>{seg.value}</span>,
                    )}
                  </div>
                )}
              </>
            )}

            {isProductBlock(block.type) && (
              <ProductFields
                block={block}
                onChange={(data) => update(index, { data })}
              />
            )}
          </div>

          {block.is_ai && <span className="chip warn ai-flag">AI</span>}

          {handleAt === index && (
            <BlockActions
              canMoveUp={index > 0}
              canMoveDown={index < blocks.length - 1}
              onClose={() => setHandleAt(null)}
              onDuplicate={() => { duplicateAt(index); setHandleAt(null); }}
              onMoveUp={() => { moveBy(index, -1); setHandleAt(null); }}
              onMoveDown={() => { moveBy(index, 1); setHandleAt(null); }}
              onDelete={() => { removeAt(index); setHandleAt(null); }}
              onTurnInto={(type) => { update(index, { type }); setHandleAt(null); }}
              current={block.type}
            />
          )}

          {menu?.index === index && menuItems.length > 0 && (
            <Menu
              kind={menu.kind}
              items={menuItems}
              selected={menu.selected}
              onPick={applyMenuChoice}
            />
          )}
        </div>
      ))}

      <button className="blk-add" type="button" onClick={() => insertAfter(blocks.length - 1)}>
        + Add block
      </button>
    </div>
  );
}

/** The bullet, checkbox, or number that precedes a block's text. */
function BlockAffix({ block, onToggle }: { block: BlockDraft; onToggle: () => void }) {
  if (block.type === "todo" || block.type === "todo-done") {
    return (
      <button
        type="button"
        className={`blk-check ${block.type === "todo-done" ? "on" : ""}`}
        onClick={onToggle}
        aria-label={block.type === "todo-done" ? "Mark not done" : "Mark done"}
      >{block.type === "todo-done" ? "✓" : ""}</button>
    );
  }
  if (block.type === "bullet") return <span className="blk-affix">•</span>;
  if (isProductBlock(block.type)) {
    return <span className="blk-tag">{labelFor(block.type)}</span>;
  }
  return <span className="blk-affix" />;
}

/**
 * Required fields for product blocks. These are what make a Decision reusable
 * evidence rather than prose, so they are inputs and not a convention.
 */
function ProductFields({
  block, onChange,
}: { block: BlockDraft; onChange: (data: Record<string, unknown>) => void }) {
  const fields = fieldsFor(block.type);
  if (!fields.length) return null;
  const data = block.data ?? {};
  return (
    <div className="blk-fields">
      {fields.map((field) => (
        <label key={field} className="blk-field">
          <span>{field.replace(/_/g, " ")}</span>
          <input
            value={String(data[field] ?? "")}
            onChange={(e) => onChange({ ...data, [field]: e.target.value })}
            placeholder="…"
          />
        </label>
      ))}
    </div>
  );
}

/**
 * The per-block actions Notion puts behind its drag handle. Delete lives here
 * because the alternative — backspace-merging an empty block — is invisible
 * unless you already know the trick.
 */
function BlockActions({
  canMoveUp, canMoveDown, current, onClose, onDuplicate, onMoveUp, onMoveDown, onDelete, onTurnInto,
}: {
  canMoveUp: boolean; canMoveDown: boolean; current: string;
  onClose: () => void;
  onDuplicate: () => void; onMoveUp: () => void; onMoveDown: () => void; onDelete: () => void;
  onTurnInto: (type: string) => void;
}) {
  const TURN_INTO = ["paragraph", "heading", "bullet", "todo", "quote", "callout", "code"];
  return (
    <>
      {/* Click-away layer, so the menu closes without a global listener. */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 30 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="blk-menu" role="menu" style={{ left: 0 }}>
        <div className="blk-menu-head">Turn into</div>
        {TURN_INTO.filter((t) => t !== current).map((t) => (
          <button key={t} type="button" role="menuitem"
            onMouseDown={(e) => { e.preventDefault(); onTurnInto(t); }}>
            <span className="mi">¶</span><span className="mt">{labelFor(t)}</span>
          </button>
        ))}
        <div className="sep" />
        <button type="button" role="menuitem"
          onMouseDown={(e) => { e.preventDefault(); onDuplicate(); }}>
          <span className="mi">⧉</span><span className="mt">Duplicate</span>
        </button>
        {canMoveUp && (
          <button type="button" role="menuitem"
            onMouseDown={(e) => { e.preventDefault(); onMoveUp(); }}>
            <span className="mi">↑</span><span className="mt">Move up</span>
          </button>
        )}
        {canMoveDown && (
          <button type="button" role="menuitem"
            onMouseDown={(e) => { e.preventDefault(); onMoveDown(); }}>
            <span className="mi">↓</span><span className="mt">Move down</span>
          </button>
        )}
        <div className="sep" />
        <button type="button" role="menuitem" className="destructive"
          onMouseDown={(e) => { e.preventDefault(); onDelete(); }}>
          <span className="mi">✕</span><span className="mt">Delete block</span>
        </button>
      </div>
    </>
  );
}

function Menu({
  kind, items, selected, onPick,
}: {
  kind: "slash" | "link";
  items: Array<{ icon: string; label: string; hint?: string } | string>;
  selected: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="blk-menu" role="listbox">
      <div className="blk-menu-head">{kind === "slash" ? "Blocks" : "Link to"}</div>
      {items.map((item, i) => (
        <button
          key={i} type="button" role="option" aria-selected={i === selected}
          className={i === selected ? "on" : ""}
          onMouseDown={(e) => { e.preventDefault(); onPick(i); }}
        >
          {typeof item === "string" ? (
            <><span className="mi">[[</span><span className="mt">{item}</span></>
          ) : (
            <>
              <span className="mi">{item.icon}</span>
              <span className="mt">{item.label}</span>
              {item.hint && <span className="mh">{item.hint}</span>}
            </>
          )}
        </button>
      ))}
    </div>
  );
}
