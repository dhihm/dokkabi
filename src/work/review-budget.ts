import { MAX_TIMER_MS } from "../host/stream-stall.ts";

/** A supervisor supplies an absolute work deadline. Convert it once to a
 * monotonic allowance so later wall-clock changes cannot renew review time. */
export const WORK_DEADLINE_ENV = "DOKKABI_WORK_DEADLINE_UNIX_MS";

export function workReviewBudget(input: {
  deadline?: string; budgetHours?: number; wallNow?: () => number; now?: () => number;
} = {}): { deadlineUnixMs?: number; remainingMs: () => number | undefined } {
  const wall = (input.wallNow ?? Date.now)(), now = input.now ?? (() => performance.now()), start = now();
  const deadlines: number[] = [];
  if (input.deadline !== undefined) {
    const value = Number(input.deadline);
    if (!/^\d+$/u.test(input.deadline) || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid work deadline");
    deadlines.push(value);
  }
  if (input.budgetHours !== undefined && input.budgetHours !== 0) {
    if (!Number.isFinite(input.budgetHours) || input.budgetHours < 0) throw new Error("Invalid work budget hours");
    deadlines.push(wall + input.budgetHours * 3600000);
  }
  if (!deadlines.length) return { remainingMs: () => undefined };
  const deadlineUnixMs = Math.min(...deadlines), allowance = Math.max(0, deadlineUnixMs - wall);
  if (allowance > MAX_TIMER_MS) throw new Error("Work deadline exceeds the supported timer range");
  return { deadlineUnixMs, remainingMs: () => Math.max(0, Math.floor(allowance - (now() - start))) };
}

export function remainingReviewTime(remainingMs?: () => number | undefined, explicitMs?: number): number | undefined {
  const remaining = remainingMs?.();
  for (const value of [remaining, explicitMs]) if (value !== undefined
    && (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS)) throw new Error("Invalid remaining review budget");
  const values = [remaining, explicitMs].filter((value): value is number => value !== undefined);
  return values.length ? Math.floor(Math.min(...values)) : undefined;
}
