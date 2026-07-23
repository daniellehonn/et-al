// Durable processing jobs.
//
// The `processing_jobs` table — not the queue — is the system of record. A queue
// message is only a *trigger*; if it is lost, duplicated, or the queue binding is
// missing entirely, the row still says what needs doing and the cron sweeper
// picks it up. That inversion is what makes the pipeline survive failure.
//
// Three guarantees the spec asks for (§6.4), implemented here:
//   * **Idempotency** — `job_key` is `{type}:{subject}:{version}` and UNIQUE, so
//     a retried or duplicated message can never produce a second output.
//   * **Versioning** — the key includes the pipeline version, so bumping a
//     prompt/parser deliberately creates a *new* job rather than colliding with
//     the old one. Reprocessing is therefore explicit, never accidental.
//   * **Partial failure** — a failed stage records `failure_stage` and keeps its
//     attempt count, so a retry can resume rather than restart from scratch.

import { desc, eq, and, inArray, lt } from "drizzle-orm";
import { processingJobs, type JobType } from "../schema.ts";
import { type Env, getDb, now, newId } from "./db.ts";
import type { SubjectType } from "../schema.ts";

/** Bump when a pipeline's behaviour changes in a way that should reprocess. */
export const PIPELINE_VERSION = "1";

/** Give up after this many attempts; the row stays for inspection. */
export const MAX_ATTEMPTS = 5;

export interface JobMessage {
  job_id: string;
  job_type: JobType;
  subject_type: string;
  subject_id: string;
  user_id: string;
}

export interface JobDoc {
  id: string;
  job_key: string;
  job_type: JobType;
  subject_type: string;
  subject_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  failure_stage: string | null;
  error: string | null;
  duration_ms: number | null;
  version: string | null;
  created_at: number;
  updated_at: number;
}

