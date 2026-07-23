// The capture processing pipeline.
//
// Runs a queued job to completion and records exactly how far it got. Every
// stage is named, so a failure says *where* it broke and a retry can resume
// there instead of starting over (spec §6.4, "partial failure").
//
// Phase 2 handles the deterministic stages: fetch metadata, create a Source for
// URL captures, mark the capture ready for review. The AI extraction stage that
// turns this into a proposal bundle lands in Phase 4 — `classify` is deliberately
// left as an explicit, visible gap rather than a half-built guess.

import { resolveUrl } from "./ingest.ts";
import { detectPlatform } from "./store/sources.ts";
import * as store from "./store/index.ts";
import type { Env } from "./store/index.ts";
import type { JobMessage } from "./store/jobs.ts";

/** Named so failures point at a stage rather than a stack trace. */
type Stage = "load" | "fetch" | "persist" | "index" | "finalize";

export interface JobResult {
  ok: boolean;
  job_id: string;
  stage?: Stage;
  error?: string;
  source_id?: string;
}

/**
 * Executes one job. Never throws: the outcome is always recorded on the job row,
 * because an unhandled throw in a queue consumer loses the reason.
 */
export async function runJob(env: Env, message: JobMessage): Promise<JobResult> {
  const started = Date.now();
  const job = await store.claimJob(env, message.job_id);
  // Already succeeded, or out of attempts — nothing to do. Not an error.
  if (!job) return { ok: true, job_id: message.job_id };

  let stage: Stage = "load";
  try {
    if (job.job_type === "embed") {
      stage = "index";
      await embedSubject(env, message.user_id, job.subject_type, job.subject_id);
      await store.completeJob(env, job.id, { durationMs: Date.now() - started });
      return { ok: true, job_id: job.id };
    }

    if (job.job_type !== "fetch") {
      await store.completeJob(env, job.id, { durationMs: Date.now() - started });
      return { ok: true, job_id: job.id };
    }

    const capture = await store.getCapture(env, message.user_id, job.subject_id);
    if (!capture) throw new Error(`Capture not found: ${job.subject_id}`);

    await store.updateCapture(env, message.user_id, capture.id, { processing_status: "processing" });

    let sourceId: string | undefined;

    if (capture.input_type === "url" && capture.source_url) {
      stage = "fetch";
      const meta = await resolveUrl(capture.source_url);

      stage = "persist";
      // The capture's own raw_input is never touched — a Source is a *separate*
      // record derived from it, so re-fetching can never corrupt the original.
      const source = await store.createSource(env, message.user_id, {
        title: meta.title ?? capture.source_url,
        url: meta.canonical_url ?? capture.source_url,
        platform: detectPlatform(meta.canonical_url ?? capture.source_url),
        author: meta.author,
        published_at: meta.published_at,
        transcript: meta.text,
        capture_id: capture.id,
        processing_version: job.version,
      });
      sourceId = source.id;

      stage = "index";
      await store.indexFts(
        env, "source", source.id, source.title,
        [meta.description, meta.text].filter(Boolean).join("\n").slice(0, 20_000),
      );
    }

    stage = "finalize";
    await store.updateCapture(env, message.user_id, capture.id, {
      processing_status: "ready",
      processing_error: null,
    });
    await store.completeJob(env, job.id, { durationMs: Date.now() - started });
    return { ok: true, job_id: job.id, source_id: sourceId };
  } catch (error) {
    await store.failJob(env, job.id, stage, error);
    // The capture records the failure but stays reviewable: the user can still
    // read their original input and act on it by hand.
    try {
      await store.updateCapture(env, message.user_id, job.subject_id, {
        processing_status: "failed",
        processing_error: error instanceof Error ? error.message : String(error),
      });
    } catch { /* capture may have been deleted mid-flight */ }
    return {
      ok: false, job_id: job.id, stage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Embeds one object by reading whatever the FTS row already holds — the same
 * flattened title+body, so keyword and semantic layers always describe the same
 * text rather than drifting apart.
 */
export async function embedSubject(
  env: Env, userId: string, subjectType: string, subjectId: string,
): Promise<{ indexed: boolean; reason?: string }> {
  const row = await env.DB
    .prepare("SELECT title, body FROM documents_fts WHERE subject_id = ? LIMIT 1")
    .bind(subjectId).first<{ title: string; body: string }>();
  if (!row) return { indexed: false, reason: "not indexed for search" };
  return store.indexEmbedding(
    env, userId, subjectType as store.SubjectType, subjectId, row.title ?? "", row.body ?? "",
  );
}

/**
 * Re-embeds everything currently in the search index. Used after enabling
 * semantic search, or after a model change.
 */
export async function backfillEmbeddings(
  env: Env, userId: string, limit = 200,
): Promise<{ indexed: number; skipped: number }> {
  if (!store.semanticAvailable(env)) return { indexed: 0, skipped: 0 };
  const rows = await env.DB
    .prepare("SELECT subject_id, subject_type, title, body FROM documents_fts LIMIT ?")
    .bind(limit).all<{ subject_id: string; subject_type: string; title: string; body: string }>();
  let indexed = 0, skipped = 0;
  for (const r of rows.results ?? []) {
    const result = await store.indexEmbedding(
      env, userId, r.subject_type as store.SubjectType, r.subject_id, r.title ?? "", r.body ?? "",
    );
    if (result.indexed) indexed++; else skipped++;
  }
  return { indexed, skipped };
}

/**
 * Cron entry point. Picks up anything the queue missed — never-delivered
 * messages, failed jobs with attempts remaining, and jobs stuck `running`
 * because the Worker was evicted mid-flight.
 */
export async function sweepJobs(env: Env, limit = 25): Promise<{ ran: number; failed: number }> {
  const runnable = await store.listRunnableJobs(env, 300, limit);
  let ran = 0, failed = 0;
  for (const job of runnable) {
    const result = await runJob(env, {
      job_id: job.id, job_type: job.job_type,
      subject_type: job.subject_type, subject_id: job.subject_id,
      user_id: await store.ensureUser(env),
    });
    ran++;
    if (!result.ok) failed++;
  }
  return { ran, failed };
}
