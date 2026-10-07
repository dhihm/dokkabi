import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { WorkPlan } from "./schema.ts";

export function planDigest(plan: WorkPlan): string {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}
