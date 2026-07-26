"use client";
import { useEffect, useRef, useState } from "react";

// Click-to-edit text, Notion-style. Click to edit, Enter (or blur) saves, Esc
// cancels. `multiline` uses a textarea and saves on blur only.
export function EditableText({
  value, onSave, placeholder = "Untitled", className = "", inputClassName = "", multiline = false, as = "span",
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  multiline?: boolean;
  as?: "span" | "h1" | "h2" | "div";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select?.(); } }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    else setDraft(value);
  };

  if (editing) {
    const common = {
      ref: ref as never,
      value: draft,
      onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
      onBlur: commit,
      className: `et-editable-input ${inputClassName}`,
    };
    return multiline ? (
      <textarea {...common} rows={2}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value); setEditing(false); } }} />
    ) : (
      <input {...common}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { setDraft(value); setEditing(false); } }} />
    );
  }

  const Tag = as;
  return (
    <Tag className={`et-editable ${className}`} onClick={() => setEditing(true)} title="Click to edit"
      {...(value ? {} : { "data-empty": true })}>
      {value || placeholder}
      <EditableStyles />
    </Tag>
  );
}

// A hover-revealed delete control. Destructive actions confirm inline.
export function DeleteButton({ onDelete, confirm = false, label = "Delete", size = "sm" }: { onDelete: () => void; confirm?: boolean; label?: string; size?: "sm" | "md" }) {
  const [armed, setArmed] = useState(false);
  if (confirm && armed) {
    return (
      <span className="et-del-confirm">
        <button className="et-del-yes" onClick={(e) => { e.stopPropagation(); setArmed(false); onDelete(); }}>{label}?</button>
        <button className="et-del-no" onClick={(e) => { e.stopPropagation(); setArmed(false); }}>Cancel</button>
      </span>
    );
  }
  return (
    <button className={`et-del ${size === "md" ? "et-del-md" : ""}`} aria-label={label}
      onClick={(e) => { e.stopPropagation(); confirm ? setArmed(true) : onDelete(); }}>×</button>
  );
}

function EditableStyles() {
  return (
    <style>{`
      .et-editable { cursor: text; border-radius: 4px; transition: background 0.1s; padding: 0 2px; margin: 0 -2px; }
      .et-editable:hover { background: color-mix(in srgb, var(--color-iris) 8%, transparent); }
      .et-editable[data-empty] { color: var(--ink-faint); font-style: italic; }
      .et-editable-input { font: inherit; color: inherit; background: var(--paper-raised); border: 1px solid var(--color-iris); border-radius: 5px; padding: 0.1em 0.35em; margin: -0.1em -0.35em; width: 100%; resize: vertical; }
      .et-editable-input:focus { outline: none; }
      .et-del { background: none; border: none; color: var(--ink-faint); font-size: 1.15rem; line-height: 1; cursor: pointer; padding: 0 0.25rem; opacity: 0; transition: opacity 0.12s, color 0.12s; border-radius: 4px; }
      .et-del-md { font-size: 1.4rem; }
      *:hover > .et-del, .et-del:focus { opacity: 1; }
      .et-del:hover { color: #c0392b; }
      .et-del-confirm { display: inline-flex; gap: 0.3rem; align-items: center; }
      .et-del-yes { background: #c0392b; color: #fff; border: none; border-radius: 6px; padding: 0.2rem 0.55rem; font: inherit; font-size: 0.8rem; cursor: pointer; }
      .et-del-no { background: none; border: none; color: var(--ink-faint); font: inherit; font-size: 0.8rem; cursor: pointer; }
    `}</style>
  );
}
