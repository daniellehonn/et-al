"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";

// A slim banner shown only when the session isn't authed. Reads work without it;
// it's the one-time unlock so mutations (and agents' accepted patches) can write.
// The key is posted once to /api/login and lives only in the httpOnly cookie.
export function AuthGate() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["session"], queryFn: () => api.session(), staleTime: 60_000 });
  const [key, setKey] = useState("");
  const [error, setError] = useState(false);

  if (data?.authed !== false) return null; // undefined (loading) or true → nothing

  const unlock = async () => {
    setError(false);
    try {
      await api.login(key.trim());
      setKey("");
      qc.invalidateQueries();
    } catch { setError(true); }
  };

  return (
    <div className="et-gate">
      <span className="eyebrow">Read-only</span>
      <span className="et-gate-msg">Unlock to capture, edit, and let agents write.</span>
      <form onSubmit={(e) => { e.preventDefault(); if (key.trim()) unlock(); }} className="et-gate-form">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" aria-label="API key" data-error={error} />
        <button type="submit" disabled={!key.trim()}>Unlock</button>
      </form>
      <style>{`
        .et-gate { display: flex; align-items: center; gap: 0.8rem; padding: 0.55rem 1.2rem;
          background: color-mix(in srgb, var(--color-amber) 12%, var(--paper)); border-bottom: 1px solid color-mix(in srgb, var(--color-amber) 40%, transparent); }
        .et-gate-msg { font-size: 0.85rem; color: var(--ink-soft); flex: 1; }
        .et-gate-form { display: flex; gap: 0.4rem; }
        .et-gate-form input { background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 7px; padding: 0.3rem 0.6rem; font: inherit; font-size: 0.85rem; color: var(--ink); width: 12rem; }
        .et-gate-form input[data-error="true"] { border-color: var(--color-amber); }
        .et-gate-form input:focus { outline: none; border-color: var(--color-iris); }
        .et-gate-form button { background: var(--ink); color: var(--paper); border: none; border-radius: 7px; padding: 0.3rem 0.9rem; font: inherit; font-size: 0.85rem; cursor: pointer; }
        .et-gate-form button:disabled { opacity: 0.4; cursor: default; }
      `}</style>
    </div>
  );
}
