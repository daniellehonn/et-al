"use client";

// Global session guard.
//
// Reading is open; writing needs the API key. That asymmetry meant an
// unauthenticated visitor saw a completely normal-looking app in which every
// save silently did nothing — the worst possible failure, because it looks like
// the product is broken rather than locked.
//
// This listens for the 401 signal any request can raise, and puts an unlock
// prompt in front of the user wherever they happen to be.

import { useCallback, useEffect, useState } from "react";
import { getSession, login } from "@/lib/api";

export default function AuthGate() {
  const [locked, setLocked] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => setLocked(true);
    window.addEventListener("et-al:unauthorized", onUnauthorized);
    // Check once on load so the prompt appears before a write is attempted,
    // not only after one has already failed.
    getSession().then((s) => { if (!s.authenticated) setLocked(true); }).catch(() => {});
    return () => window.removeEventListener("et-al:unauthorized", onUnauthorized);
  }, []);

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(key);
      setLocked(false);
      setKey("");
      // Anything rendered before unlocking may have failed to load; a reload is
      // the honest way to get a consistent view rather than a partial one.
      window.location.reload();
    } catch {
      setError("That key was not accepted.");
    } finally {
      setBusy(false);
    }
  }, [key]);

  if (!locked) return null;

  return (
    <div className="gate-backdrop" role="dialog" aria-modal="true" aria-label="Unlock">
      <form className="unlock" onSubmit={submit}>
        <h2>Unlock to make changes</h2>
        <p style={{ color: "var(--ink-2)", fontSize: 13.5, margin: "6px 0 0" }}>
          Reading is open, but saving, editing, and deleting need your API key.
          Without it, changes would fail silently.
        </p>
        <input
          type="password" value={key} onChange={(e) => setKey(e.target.value)}
          placeholder="API key" aria-label="API key" autoFocus
        />
        {error && <div className="error-box" style={{ marginBottom: 10 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" type="submit" disabled={busy || !key}>
            {busy ? "Checking…" : "Unlock"}
          </button>
          <button className="btn" type="button" onClick={() => setLocked(false)}>
            Keep reading
          </button>
        </div>
      </form>
    </div>
  );
}
