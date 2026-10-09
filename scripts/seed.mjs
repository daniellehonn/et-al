#!/usr/bin/env node
// Fill an et al. instance with sample data: some notes and tasks written by a
// person, saved links, and an agent's work — notes it created, tasks it added,
// and edits it proposed that wait in Review. Everything goes through /api and
// /mcp exactly as the web app and an agent would, so the agent's writes really
// are attributed to it and really need approving.
//
//   node scripts/seed.mjs                       # http://localhost:8787, key dev-key
//   ET_AL_URL=https://… ET_AL_API_KEY=… node scripts/seed.mjs
//
// Refuses to run against an instance that already has notes, unless --force.

const BASE = (process.env.ET_AL_URL ?? "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ET_AL_API_KEY ?? "dev-key";
const AGENT = "claude-code";
const DAY = 86_400_000;

async function call(path, method = "GET", body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": KEY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
const api = (path, method, body) => call(`/api${path}`, method, body);
let rpcId = 0;
async function agent(name, args) {
  const out = await call("/mcp", "POST", { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, { "x-mcp-client": AGENT });
  if (out.error) throw new Error(`${name}: ${out.error.message}`);
  return JSON.parse(out.result.content[0].text);
}

const existing = await api("/notes/tree");
if (existing.length && !process.argv.includes("--force")) {
  console.error(`${BASE} already has ${existing.length} root notes. Pass --force to seed anyway.`);
  process.exit(1);
}

// ---- what the person wrote ---------------------------------------------------

const project = await api("/notes", "POST", {
  title: "Building et al.",
  body: `# What it is
A knowledge base I own that agents work in. They can file, organise and plan; anything that changes what I wrote comes to me as a proposal.

# Open questions
- How much should the extractor suggest per link?
- Should agents be able to create notes with a body?
- [x] Decide on the search approach
- [ ] Write the design log

# Notes
Keyword search alone misses notes phrased differently from the query.`,
});
const search = await api("/notes", "POST", {
  parent_id: project.id,
  title: "Search design",
  body: `Two rankings: FTS5 for keywords, Vectorize for meaning.
- Fuse by rank, not score
- The vector side must never break search`,
});
const reading = await api("/notes", "POST", {
  title: "Reading list",
  body: `- Designing Data-Intensive Applications
- The Rust book, chapters 15–16
- Papers on retrieval-augmented generation`,
});
await api("/notes", "POST", {
  title: "Sourdough",
  body: `Feed 1:1 by weight, once a day at room temperature.
- Ready when it doubles in 4–8 hours
- Rye flour wakes up a sluggish starter`,
});

const now = Date.now();
const launch = await api("/tasks", "POST", { title: "Ship the review queue", note_id: project.id, due_at: now + 3 * DAY });
for (const title of ["Diff view for edits", "Keyboard shortcuts", "Stale-edit handling"]) {
  await api("/tasks", "POST", { title, parent_id: launch.id });
}
const done = await api("/tasks", "POST", { title: "Write the extraction eval", note_id: project.id });
await api(`/tasks/${done.id}`, "PATCH", { status: "done" });
const doing = await api("/tasks", "POST", { title: "Record the demo", due_at: now + DAY });
await api(`/tasks/${doing.id}`, "PATCH", { status: "doing" });
await api("/tasks", "POST", { title: "Renew passport", due_at: now - 2 * DAY });

await api("/share", "POST", { text: "Reciprocal rank fusion, the original paper https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf" });
await api("/share", "POST", { text: "Idea: let the extractor cite the sentence each fact came from" });
await api("/share", "POST", { text: "https://developers.cloudflare.com/workers-ai/features/json-mode/" });

// ---- what an agent did -------------------------------------------------------

// Writes it may make directly: a task, a capture, an empty note, filing.
await agent("create_task", { title: "Benchmark search with 10k notes", note_id: search.id });
await agent("capture", { text: "Myers diff algorithm, for when note bodies get large", key: "seed-myers" });
const glossary = await agent("create_note", { title: "Glossary", parent_id: project.id });

// Prose it may only propose.
await agent("propose_note_patch", {
  note_id: glossary.id,
  summary: "Draft a glossary of the terms used in the project",
  ops: [{ op: "replace_content", content: `- **Proposal**: a change an agent or the extractor suggests; nothing until accepted
- **Source**: something saved, waiting to be filed
- **RRF**: reciprocal rank fusion, how keyword and meaning results are combined` }],
});
const blocks = (await agent("get_note", { id: project.id })).blocks;
const idOf = (text) => blocks.find((b) => JSON.parse(b.content_json).text === text)?.id;
await agent("propose_note_patch", {
  note_id: project.id,
  summary: "Answer one open question and add a note on search",
  ops: [
    { op: "update", id: idOf("Should agents be able to create notes with a body?"), content: { text: "Should agents be able to create notes with a body? No: they create it empty and propose the body." } },
    { op: "insert", after: idOf("Keyword search alone misses notes phrased differently from the query."), type: "paragraph", content: { text: "Hybrid search fixes this: see Search design." } },
  ],
});
// Both inserts anchor on the list's last item; each lands directly after it,
// so the second op ends up first.
const lastRead = (await agent("get_note", { id: reading.id })).blocks.at(-1).id;
await agent("propose_note_patch", {
  note_id: reading.id,
  summary: "Add two papers on hybrid retrieval",
  ops: [
    { op: "insert", after: lastRead, type: "bullet", content: { text: "Lewis et al., Retrieval-Augmented Generation (2020)" } },
    { op: "insert", after: lastRead, type: "bullet", content: { text: "Cormack et al., Reciprocal Rank Fusion (2009)" } },
  ],
});

const count = (tree) => tree.reduce((n, t) => n + 1 + count(t.children ?? t.subtasks ?? []), 0);
const [notes, tasks, inbox, pending] = await Promise.all([api("/notes/tree"), api("/tasks"), api("/inbox"), api("/proposals")]);
console.log(`Seeded ${BASE}: ${count(notes)} notes, ${count(tasks)} tasks, ${inbox.length} saved links, ${pending.length} proposals waiting in Review.`);
