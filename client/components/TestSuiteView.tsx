"use client";
// The test suite, as last run: every test with its result, what each file is
// for, and the extraction eval. A deployed Worker cannot run the suite — it
// needs Node and a local workerd — so this reads the report `npm run test:report`
// writes, which `npm run deploy` produces on every deploy.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

interface TestCase { path: string[]; title: string; status: string; duration_ms: number; failure: string | null }
interface TestFile { file: string; purpose: string | null; status: string; duration_ms: number; message: string | null; tests: TestCase[] }
interface Report {
  generated_at: string; commit: string | null; commit_subject: string | null; uncommitted_changes: boolean; success: boolean;
  totals: { tests: number; passed: number; failed: number; skipped: number; files: number; duration_ms: number };
  files: TestFile[];
  eval: { about: string | null; recall: string | null; precision: string | null; noise: string | null; rows: Array<{ fixture: string; found: string; facts: string; notes: string }> } | null;
}

const REPO = "https://github.com/daniellehonn/et-al";
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function TestSuiteView() {
  const { data: report, isLoading, error } = useQuery({
    queryKey: ["test-report"],
    // A static file shipped with the app, not an API route.
    queryFn: async () => {
      const res = await fetch("/test-report.json", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<Report>;
    },
    retry: false,
  });
  const [query, setQuery] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);

  if (isLoading) return <div className="et-ts"><p className="et-empty">Loading…</p><TestSuiteStyles /></div>;
  if (error || !report) {
    return (
      <div className="et-ts">
        <header><div className="eyebrow">Test suite</div><h1 className="serif">No report yet</h1></header>
        <p className="et-ts-lede">This page shows the last run of the suite. Run <code>npm run test:report</code> and rebuild the app, or deploy — <code>npm run deploy</code> runs the suite first.</p>
        <HowToRun />
        <TestSuiteStyles />
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (f: TestFile, t: TestCase) =>
    (!failuresOnly || t.status === "failed") &&
    (!q || `${f.file} ${t.path.join(" ")} ${t.title}`.toLowerCase().includes(q));
  const files = report.files
    .map((f) => ({ ...f, shown: f.tests.filter((t) => matches(f, t)) }))
    .filter((f) => f.shown.length || (!q && !failuresOnly));

  return (
    <div className="et-ts">
      <header>
        <div className="eyebrow">Test suite</div>
        <h1 className="serif">Tests</h1>
        <p className="et-ts-lede">
          Every test runs inside workerd — the runtime the app deploys to — against a real D1 database with every migration applied. They call the API and the MCP endpoint the way the web app and agents do.
        </p>
      </header>

      <section className="et-ts-summary" data-ok={report.success}>
        <div className="et-ts-big">
          <span className="et-ts-big-num">{report.totals.passed}<span>/{report.totals.tests}</span></span>
          <span className="et-ts-big-label">{report.success ? "passing" : `passing · ${report.totals.failed} failing`}</span>
        </div>
        <dl>
          <dt>Files</dt><dd>{report.totals.files}</dd>
          <dt>Took</dt><dd>{secs(report.totals.duration_ms)}</dd>
          <dt>Ran</dt><dd>{new Date(report.generated_at).toLocaleString()}</dd>
          <dt>Commit</dt>
          <dd>
            {report.commit ? <a href={`${REPO}/commit/${report.commit}`} target="_blank" rel="noopener noreferrer"><code>{report.commit}</code></a> : "unknown"}
            {report.commit_subject && <span className="et-ts-subject"> {report.commit_subject}</span>}
            {report.uncommitted_changes && <span className="et-ts-dirty"> plus uncommitted changes</span>}
          </dd>
          <dt>CI</dt><dd><a href={`${REPO}/actions/workflows/ci.yml`} target="_blank" rel="noopener noreferrer">every push, on GitHub</a></dd>
        </dl>
      </section>

      <div className="et-ts-tools">
        <input id="et-ts-filter" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tests…" aria-label="Filter tests" />
        <label><input id="et-ts-failures" type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} /> Failures only</label>
      </div>

      {files.map((f) => <FileCard key={f.file} file={f} shown={f.shown} open={!!q || failuresOnly || f.status !== "passed"} />)}
      {!files.length && <p className="et-empty">{failuresOnly ? "No failures." : "No tests match."}</p>}

      {report.eval && <EvalSection ev={report.eval} />}
      <HowToRun />
      <TestSuiteStyles />
    </div>
  );
}

function FileCard({ file: f, shown, open }: { file: TestFile; shown: TestCase[]; open: boolean }) {
  const passed = f.tests.filter((t) => t.status === "passed").length;
  // Group by the describe() path, keeping file order.
  const groups: Array<{ path: string; tests: TestCase[] }> = [];
  for (const t of shown) {
    const path = t.path.join(" › ");
    const g = groups.find((x) => x.path === path);
    if (g) g.tests.push(t); else groups.push({ path, tests: [t] });
  }
  return (
    <details className="et-ts-file" data-status={f.status} open={open}>
      <summary>
        <span className="et-ts-dot" data-status={f.status} aria-hidden />
        <span className="et-ts-file-name">{f.file.replace(/^test\//, "")}</span>
        <span className="et-ts-file-count">{passed}/{f.tests.length}</span>
        <span className="et-ts-file-time">{secs(f.duration_ms)}</span>
        {f.purpose && <span className="et-ts-file-purpose">{f.purpose}</span>}
      </summary>
      {f.message && <pre className="et-ts-failure">{f.message}</pre>}
      {groups.map((g) => (
        <div key={g.path} className="et-ts-group">
          {g.path && <div className="et-ts-group-name">{g.path}</div>}
          {g.tests.map((t, i) => (
            <div key={i} className="et-ts-test" data-status={t.status}>
              <span className="et-ts-mark" aria-label={t.status}>{t.status === "passed" ? "✓" : t.status === "failed" ? "✗" : "–"}</span>
              <span className="et-ts-test-title">{t.title}</span>
              <span className="et-ts-test-time">{secs(t.duration_ms)}</span>
              {t.failure && <pre className="et-ts-failure">{t.failure}</pre>}
            </div>
          ))}
        </div>
      ))}
    </details>
  );
}

function EvalSection({ ev }: { ev: NonNullable<Report["eval"]> }) {
  const num = (s: string | null) => s?.split(/\s+/)[0] ?? "—";
  return (
    <section className="et-ts-eval">
      <div className="eyebrow">Extraction eval</div>
      <h2 className="serif">How well links are read</h2>
      <p className="et-ts-lede">
        Not part of the suite: it calls the real model, so it is run by hand with <code>npm run eval</code>. 20 fixtures — 15 with facts a good extraction should find, 5 with nothing durable in them. {ev.about && <span className="et-ts-subject">{ev.about}</span>}
      </p>
      <div className="et-ts-eval-nums">
        <div><span>{num(ev.recall)}</span>recall</div>
        <div><span>{num(ev.precision)}</span>precision</div>
        <div><span>{num(ev.noise)}</span>facts invented from empty pages</div>
      </div>
      <div className="et-ts-eval-table">
        <table>
          <thead><tr><th>Fixture</th><th>Expected found</th><th>Facts</th><th>Notes</th></tr></thead>
          <tbody>{ev.rows.map((r) => <tr key={r.fixture}><td><code>{r.fixture}</code></td><td>{r.found}</td><td>{r.facts}</td><td>{r.notes}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function HowToRun() {
  return (
    <section className="et-ts-run">
      <div className="eyebrow">Run it yourself</div>
      <pre>{`npm test                 # the suite, in workerd (~15 s)
npm run test:watch       # re-run on save
npm run test:report      # the suite, and refresh this page's report
npm run typecheck        # Worker, tests and eval
(cd client && npx tsc --noEmit)   # the web app
npm run eval             # extraction eval — calls Workers AI, needs wrangler login`}</pre>
    </section>
  );
}

function TestSuiteStyles() {
  return (
    <style jsx global>{`
      .et-ts { max-width: 56rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
      @media (max-width: 860px) { .et-ts { padding: 3.5rem 1.1rem 5rem; } }
      .et-ts h1 { font-size: 2.4rem; margin: 0.3rem 0 0.5rem; }
      .et-ts h2 { font-size: 1.8rem; margin: 0.3rem 0 0.4rem; }
      .et-ts-lede { color: var(--ink-soft); font-size: 0.92rem; max-width: 42rem; margin: 0 0 1.5rem; }
      .et-ts code { font-family: var(--font-mono); font-size: 0.82em; }
      .et-ts-summary { display: flex; flex-wrap: wrap; gap: 1.5rem 2.5rem; align-items: center; border: 1px solid var(--line); border-left: 4px solid var(--color-sage); border-radius: 10px; padding: 1rem 1.2rem; background: var(--paper-raised); }
      .et-ts-summary[data-ok="false"] { border-left-color: #c0392b; }
      .et-ts-big { display: flex; flex-direction: column; }
      .et-ts-big-num { font-family: var(--font-display); font-size: 3rem; line-height: 1; font-variant-numeric: tabular-nums; }
      .et-ts-big-num span { color: var(--ink-faint); font-size: 1.6rem; }
      .et-ts-big-label { font-family: var(--font-mono); font-size: 0.75rem; color: var(--color-sage); letter-spacing: 0.06em; }
      .et-ts-summary[data-ok="false"] .et-ts-big-label { color: #c0392b; }
      .et-ts-summary dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.25rem 1rem; margin: 0; font-size: 0.86rem; flex: 1; min-width: 16rem; }
      .et-ts-summary dt { color: var(--ink-faint); }
      .et-ts-summary dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
      .et-ts-summary a { color: var(--color-iris); }
      .et-ts-subject { color: var(--ink-soft); }
      .et-ts-dirty { color: var(--color-amber); }
      .et-ts-tools { display: flex; gap: 1rem; align-items: center; margin: 1.6rem 0 0.8rem; flex-wrap: wrap; }
      .et-ts-tools input[type="text"], .et-ts-tools input:not([type]) { flex: 1; min-width: 12rem; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 8px; padding: 0.5rem 0.75rem; font: inherit; font-size: 0.9rem; color: var(--ink); }
      .et-ts-tools label { font-size: 0.85rem; color: var(--ink-soft); display: flex; gap: 0.35rem; align-items: center; }
      .et-ts-file { border-bottom: 1px solid var(--line); }
      .et-ts-file summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: 0.8rem minmax(0, 1fr) auto auto; gap: 0.2rem 0.8rem; align-items: baseline; padding: 0.75rem 0.2rem; }
      .et-ts-file summary::-webkit-details-marker { display: none; }
      .et-ts-dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--color-sage); align-self: center; }
      .et-ts-dot[data-status="failed"] { background: #c0392b; }
      .et-ts-file-name { font-family: var(--font-mono); font-size: 0.88rem; }
      .et-ts-file-count, .et-ts-file-time, .et-ts-test-time { font-family: var(--font-mono); font-size: 0.75rem; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
      .et-ts-file-purpose { grid-column: 2 / -1; font-size: 0.84rem; color: var(--ink-soft); }
      .et-ts-group { padding: 0 0 0.6rem 1.6rem; }
      .et-ts-group-name { font-size: 0.78rem; color: var(--ink-faint); margin: 0.3rem 0 0.15rem; }
      .et-ts-test { display: grid; grid-template-columns: 1.1rem minmax(0, 1fr) auto; gap: 0.5rem; padding: 0.18rem 0; font-size: 0.86rem; }
      .et-ts-mark { color: var(--color-sage); font-weight: 600; }
      .et-ts-test[data-status="failed"] .et-ts-mark { color: #c0392b; }
      .et-ts-test[data-status="skipped"] .et-ts-mark, .et-ts-test[data-status="todo"] .et-ts-mark { color: var(--ink-faint); }
      .et-ts-failure { grid-column: 1 / -1; white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.74rem; background: color-mix(in srgb, #c0392b 8%, transparent); border-radius: 6px; padding: 0.5rem 0.7rem; margin: 0.3rem 0; max-height: 16rem; overflow: auto; }
      .et-ts-eval { margin-top: 3rem; }
      .et-ts-eval-nums { display: flex; gap: 2.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
      .et-ts-eval-nums div { display: flex; flex-direction: column; font-size: 0.78rem; color: var(--ink-faint); font-family: var(--font-mono); }
      .et-ts-eval-nums span { font-family: var(--font-display); font-size: 2.2rem; color: var(--ink); line-height: 1.1; font-variant-numeric: tabular-nums; }
      .et-ts-eval-table { overflow-x: auto; }
      .et-ts-eval-table table { width: 100%; border-collapse: collapse; font-size: 0.82rem; min-width: 34rem; }
      .et-ts-eval-table th, .et-ts-eval-table td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
      .et-ts-eval-table th { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); font-weight: 500; }
      .et-ts-run { margin-top: 3rem; }
      .et-ts-run pre { font-family: var(--font-mono); font-size: 0.8rem; background: var(--paper-raised); border: 1px solid var(--line); border-radius: 8px; padding: 0.8rem 1rem; overflow-x: auto; margin-top: 0.5rem; }
    `}</style>
  );
}
