// Markdown export.
//
// v6 made D1 canonical, which means R2 is no longer a recovery path — losing D1
// loses data. This module is therefore the ONLY real backup story, and it is
// treated as such: exports carry stable ids, typed frontmatter, and relations by
// both id and human-readable title, so an archive can be read by a person and
// re-imported by a machine (spec §6.3).
//
// The format is deliberately Obsidian-compatible: frontmatter plus body, with
// [[wikilinks]] intact. A vault of these files should be useful even if this
// application disappears — which is the point of "portable by design" (§1.5).

import { asc, eq, and } from "drizzle-orm";
import {
  projects, projectLogs, knowledgeNotes, contentItems, tools, sources,
  areas, goals, relations, documentBlocks, projectAreas, projectGoals,
} from "./schema.ts";
import { type Env, getDb, type SubjectType } from "./store/index.ts";

export interface ExportedFile {
  path: string;
  content: string;
}

/** YAML-safe scalar. Quotes anything that could be misread as structure. */
function yamlValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const s = String(value);
  if (s === "") return '""';
  if (/^[\w.@/-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlValue(item)}`);
    } else {
      lines.push(`${key}: ${yamlValue(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function isoDate(unix: number | null): string | null {
  return unix ? new Date(unix * 1000).toISOString() : null;
}

/** Filesystem-safe slug that still reads like the title. */
export function slugify(title: string): string {
  return String(title ?? "untitled")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "untitled";
}

/** Blocks back to markdown. Mirrors the client's block vocabulary. */
async function bodyMarkdown(env: Env, documentId: string | null): Promise<string> {
  if (!documentId) return "";
  const rows = await getDb(env).select().from(documentBlocks)
    .where(eq(documentBlocks.documentId, documentId)).orderBy(asc(documentBlocks.position));

  const out: string[] = [];
  let n = 0;
  for (const b of rows) {
    if (b.type !== "number") n = 0;
    const data = safeJson(b.data);
    switch (b.type) {
      case "heading": out.push("#".repeat(Number(data.level ?? 2)) + " " + b.text); break;
      case "todo": out.push("- [ ] " + b.text); break;
      case "todo-done": out.push("- [x] " + b.text); break;
      case "bullet": out.push("- " + b.text); break;
      case "number": out.push(`${++n}. ${b.text}`); break;
      case "quote": out.push("> " + b.text); break;
      case "callout": out.push("> [!note] " + b.text); break;
      case "divider": out.push("---"); break;
      case "code": out.push("```" + String(data.lang ?? "") + "\n" + b.text + "\n```"); break;
      default:
        // Product blocks keep their fields as a labelled list, so a Decision
        // exported to Markdown still reads as a decision and not a paragraph.
        if (Object.keys(data).length) {
          out.push(`> [!${b.type}] ${b.text}`);
          for (const [k, v] of Object.entries(data)) {
            if (v === "" || v === null || v === undefined) continue;
            out.push(`> **${k.replace(/_/g, " ")}:** ${Array.isArray(v) ? v.join(", ") : String(v)}`);
          }
        } else {
          out.push(b.text);
        }
    }
    // Generated content stays labelled in the export too.
    if (b.isAi) out.push("<!-- ai-generated -->");
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** Outgoing relations as `type: [[Title]]` lines, plus stable ids. */
async function relationLines(
  env: Env, userId: string, sourceType: SubjectType, sourceId: string,
  titles: Map<string, string>,
): Promise<{ list: string[]; ids: string[] }> {
  const rows = await getDb(env).select().from(relations)
    .where(and(
      eq(relations.userId, userId),
      eq(relations.sourceType, sourceType),
      eq(relations.sourceId, sourceId),
    ));
  const list: string[] = [];
  const ids: string[] = [];
  for (const r of rows) {
    const title = r.targetId ? titles.get(r.targetId) : null;
    list.push(`${r.relationType}: ${title ? `[[${title}]]` : (r.targetNorm ?? "?")}`);
    if (r.targetId) ids.push(`${r.relationType}:${r.targetId}`);
  }
  return { list, ids };
}

/**
 * Builds the complete archive as an array of files.
 *
 * Everything is read up front so relations can be rendered with real titles
 * rather than bare UUIDs — an archive full of ids would be technically complete
 * and humanly useless.
 */
export async function buildExport(env: Env, userId: string): Promise<ExportedFile[]> {
  const db = getDb(env);
  const files: ExportedFile[] = [];

  const [areaRows, goalRows, projectRows, logRows, noteRows, toolRows, sourceRows, contentRows] =
    await Promise.all([
      db.select().from(areas).where(eq(areas.userId, userId)),
      db.select().from(goals).where(eq(goals.userId, userId)),
      db.select().from(projects).where(eq(projects.userId, userId)),
      db.select().from(projectLogs).where(eq(projectLogs.userId, userId)),
      db.select().from(knowledgeNotes).where(eq(knowledgeNotes.userId, userId)),
      db.select().from(tools).where(eq(tools.userId, userId)),
      db.select().from(sources).where(eq(sources.userId, userId)),
      db.select().from(contentItems).where(eq(contentItems.userId, userId)),
    ]);

  // Title lookup so relations export as readable wikilinks.
  const titles = new Map<string, string>();
  for (const r of projectRows) titles.set(r.id, r.title);
  for (const r of noteRows) titles.set(r.id, r.title);
  for (const r of contentRows) titles.set(r.id, r.title);
  for (const r of toolRows) titles.set(r.id, r.name);
  for (const r of sourceRows) titles.set(r.id, r.title);
  const areaNames = new Map(areaRows.map((a) => [a.id, a.name]));
  const goalTitles = new Map(goalRows.map((g) => [g.id, g.title]));

  const [projectAreaRows, projectGoalRows] = await Promise.all([
    db.select().from(projectAreas),
    db.select().from(projectGoals),
  ]);

  // ---- areas ----
  for (const a of areaRows) {
    files.push({
      path: `areas/${slugify(a.name)}.md`,
      content: frontmatter({
        id: a.id, type: "area", name: a.name, status: a.status,
        icon: a.icon, updated_at: isoDate(a.updatedAt),
      }) + `# ${a.name}\n\n${a.description ?? ""}\n`,
    });
  }

  // ---- goals ----
  for (const g of goalRows) {
    files.push({
      path: `goals/${slugify(g.title)}.md`,
      content: frontmatter({
        id: g.id, type: "goal", title: g.title, goal_type: g.type,
        timeframe: g.timeframe, status: g.status,
        area: g.areaId ? areaNames.get(g.areaId) : null,
        metric: g.metricName, target: g.targetValue, current: g.currentValue,
        updated_at: isoDate(g.updatedAt),
      }) + `# ${g.title}\n`,
    });
  }

  // ---- projects (+ their logs nested beneath) ----
  for (const p of projectRows) {
    const rel = await relationLines(env, userId, "project", p.id, titles);
    const slug = slugify(p.title);
    files.push({
      path: `projects/${slug}/${slug}.md`,
      content: frontmatter({
        id: p.id, type: "project", title: p.title, status: p.status,
        summary: p.summary, next_action: p.nextAction, priority: p.priority,
        areas: projectAreaRows.filter((r) => r.projectId === p.id).map((r) => areaNames.get(r.areaId) ?? r.areaId),
        goals: projectGoalRows.filter((r) => r.projectId === p.id).map((r) => goalTitles.get(r.goalId) ?? r.goalId),
        repository_url: p.repositoryUrl, live_url: p.liveUrl,
        portfolio_ready: !!p.portfolioReady,
        start_date: isoDate(p.startDate), target_date: isoDate(p.targetDate),
        completed_at: isoDate(p.completedAt),
        relations: rel.ids,
        created_at: isoDate(p.createdAt), updated_at: isoDate(p.updatedAt),
      }) + `# ${p.title}\n\n${p.summary ? p.summary + "\n\n" : ""}` +
        (p.nextAction ? `**Next action:** ${p.nextAction}\n\n` : "") +
        (await bodyMarkdown(env, p.bodyDocumentId)) +
        (rel.list.length ? `\n## Connections\n\n${rel.list.map((l) => `- ${l}`).join("\n")}\n` : ""),
    });

    for (const log of logRows.filter((l) => l.projectId === p.id)) {
      const date = new Date(log.createdAt * 1000).toISOString().slice(0, 10);
      files.push({
        path: `projects/${slug}/log/${date}-${slugify(log.title ?? log.entryType)}.md`,
        content: frontmatter({
          id: log.id, type: "project_log", entry_type: log.entryType,
          title: log.title, project: p.title, project_id: p.id,
          created_at: isoDate(log.createdAt),
        }) + `# ${log.title ?? log.entryType}\n\n${await bodyMarkdown(env, log.bodyDocumentId)}`,
      });
    }
  }

  // ---- knowledge notes ----
  for (const n of noteRows) {
    const rel = await relationLines(env, userId, "knowledge_note", n.id, titles);
    files.push({
      path: `knowledge/${slugify(n.title)}.md`,
      content: frontmatter({
        id: n.id, type: "knowledge_note", title: n.title,
        note_type: n.noteType, mastery: n.mastery,
        ai_sections: Object.keys(safeJson(n.aiSections)),
        relations: rel.ids,
        created_at: isoDate(n.createdAt), updated_at: isoDate(n.updatedAt),
      }) + `# ${n.title}\n\n${await bodyMarkdown(env, n.bodyDocumentId)}` +
        (rel.list.length ? `\n## Connections\n\n${rel.list.map((l) => `- ${l}`).join("\n")}\n` : ""),
    });
  }

  // ---- tools ----
  for (const t of toolRows) {
    files.push({
      path: `library/tools/${slugify(t.name)}.md`,
      content: frontmatter({
        id: t.id, type: "tool", name: t.name, url: t.url, status: t.status,
        rating: t.rating, tested_at: isoDate(t.testedAt), updated_at: isoDate(t.updatedAt),
      }) + `# ${t.name}\n\n` +
        (t.expectedUse ? `## Expected use\n\n${t.expectedUse}\n\n` : "") +
        (t.testCriteria ? `## Test criteria\n\n${t.testCriteria}\n\n` : "") +
        (t.verdict ? `## Verdict\n\n${t.verdict}\n` : ""),
    });
  }

  // ---- sources ----
  for (const s of sourceRows) {
    files.push({
      path: `library/sources/${slugify(s.title)}.md`,
      content: frontmatter({
        id: s.id, type: "source", title: s.title, url: s.url,
        platform: s.platform, author: s.author,
        published_at: isoDate(s.publishedAt), updated_at: isoDate(s.updatedAt),
      }) + `# ${s.title}\n\n` +
        (s.summary ? `## Summary\n\n${s.summary}\n\n<!-- ai-generated -->\n\n` : "") +
        (s.transcript ? `## Text\n\n${s.transcript}\n` : ""),
    });
  }

  // ---- content ----
  for (const c of contentRows) {
    const rel = await relationLines(env, userId, "content_item", c.id, titles);
    files.push({
      path: `content/${slugify(c.title)}.md`,
      content: frontmatter({
        id: c.id, type: "content_item", title: c.title, status: c.status,
        format: c.format, channel: c.channel, hook: c.hook, audience: c.audience,
        published_url: c.publishedUrl, published_at: isoDate(c.publishedAt),
        relations: rel.ids, updated_at: isoDate(c.updatedAt),
      }) + `# ${c.title}\n\n${await bodyMarkdown(env, c.bodyDocumentId)}` +
        (rel.list.length ? `\n## Origin\n\n${rel.list.map((l) => `- ${l}`).join("\n")}\n` : ""),
    });
  }

  // A manifest makes the archive self-describing and re-importable.
  files.push({
    path: "README.md",
    content: `# et al. export\n\nExported ${new Date().toISOString()}\n\n` +
      `| Type | Count |\n|---|---|\n` +
      `| Areas | ${areaRows.length} |\n| Goals | ${goalRows.length} |\n` +
      `| Projects | ${projectRows.length} |\n| Log entries | ${logRows.length} |\n` +
      `| Knowledge notes | ${noteRows.length} |\n| Tools | ${toolRows.length} |\n` +
      `| Sources | ${sourceRows.length} |\n| Content items | ${contentRows.length} |\n\n` +
      `Every file carries a stable \`id\` in its frontmatter and relations by id, ` +
      `so this archive round-trips. Wikilinks and folder structure are ` +
      `Obsidian-compatible.\n`,
  });

  return files;
}

/**
 * Writes a snapshot into R2 under a timestamped prefix and returns the manifest.
 * This is the backup: run it on a schedule, and D1 stops being a single point of
 * failure.
 */
export async function writeSnapshot(
  env: Env, userId: string,
): Promise<{ prefix: string; files: number; bytes: number }> {
  const files = await buildExport(env, userId);
  const prefix = `snapshots/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let bytes = 0;
  for (const file of files) {
    await env.VAULT.put(`${prefix}/${file.path}`, file.content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    bytes += file.content.length;
  }
  return { prefix, files: files.length, bytes };
}

/** One concatenated Markdown document — the "give me everything" download. */
export function toSingleDocument(files: ExportedFile[]): string {
  return files
    .map((f) => `\n\n<!-- ===== ${f.path} ===== -->\n\n${f.content}`)
    .join("")
    .trim() + "\n";
}
