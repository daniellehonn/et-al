"use client";
import { useState } from "react";

// A lightweight page-icon picker: a curated emoji grid in a popover, plus a
// field to paste any emoji, and a remove option.
const EMOJIS = [
  "😀", "😄", "😍", "🤓", "🧠", "💡", "🚀", "🔥", "⭐", "✨", "🎯", "✅",
  "📌", "📝", "📄", "📚", "📖", "📓", "🗂️", "📁", "📊", "📈", "🧩", "🛠️",
  "⚙️", "🔧", "🧪", "🔬", "💻", "⌨️", "🖥️", "📱", "🌐", "🔗", "🎨", "🖌️",
  "🎬", "🎧", "🎵", "🏆", "🥇", "🎓", "🏫", "💼", "💰", "📅", "⏰", "⏳",
  "🌱", "🌳", "🌍", "❤️", "💜", "💙", "💚", "🧡", "🔵", "🟢", "🟠", "🔴",
  "🏠", "🏢", "✈️", "🍜", "☕", "🏃", "🏋️", "🧘", "🎮", "🐙", "🦉", "🌟",
];

export function EmojiPicker({ value, onPick, className }: { value: string; onPick: (e: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  return (
    <span className={`et-emoji ${className ?? ""}`}>
      <button className="et-emoji-btn" data-empty={!value || undefined} onClick={() => setOpen((o) => !o)} title="Pick an icon" aria-label="Pick an icon">
        {value || "＋"}
      </button>
      {open && (
        <>
          <div className="et-emoji-backdrop" onClick={() => setOpen(false)} />
          <div className="et-emoji-pop" role="dialog">
            <div className="et-emoji-grid">
              {EMOJIS.map((e) => (
                <button key={e} className="et-emoji-cell" onClick={() => { onPick(e); setOpen(false); }}>{e}</button>
              ))}
            </div>
            <div className="et-emoji-foot">
              <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Paste any emoji"
                onKeyDown={(e) => { if (e.key === "Enter" && custom.trim()) { onPick(custom.trim()); setCustom(""); setOpen(false); } }} />
              {value && <button className="et-emoji-remove" onClick={() => { onPick(""); setOpen(false); }}>Remove</button>}
            </div>
          </div>
        </>
      )}
      <style>{`
        .et-emoji { position: relative; display: inline-flex; }
        .et-emoji-btn { background: none; border: none; cursor: pointer; line-height: 1; padding: 0; font-size: inherit; border-radius: 8px; }
        .et-emoji-btn[data-empty] { font-size: 1.1rem; color: var(--line-strong); }
        .et-emoji-btn:hover { background: var(--paper-raised); }
        .et-emoji-backdrop { position: fixed; inset: 0; z-index: 40; }
        .et-emoji-pop { position: absolute; z-index: 50; top: 2.4rem; left: 0; width: 17rem; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 12px; padding: 0.6rem; box-shadow: 0 10px 30px rgba(0,0,0,0.18); }
        .et-emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 0.1rem; max-height: 12rem; overflow-y: auto; }
        .et-emoji-cell { background: none; border: none; cursor: pointer; font-size: 1.2rem; line-height: 1; padding: 0.25rem; border-radius: 7px; }
        .et-emoji-cell:hover { background: var(--color-iris-soft); }
        .et-emoji-foot { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.5rem; border-top: 1px solid var(--line); padding-top: 0.5rem; }
        .et-emoji-foot input { flex: 1; min-width: 0; background: var(--paper); border: 1px solid var(--line-strong); border-radius: 7px; padding: 0.3rem 0.5rem; font: inherit; font-size: 0.85rem; color: var(--ink); }
        .et-emoji-foot input:focus { outline: none; border-color: var(--color-iris); }
        .et-emoji-remove { background: none; border: none; color: var(--ink-faint); font: inherit; font-size: 0.8rem; cursor: pointer; }
        .et-emoji-remove:hover { color: #c0392b; }
      `}</style>
    </span>
  );
}
