"use client";

// Delete, with confirmation inline rather than in a modal.
//
// Deleting a project or note removes its document and unresolves anything that
// linked to it, so it genuinely is destructive — but a browser confirm() dialog
// is easy to click through without reading. Requiring a second, deliberate click
// on a button that has changed to say "Really delete?" makes the consequence
// visible at the moment of the decision.

import { useEffect, useRef, useState } from "react";

export default function DeleteButton({
  onDelete, label = "Delete", what,
}: {
  onDelete: () => Promise<unknown>;
  label?: string;
  /** Named in the confirm state, so it is obvious WHAT is about to go. */
  what?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Disarm on its own, so a half-pressed delete never sits waiting for a stray
  // click later.
  useEffect(() => {
    if (!armed) return;
    timer.current = setTimeout(() => setArmed(false), 4000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [armed]);

  async function click() {
    if (!armed) { setArmed(true); return; }
    setBusy(true);
    try { await onDelete(); } finally { setBusy(false); setArmed(false); }
  }

  return (
    <button
      type="button"
      className={`btn ${armed ? "danger" : ""}`}
      onClick={click}
      disabled={busy}
      aria-label={armed ? `Confirm delete ${what ?? ""}` : label}
    >
      {busy ? "Deleting…" : armed ? `Really delete${what ? ` ${what}` : ""}?` : label}
    </button>
  );
}
