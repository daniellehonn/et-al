// Small shared helpers, extracted from logic that was duplicated across views.

/** Completion percentage, 0–100 (0 when there's nothing). */
export function pct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

/** A due date that has passed and isn't done. */
export function isOverdue(dueDate: number | null | undefined, status?: string): boolean {
  return !!dueDate && dueDate < Date.now() && status !== "done";
}

/** "Mar 4" — a compact date. */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Mar 4, 2:15 PM" — date + time, for timelines. */
export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
