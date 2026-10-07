import { createHash } from "node:crypto";
import { z } from "zod";
import type { EventRecord } from "../host/schema.ts";
import { planDigest } from "./digest.ts";
import type { WorkPlan } from "./schema.ts";

const receiptSchema = z.object({
  task_id: z.string().min(1), status: z.literal("completed"),
});
const observationSchema = z.object({
  plan_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  prerequisites: z.array(z.object({
    id: z.string().min(1), receipt_path: z.string().min(1),
    receipt_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    receipt_json: z.string().min(1).max(1_048_576),
  }).strict()).min(1),
}).strict();

/** Read host-authenticated prerequisite observations without inventing local clears. */
export function recordedPrerequisiteIds(plan: WorkPlan, events: readonly EventRecord[]): ReadonlySet<string> {
  const own = new Set(plan.todos.map((todo) => todo.id));
  const expected = new Set(plan.todos.flatMap((todo) => todo.blocked_by).filter((id) => !own.has(id)));
  if (expected.size === 0) return new Set();
  const digest = planDigest(plan);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name !== "work/prerequisites" || event.kind !== "observe" || event.payload.plan_digest !== digest) continue;
    const parsed = observationSchema.safeParse(event.payload);
    if (!parsed.success) return new Set();
    const ids = new Set<string>();
    for (const row of parsed.data.prerequisites) {
      if (!expected.has(row.id) || ids.has(row.id)
        || createHash("sha256").update(row.receipt_json).digest("hex") !== row.receipt_sha256) return new Set();
      try {
        const receipt = receiptSchema.parse(JSON.parse(row.receipt_json));
        if (receipt.task_id !== row.id) return new Set();
      } catch { return new Set(); }
      ids.add(row.id);
    }
    return ids.size === expected.size ? ids : new Set();
  }
  return new Set();
}
