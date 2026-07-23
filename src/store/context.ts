// Request-scoped actor attribution.
//
// The spec's core trust requirement (§3.2) is that anything an AI created stays
// identifiable. v6 originally planned to satisfy that with a server-side
// proposal queue; the AI now lives outside the platform (Claude via MCP), so the
// equivalent guarantee is *attribution*: a write arriving through the MCP
// endpoint is recorded as `actor: 'ai'`, and the UI can label it.
//
// Threading an `actor` argument through every store function would touch dozens
// of signatures for a value none of them care about. AsyncLocalStorage carries
// it implicitly instead — available here because `nodejs_compat` is enabled in
// wrangler.toml.

import { AsyncLocalStorage } from "node:async_hooks";

export type Actor = "user" | "ai" | "system";

interface RequestContext {
  actor: Actor;
  /** Optional label for which agent/tool did it, kept in the audit detail. */
  agent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with every audit event inside it attributed to `actor`. */
export function runAs<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/** Defaults to `user`: a write with no explicit context is a direct human action. */
export function currentActor(): Actor {
  return storage.getStore()?.actor ?? "user";
}

export function currentAgent(): string | undefined {
  return storage.getStore()?.agent;
}