function view(row: typeof processingJobs.$inferSelect): JobDoc {
  return {
    id: row.id, job_key: row.jobKey, job_type: row.jobType,
    subject_type: row.subjectType, subject_id: row.subjectId,
    status: row.status, attempts: row.attempts, failure_stage: row.failureStage,
    error: row.error, duration_ms: row.durationMs, version: row.version,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

export function jobKeyFor(jobType: JobType, subjectId: string, version = PIPELINE_VERSION): string {
  return `${jobType}:${subjectId}:${version}`;
}

/**
 * Records the intent to process something and (best-effort) triggers it.
 *
 * Returns the existing job untouched when one already exists for this key —
 * that is the idempotency guarantee, and it is why callers may enqueue freely
 * without checking first.
 */
export async function enqueueJob(
  env: Env,
  input: { userId: string; jobType: JobType; subjectType: SubjectType | string; subjectId: string; version?: string },
): Promise<{ job: JobDoc; created: boolean }> {
  const db = getDb(env);
  const version = input.version ?? PIPELINE_VERSION;
  const jobKey = jobKeyFor(input.jobType, input.subjectId, version);

  const existing = await db.select().from(processingJobs)
    .where(eq(processingJobs.jobKey, jobKey)).limit(1);
  if (existing[0]) return { job: view(existing[0]), created: false };

  const ts = now();
  const row = {
    id: newId(), userId: input.userId, jobKey,
    jobType: input.jobType, subjectType: input.subjectType, subjectId: input.subjectId,
    status: "queued" as const, attempts: 0,
    failureStage: null, error: null, durationMs: null, tokenUsage: null,
    version, createdAt: ts, updatedAt: ts,
  };

  try {
    await db.insert(processingJobs).values(row);
  } catch {
    // Lost a race on the UNIQUE key — the other writer's row is authoritative.
    const raced = await db.select().from(processingJobs)
      .where(eq(processingJobs.jobKey, jobKey)).limit(1);
    if (raced[0]) return { job: view(raced[0]), created: false };
    throw new Error(`Could not enqueue job ${jobKey}`);
  }

  await sendMessage(env, {
    job_id: row.id, job_type: row.jobType,
    subject_type: row.subjectType, subject_id: row.subjectId, user_id: row.userId,
  });
  return { job: view(row as typeof processingJobs.$inferSelect), created: true };
}

/**
 * Publishing is best-effort by design. Without a queue binding (or if the send
 * fails) the job row is still `queued` and the cron sweeper will run it — the
 * work is merely delayed, never dropped.
 */
async function sendMessage(env: Env, message: JobMessage): Promise<void> {
  if (!env.JOBS) return;
  try { await env.JOBS.send(message); } catch { /* sweeper will retry */ }
}

/** Marks a job running and counts the attempt. Returns null if already done. */
export async function claimJob(env: Env, jobId: string): Promise<JobDoc | null> {
  const db = getDb(env);
  const rows = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job) return null;
  if (job.status === "succeeded") return null;   // idempotency: never redo work
  if (job.attempts >= MAX_ATTEMPTS) return null; // give up, leave the row for inspection

  await db.update(processingJobs)
    .set({ status: "running", attempts: job.attempts + 1, updatedAt: now() })
    .where(eq(processingJobs.id, jobId));
  return view({ ...job, status: "running", attempts: job.attempts + 1 });
}

export async function completeJob(
  env: Env, jobId: string, meta: { durationMs?: number; tokenUsage?: number } = {},
): Promise<void> {
  await getDb(env).update(processingJobs).set({
    status: "succeeded", failureStage: null, error: null,
    durationMs: meta.durationMs ?? null, tokenUsage: meta.tokenUsage ?? null,
    updatedAt: now(),
  }).where(eq(processingJobs.id, jobId));
}

/** Records where it broke so a retry can resume at that stage. */
export async function failJob(
  env: Env, jobId: string, stage: string, error: unknown,
): Promise<void> {
  await getDb(env).update(processingJobs).set({
    status: "failed", failureStage: stage,
    error: error instanceof Error ? error.message : String(error),
    updatedAt: now(),
  }).where(eq(processingJobs.id, jobId));
}

export async function getJob(env: Env, jobId: string): Promise<JobDoc | null> {
  const rows = await getDb(env).select().from(processingJobs)
    .where(eq(processingJobs.id, jobId)).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function listJobs(
  env: Env, userId: string, opts: { status?: string; subject_id?: string; limit?: number } = {},
): Promise<JobDoc[]> {
  const filters = [eq(processingJobs.userId, userId)];
  if (opts.status) filters.push(eq(processingJobs.status, opts.status as "queued"));
  if (opts.subject_id) filters.push(eq(processingJobs.subjectId, opts.subject_id));
  const rows = await getDb(env).select().from(processingJobs).where(and(...filters))
    .orderBy(desc(processingJobs.updatedAt)).limit(Math.min(opts.limit ?? 50, 200));
  return rows.map(view);
}

/**
 * Work the sweeper should pick up.
 *
 * `queued` jobs run immediately — nothing has tried them yet. `failed` and
 * `running` jobs must be older than the stale window first, which does double
 * duty: it stops the sweeper from hot-looping on a permanently broken URL (a
 * crude but effective backoff), and it only reclaims a `running` job once the
 * Worker holding it has plainly been evicted rather than merely being slow.
 */
export async function listRunnableJobs(env: Env, staleSeconds = 300, limit = 25): Promise<JobDoc[]> {
  const cutoff = now() - staleSeconds;
  const rows = await getDb(env).select().from(processingJobs)
    .where(and(
      inArray(processingJobs.status, ["queued", "failed", "running"]),
      lt(processingJobs.attempts, MAX_ATTEMPTS),
    ))
    .orderBy(processingJobs.createdAt)
    .limit(limit * 4);

  return rows
    .filter((r) => r.status === "queued" || r.updatedAt < cutoff)
    .slice(0, limit)
    .map(view);
}

/**
 * Enqueue for work that should re-run when its subject changes.
 *
 * A stable key would make the second save a no-op (the job already succeeded);
 * a timestamped key would mint a fresh row on every save. Neither is right for
 * something like embedding, where the work should run again but only once per
 * settled change. So: reuse the row and reset it to `queued`.
 */
export async function enqueueOrRefresh(
  env: Env,
  input: { userId: string; jobType: JobType; subjectType: SubjectType | string; subjectId: string },
): Promise<JobDoc> {
  const { job, created } = await enqueueJob(env, input);
  if (created) return job;
  const refreshed = await resetJob(env, input.userId, job.id);
  return refreshed ?? job;
}

/** Clears the give-up state so a job can be retried by hand. */
export async function resetJob(env: Env, userId: string, jobId: string): Promise<JobDoc | null> {
  const db = getDb(env);
  await db.update(processingJobs)
    .set({ status: "queued", attempts: 0, error: null, failureStage: null, updatedAt: now() })
    .where(and(eq(processingJobs.id, jobId), eq(processingJobs.userId, userId)));
  const job = await getJob(env, jobId);
  if (job) {
    await sendMessage(env, {
      job_id: job.id, job_type: job.job_type,
      subject_type: job.subject_type, subject_id: job.subject_id, user_id: userId,
    });
  }
  return job;
}
