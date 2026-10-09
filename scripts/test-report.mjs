#!/usr/bin/env node
// Run the test suite and write what the /test-suite page shows:
// client/public/test-report.json — every test with its result and duration,
// what each test file is for (its header comment), the commit it ran against,
// and the latest extraction eval.
//
// Exits with the suite's own status, so `npm run deploy` (which runs this first)
// refuses to ship code whose tests fail. A deployed Worker cannot run the suite
// itself — it needs Node and a local workerd — so the page shows this run.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const raw = join(mkdtempSync(join(tmpdir(), "et-al-tests-")), "vitest.json");

const run = spawnSync("npx", ["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile=${raw}`], {
  cwd: root, stdio: "inherit",
});
if (!existsSync(raw)) {
  console.error("vitest wrote no results; nothing to report.");
  process.exit(run.status ?? 1);
}
const results = JSON.parse(readFileSync(raw, "utf8"));

const git = (...args) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } };
const dirty = git("status", "--porcelain") ? true : false;

/** A test file's purpose: its leading // comment, as one paragraph. */
function purpose(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const out = [];
  for (const l of lines) { if (!l.startsWith("//")) break; out.push(l.replace(/^\/\/\s?/, "")); }
  return out.join(" ").trim() || null;
}

/** The headline numbers and per-fixture rows from eval/results/latest.md. */
function evalSummary() {
  const p = join(root, "eval/results/latest.md");
  if (!existsSync(p)) return null;
  const md = readFileSync(p, "utf8");
  const pick = (label) => md.match(new RegExp(`^${label}\\s+(.+)$`, "m"))?.[1]?.trim() ?? null;
  const rows = md.split("\n")
    .filter((l) => /^\| [a-z0-9-]+ \|/.test(l))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .map(([fixture, found, facts, notes]) => ({ fixture, found, facts, notes }));
  return { about: md.split("\n").find((l) => l.startsWith("@cf/")) ?? null, recall: pick("recall"), precision: pick("precision"), noise: pick("noise"), rows };
}

const files = results.testResults.map((f) => ({
  file: relative(root, f.name),
  purpose: purpose(f.name),
  status: f.status,
  duration_ms: Math.round(f.endTime - f.startTime),
  message: f.message || null,
  tests: f.assertionResults.map((t) => ({
    path: t.ancestorTitles,
    title: t.title,
    status: t.status,
    duration_ms: Math.round(t.duration ?? 0),
    failure: t.failureMessages?.length ? t.failureMessages.join("\n").slice(0, 2000) : null,
  })),
})).sort((a, b) => a.file.localeCompare(b.file));

const report = {
  generated_at: new Date().toISOString(),
  commit: git("rev-parse", "--short", "HEAD"),
  commit_subject: git("log", "-1", "--format=%s"),
  uncommitted_changes: dirty,
  success: results.success,
  totals: {
    tests: results.numTotalTests, passed: results.numPassedTests, failed: results.numFailedTests,
    skipped: results.numPendingTests + results.numTodoTests, files: files.length,
    duration_ms: Math.max(...results.testResults.map((f) => f.endTime)) - results.startTime,
  },
  files,
  eval: evalSummary(),
};

writeFileSync(join(root, "client/public/test-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\nWrote client/public/test-report.json: ${report.totals.passed}/${report.totals.tests} passed at ${report.commit}${dirty ? " (+ uncommitted changes)" : ""}.`);
process.exit(run.status ?? (results.success ? 0 : 1));
