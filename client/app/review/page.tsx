"use client";

// Weekly review — a guided sequence, not a dashboard (spec §3.8).
//
// The Worker returns the steps in order with their items attached, so this
// screen walks through cleanup, decisions, and focus rather than presenting
// numbers to admire. A step with nothing in it is shown as done, not hidden,
// because "nothing stalled" is itself the useful answer.

import { useEffect, useState } from "react";
import { getReview, type ReviewData } from "@/lib/api";

export default function ReviewPage() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  useEffect(() => { getReview().then(setData).catch(() => setData({ steps: [] })); }, []);

  function toggle(key: string) {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const total = data?.steps.length ?? 0;
  const complete = data ? data.steps.filter((s) => done.has(s.key) || s.items.length === 0).length : 0;

  return (
    <>
      <h1>Weekly review</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        Process what came in, decide what is next, then choose the week&apos;s focus.
      </p>

      {data && total > 0 && (
        <div className="card" style={{ marginBottom: 16, padding: "10px 14px" }}>
          <div className="kicker">Progress</div>
          <div style={{ fontWeight: 600 }}>{complete} of {total} steps clear</div>
        </div>
      )}

      {!data && <div className="card"><div className="skeleton" /><div className="skeleton" /></div>}

      {data?.steps.map((step) => {
        const clear = step.items.length === 0;
        const checked = done.has(step.key) || clear;
        return (
          <section className="section" key={step.key}>
            <div className="section-head">
              <button className={`blk-check ${checked ? "on" : ""}`} style={{ marginTop: 2 }}
                onClick={() => toggle(step.key)} aria-label={`Mark ${step.title} done`}>
                {checked ? "✓" : ""}
              </button>
              <span className="kicker">{step.title}</span>
              <span className="count">{step.items.length}</span>
            </div>
            <div className="card">
              {clear ? (
                <div className="empty"><strong>Clear</strong>Nothing needs attention here.</div>
              ) : (
                step.items.slice(0, 12).map((item, i) => (
                  <div className="row" key={i}>
                    <div className="lead">
                      <div className="title">{describe(item)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}

/** The steps carry heterogeneous records; show whichever label each one has. */
function describe(item: unknown): string {
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    return String(o.title ?? o.name ?? o.raw_input ?? o.id ?? "item");
  }
  return String(item);
}
