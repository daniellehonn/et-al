// Captures — immutable raw input, recorded before its destination is known.
//
// The contract that everything downstream depends on: **`raw_input` is written
// once and never mutated.** Processing may fail, be retried, or be reprocessed
// under a new prompt/model version, and the user's original words or URL must
// still be exactly what they typed (spec §2.7, §3.1). `updateCapture` therefore
// deliberately offers no way to change it.
//
// Phase 1 provides the record and the queue-facing status fields; Phase 2 adds
// the ingestion pipeline that moves `processing_status` along.

import { desc, eq, and } from "drizzle-orm";
import {
  captures, CAPTURE_INPUT_TYPE, PROCESSING_STATUS, CLASSIFICATION, REVIEW_STATUS,
  type CaptureInputType, type ProcessingStatus, type Classification, type ReviewStatus,
} from "../schema.ts";
import {
  type Env, getDb, now, newId, requireText, optionalText, optionalEnum, requireEnum,
  audit, NotFoundError,
} from "./db.ts";
import { enqueueJob, listJobs, resetJob } from "./jobs.ts";
import { track } from "../analytics.ts";

export interface CaptureInput {
  raw_input?: string;
  input_type?: string;
  source_url?: string | null;
  platform?: string | null;
  asset_id?: string | null;
}

export interface CaptureUpdate {
  processing_status?: string;
  processing_error?: string | null;
  classification?: string | null;
  review_status?: string;
  proposal_bundle_id?: string | null;
}

export interface CaptureDoc {
  id: string;
  raw_input: string;
  input_type: CaptureInputType;
  source_url: string | null;
  platform: string | null;
  asset_id: string | null;
  processing_status: ProcessingStatus;
  processing_error: string | null;
  classification: Classification | null;
  review_status: ReviewStatus;
  proposal_bundle_id: string | null;
  created_at: number;
  updated_at: number;
}

