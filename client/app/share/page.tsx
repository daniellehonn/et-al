"use client";
import { useEffect, useRef, useState } from "react";
import { api, props, type Page } from "@/lib/api";

// The landing surface for a shared link: /share/?url=...&title=...&text=...
//
// A Shortcut that posts straight to /api/share is silent and faster, and is the
// recommended setup (see docs/IOS-SHARE.md). This page exists for the variant
// that opens the app instead — it needs no API key in the Shortcut, because the
// session cookie already authorizes the write, and it gives visible confirmation
// that the capture landed.
//
// Query params are read from window.location rather than useSearchParams: this
// route is statically exported, and useSearchParams would force a Suspense
// boundary and a client-side bailout for no gain.
export default function SharePage() {
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("");
  const [source, setSource] = useState<Page | null>(null);
  // React 18 StrictMode double-invokes effects in dev; without this guard a
  // single share would capture twice.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const q = new URLSearchParams(window.location.search);
    const payload = { url: q.get("url"), title: q.get("title"), text: q.get("text") };
    if (!payload.url && !payload.text && !payload.title) {
      setState("error");
      setMessage("Nothing was shared.");
      return;
    }

    api.post<Page>("/share", payload)
      .then((s) => { setSource(s); setState("done"); })
      .catch((e: Error & { status?: number }) => {
        setState("error");
        setMessage(e.status === 401
          ? "This app isn't unlocked. Open et al., unlock it, then share again."
          : e.message);
      });
  }, []);

  return (
    <div className="et-share">
      {state === "working" && <p className="et-share-msg">Capturing…</p>}

      {state === "done" && (
        <>
          <div className="et-share-tick">✓</div>
          <h1 className="serif et-share-h">Captured</h1>
          <p className="et-share-detail">{source ? source.title || String(props(source).url ?? "") : ""}</p>
          <p className="et-share-msg">It&rsquo;s in your inbox, waiting to be filed.</p>
          <div className="et-share-actions">
            <a className="et-share-btn" href="/inbox/">Open inbox</a>
            {/* On iOS a shared page has no opener to close back to, so offer the
                app rather than a close button that would silently do nothing. */}
            <a className="et-share-btn" data-quiet href="/">Home</a>
          </div>
        </>
      )}

      {state === "error" && (
        <>
          <div className="et-share-tick" data-bad>!</div>
          <h1 className="serif et-share-h">Not captured</h1>
          <p className="et-share-msg">{message}</p>
          <div className="et-share-actions"><a className="et-share-btn" href="/">Open et al.</a></div>
        </>
      )}

      <style>{`
        .et-share { max-width: 30rem; margin: 0 auto; padding: 4rem 1.5rem; text-align: center; }
        .et-share-tick { font-size: 2.6rem; line-height: 1; color: var(--color-sage); }
        .et-share-tick[data-bad] { color: var(--color-amber); }
        .et-share-h { font-size: 2rem; margin: 0.6rem 0 0.4rem; }
        .et-share-detail { color: var(--ink); font-size: 0.95rem; margin: 0 0 0.5rem; overflow-wrap: anywhere; }
        .et-share-msg { color: var(--ink-soft); font-size: 0.9rem; margin: 0; }
        .et-share-actions { display: flex; gap: 0.6rem; justify-content: center; margin-top: 1.8rem; }
        .et-share-btn {
          background: var(--color-iris); color: #fff; text-decoration: none;
          border-radius: 9px; padding: 0.6rem 1.2rem; font-size: 0.92rem;
        }
        .et-share-btn[data-quiet] { background: none; color: var(--ink-soft); border: 1px solid var(--line-strong); }
      `}</style>
    </div>
  );
}
