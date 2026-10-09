// Extraction eval: run the real extractor (src/extract.ts, real Workers AI
// model) over the fixtures and score it.
//
//   recall     expected facts found / expected facts
//   precision  extracted facts that match an expected one / extracted facts
//              (on fixtures that have expectations)
//   noise      facts produced on fixtures with nothing durable in them
//
// Run with `npm run eval`. It calls Workers AI on your Cloudflare account, so it
// is not part of `npm test` or CI. It writes its report to eval/results/latest.md
// (a file snapshot, refreshed by -u on every run) and does not fail on a score.
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { extractFactsDetailed, type ExtractOutcome } from "../src/extract";
import type { InsightPayload } from "../src/schema";
import { FIXTURES, type Fixture } from "./fixtures";

const matches = (fact: InsightPayload, groups: Fixture["expect"][number]) => {
  const hay = `${fact.title} ${fact.content}`.toLowerCase();
  return groups.every((g) => (Array.isArray(g) ? g : [g]).some((alt) => hay.includes(alt.toLowerCase())));
};

it("scores extraction", { timeout: 300_000 }, async () => {
  const model = env.EXTRACT_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const rows: string[] = [];
  let expected = 0, found = 0, extracted = 0, relevant = 0, noise = 0, noiseFixtures = 0;
  const outcomes: Record<string, number> = {};
  const failures: string[] = [];

  for (const f of FIXTURES) {
    const { facts, outcome, raw } = await extractFactsDetailed(env, f.title, f.text);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (outcome === "error" || outcome === "unparsable") failures.push(`- **${f.id}** (${outcome}, ${(raw ?? "").length} chars): starts \`${(raw ?? "").replace(/\s+/g, " ").slice(0, 80)}\` … ends \`${(raw ?? "").replace(/\s+/g, " ").slice(-120)}\``);
    const tag = (o: ExtractOutcome) => (o === "facts" ? "" : ` (${o})`);
    if (!f.expect.length) {
      noiseFixtures++;
      noise += facts.length;
      rows.push(`| ${f.id} | — | ${facts.length}${tag(outcome)} | ${facts.length ? "✗ " + facts.map((x) => x.title).join("; ") : "✓ none"} |`);
      continue;
    }
    const hit = f.expect.filter((g) => facts.some((x) => matches(x, g))).length;
    const useful = facts.filter((x) => f.expect.some((g) => matches(x, g))).length;
    expected += f.expect.length; found += hit; extracted += facts.length; relevant += useful;
    const missed = f.expect.filter((g) => !facts.some((x) => matches(x, g)))
      .map((g) => g.map((x) => (Array.isArray(x) ? x[0] : x)).join("+"));
    rows.push(`| ${f.id} | ${hit}/${f.expect.length} | ${facts.length}${tag(outcome)} | ${missed.length ? "missed " + missed.join(", ") : ""} |`);
  }

  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const report = [
    `# Extraction eval`,
    "",
    `${model}, ${FIXTURES.length} fixtures, run ${new Date().toISOString().slice(0, 10)}.`,
    "",
    "| fixture | expected found | facts | notes |",
    "|---|---|---|---|",
    ...rows,
    "",
    `recall    ${pct(found, expected)}  (${found}/${expected} expected facts found)`,
    `precision ${pct(relevant, extracted)}  (${relevant}/${extracted} extracted facts matched an expected one)`,
    `noise     ${noise} facts across ${noiseFixtures} fixtures with nothing durable`,
    `outcomes  ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    "",
    ...(failures.length ? ["Failures (the model's reply, or the error):", "", ...failures, ""] : []),
  ].join("\n");
  await expect(report).toMatchFileSnapshot("results/latest.md");
});
