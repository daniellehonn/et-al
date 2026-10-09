"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "@/lib/api";

// Everything behind this needs a session: reads are keyed too, so rendering the
// app signed out would only show a screen of failed requests. The key is posted
// once to /api/login and lives only in the httpOnly cookie.
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["session"], queryFn: () => api.session(), staleTime: 60_000 });
  const [key, setKey] = useState("");
  const [error, setError] = useState(false);

  if (data === undefined) return null; // still checking — render nothing rather than fetch and fail
  if (data.authed) return <>{children}</>;

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
      <div className="et-gate-card">
        <span className="eyebrow">et al.</span>
        <h1 className="serif et-gate-h">Sign in</h1>
        <form onSubmit={(e) => { e.preventDefault(); if (key.trim()) unlock(); }} className="et-gate-form">
          <input id="et-gate-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" aria-label="API key" data-error={error} autoFocus />
          <button type="submit" disabled={!key.trim()}>Sign in</button>
        </form>
        {error && <p className="et-gate-err">That key wasn't accepted. Check it against ET_AL_API_KEY.</p>}
      </div>
      <style>{`
        .et-gate { min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem; background: var(--paper); }
        .et-gate-card { width: min(100%, 22rem); display: grid; gap: 0.9rem; }
        .et-gate-h { font-size: 2.6rem; line-height: 1; margin: 0; }
        .et-gate-form { display: flex; gap: 0.4rem; }
        .et-gate-form input { flex: 1; min-width: 0; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 7px; padding: 0.45rem 0.7rem; font: inherit; font-size: 0.9rem; color: var(--ink); }
        .et-gate-form input[data-error="true"] { border-color: var(--color-amber); }
        .et-gate-form input:focus { outline: none; border-color: var(--color-iris); }
        .et-gate-form button { background: var(--ink); color: var(--paper); border: none; border-radius: 7px; padding: 0.45rem 1rem; font: inherit; font-size: 0.9rem; cursor: pointer; }
        .et-gate-form button:disabled { opacity: 0.4; cursor: default; }
        .et-gate-err { margin: 0; font-size: 0.82rem; color: var(--color-amber); }
      `}</style>
    </div>
  );
}