function view(row: typeof captures.$inferSelect): CaptureDoc {
  return {
    id: row.id, raw_input: row.rawInput, input_type: row.inputType,
    source_url: row.sourceUrl, platform: row.platform, asset_id: row.assetId,
    processing_status: row.processingStatus, processing_error: row.processingError,
    classification: row.classification ?? null, review_status: row.reviewStatus,
    proposal_bundle_id: row.proposalBundleId,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

/** Cheap heuristic so a pasted link is typed correctly without a round trip. */
export function detectInputType(raw: string): CaptureInputType {
  return /^https?:\/\/\S+$/i.test(raw.trim()) ? "url" : "text";
}

export interface CaptureListOptions {
  review_status?: string | null;
  processing_status?: string | null;
  limit?: number;
}

export async function listCaptures(env: Env, userId: string, opts: CaptureListOptions = {}): Promise<CaptureDoc[]> {
  const filters = [eq(captures.userId, userId)];
  if (opts.review_status) filters.push(eq(captures.reviewStatus, requireEnum(opts.review_status, REVIEW_STATUS, "review_status")));
  if (opts.processing_status) filters.push(eq(captures.processingStatus, requireEnum(opts.processing_status, PROCESSING_STATUS, "processing_status")));
  const rows = await getDb(env).select().from(captures).where(and(...filters))
    .orderBy(desc(captures.createdAt)).limit(Math.min(opts.limit ?? 100, 500));
  return rows.map(view);
}

/** The Inbox: everything still awaiting a decision. */
export async function listInbox(env: Env, userId: string, limit = 100): Promise<CaptureDoc[]> {
  return listCaptures(env, userId, { review_status: "pending", limit });
}

export async function getCapture(env: Env, userId: string, id: string): Promise<CaptureDoc | null> {
  const rows = await getDb(env).select().from(captures)
    .where(and(eq(captures.id, id), eq(captures.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function createCapture(env: Env, userId: string, input: CaptureInput): Promise<CaptureDoc> {
  const raw = requireText(input.raw_input, "raw_input");
  const inputType = (optionalEnum(input.input_type, CAPTURE_INPUT_TYPE, "input_type") ?? detectInputType(raw)) as CaptureInputType;
  const ts = now();
  const row = {
    id: newId(), userId,
    rawInput: raw,                       // write-once
    inputType,
    sourceUrl: optionalText(input.source_url) ?? (inputType === "url" ? raw.trim() : null),
    platform: optionalText(input.platform),
    assetId: optionalText(input.asset_id),
    processingStatus: "unprocessed" as ProcessingStatus,
    processingError: null as string | null,
    classification: null as Classification | null,
    reviewStatus: "pending" as ReviewStatus,
    proposalBundleId: null as string | null,
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(captures).values(row);
  await audit(env, { userId, subjectType: "capture", subjectId: row.id, action: "created" });
  await track(env, userId, "capture_created", { input_type: inputType });

  // Processing is scheduled, never awaited: the capture must be durable and
  // confirmed to the user immediately (spec §3.1, "immediate confirmation"),
  // and a fetch that fails later must not fail the save.
  await enqueueJob(env, {
    userId, jobType: "fetch", subjectType: "capture", subjectId: row.id,
  });

  return view(row as typeof captures.$inferSelect);
}

/**
 * Updates processing/review state only. There is intentionally no path here to
 * modify `raw_input` — the original must survive every reprocessing.
 */
export async function updateCapture(env: Env, userId: string, id: string, input: CaptureUpdate): Promise<CaptureDoc> {
  const current = await getCapture(env, userId, id);
  if (!current) throw new NotFoundError(`Capture not found: ${id}`);

  const patch: Partial<typeof captures.$inferInsert> = { updatedAt: now() };
  if (input.processing_status !== undefined) patch.processingStatus = requireEnum(input.processing_status, PROCESSING_STATUS, "processing_status");
  if (input.processing_error !== undefined) patch.processingError = optionalText(input.processing_error);
  if (input.classification !== undefined) patch.classification = optionalEnum(input.classification, CLASSIFICATION, "classification");
  if (input.review_status !== undefined) patch.reviewStatus = requireEnum(input.review_status, REVIEW_STATUS, "review_status");
  if (input.proposal_bundle_id !== undefined) patch.proposalBundleId = optionalText(input.proposal_bundle_id);

  await getDb(env).update(captures).set(patch).where(and(eq(captures.id, id), eq(captures.userId, userId)));
  await audit(env, { userId, subjectType: "capture", subjectId: id, action: "updated" });
  if (input.review_status && input.review_status !== current.review_status) {
    await track(env, userId, "capture_triaged", { to: input.review_status, classification: input.classification ?? null });
  }
  if (input.processing_status === "ready") await track(env, userId, "capture_processed", {});
  return (await getCapture(env, userId, id))!;
}

/**
 * Retries processing without creating a second capture (spec §3.1).
 *
 * Resets the *existing* job rather than enqueuing a new one: the job key is
 * idempotent per pipeline version, so a fresh enqueue would return the spent
 * job untouched and silently do nothing.
 */
export async function resetForRetry(env: Env, userId: string, id: string): Promise<CaptureDoc> {
  const capture = await getCapture(env, userId, id);
  if (!capture) throw new NotFoundError(`Capture not found: ${id}`);

  const jobs = await listJobs(env, userId, { subject_id: id, limit: 10 });
  const fetchJob = jobs.find((j) => j.job_type === "fetch");
  if (fetchJob) await resetJob(env, userId, fetchJob.id);
  else await enqueueJob(env, { userId, jobType: "fetch", subjectType: "capture", subjectId: id });

  return updateCapture(env, userId, id, {
    processing_status: "unprocessed",
    processing_error: null,
  });
}

export async function deleteCapture(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getCapture(env, userId, id);
  if (!current) return false;
  await getDb(env).delete(captures).where(and(eq(captures.id, id), eq(captures.userId, userId)));
  await audit(env, { userId, subjectType: "capture", subjectId: id, action: "deleted" });
  return true;
}
