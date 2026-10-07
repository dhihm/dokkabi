import { resolve } from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import { containsSecret } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const position = z.number().int().positive();
const ref = z.strictObject({ seq: position, hash: digest });
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/[\\\x00-\x1f\x7f]/.test(p) &&
      !containsSecret(p) &&
      p.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
export const observerPaths = z
  .array(path)
  .min(1)
  .max(128)
  .refine((p) => new Set(p).size === p.length);
export const observerReason = z.enum([
  "check_limit",
  "version_limit",
  "retention_bytes_limit",
  "source_refused",
  "capture_failed",
]);
const base = {
  schema: z.literal(1),
  sessionId: z.string().min(1).max(256),
  workspaceKey: digest,
  policyDigest: digest,
};
const configured = z.strictObject({ ...base, paths: observerPaths });
const status = z.enum([
  "parsed",
  "parse_failed",
  "missing",
  "unavailable",
  "unsupported",
  "excluded",
  "oversized",
  "invalid_utf8",
]);
const checked = z.strictObject({
  ...base,
  source: ref,
  boundary: z.enum(["initial", "resume", "tool_batch", "todo_clear", "goal_done", "idle"]),
  check: position.max(256),
  changed: z.boolean(),
  digest,
  files: z
    .array(
      z.strictObject({ path, status, original: digest.nullable(), sanitized: digest.nullable() }),
    )
    .max(128),
});
const paused = z.strictObject({ ...base, reason: observerReason });
const disabled = z.strictObject(base);
export const observerResumeRequest = z.strictObject({
  commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  newWindow: z.boolean().default(false),
});
const resumed = z.strictObject({
  ...base, schema: z.literal(2), ...observerResumeRequest.shape,
  window: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lifetimeChecks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const watcher = z.strictObject({
  ...base, mode: z.literal("selected_path_idle_poll"), intervalMs: z.literal(5000),
  runtime: z.enum(["started", "suspended", "stopped", "unavailable"]),
});
export type CodeObserverState = {
  state: "off" | "active" | "paused";
  policyDigest: string | null;
  paths: number;
  checks: number;
  reason: z.infer<typeof observerReason> | null;
  revision: number;
  window: number;
  lifetimeChecks: number;
  retainedVersions: number;
  retainedBytes: number;
  watcher?: { mode: "selected_path_idle_poll"; intervalMs: 5000; runtime: "started" | "suspended" | "stopped" | "unavailable" };
};
export const observerWorkspaceKey = (root: string) =>
  createHash("sha256").update(resolve(root)).digest("hex");
export function observerPolicy(sessionId: string, workspaceRoot: string, paths: readonly string[]) {
  const value = {
    schema: 1 as const,
    sessionId,
    workspaceKey: observerWorkspaceKey(workspaceRoot),
    paths: observerPaths.parse(paths).sort(),
  };
  return configured.parse({
    ...value,
    policyDigest: createHash("sha256").update(canonicalJson(value)).digest("hex"),
  });
}

/** Pure projection over the caller's already verified prefix. Reads never load
 * a parser, inspect workspace files or start the producer. */
export function readCodeObserverState(
  events: readonly EventRecord[],
  sessionId: string,
  workspaceRoot: string,
  policyDigest?: string,
): CodeObserverState {
  const workspaceKey = observerWorkspaceKey(workspaceRoot);
  const states = new Map<string, CodeObserverState>();
  const scopes = new Map<string, string[]>();
  let latest: string | null = null;
  const fail = (): never => {
    throw new Error("Invalid recorded Code observer state");
  };
  for (const row of events) {
    if (
      ![
        "code/observer_configured",
        "code/observer_checked",
        "code/observer_paused",
        "code/observer_disabled",
        "code/observer_resumed",
        "code/observer_watcher",
      ].includes(row.name)
    )
      continue;
    if (row.kind !== "observe") fail();
    if (row.name === "code/observer_configured") {
      const p = configured.parse(row.payload);
      if (
        p.sessionId !== sessionId ||
        p.workspaceKey !== workspaceKey ||
        canonicalJson(p) !== canonicalJson(observerPolicy(sessionId, workspaceRoot, p.paths))
      )
        fail();
      const old = states.get(p.policyDigest);
      states.set(p.policyDigest, {
        state: old?.state === "paused" ? "paused" : "active",
        policyDigest: p.policyDigest,
        paths: p.paths.length,
        checks: old?.checks ?? 0,
        reason: old?.state === "paused" ? old.reason : null,
        revision: row.seq,
        window: old?.window ?? 0,
        lifetimeChecks: old?.lifetimeChecks ?? 0,
        retainedVersions: 0,
        retainedBytes: 0,
        ...(old?.watcher ? { watcher: old.watcher } : {}),
      });
      scopes.set(p.policyDigest, p.paths);
      latest = p.policyDigest;
      continue;
    }
    const common = z.object({ ...base, schema: z.union([z.literal(1), z.literal(2)]) }).passthrough().parse(row.payload);
    const old = states.get(common.policyDigest);
    if (
      !old ||
      (old.state !== "active" && !["code/observer_resumed", "code/observer_watcher"].includes(row.name)) ||
      latest !== common.policyDigest ||
      common.sessionId !== sessionId ||
      common.workspaceKey !== workspaceKey
    )
      throw new Error("Invalid recorded Code observer state");
    if (row.name === "code/observer_resumed") {
      const p = resumed.parse(row.payload);
      const retained = events.slice(0, row.seq - 1).filter(r => r.name === "code/version");
      if (old.state === "active" || p.expectedRevision !== old.revision ||
        p.window !== old.window + Number(p.newWindow) || p.lifetimeChecks !== old.lifetimeChecks ||
        (!p.newWindow && old.checks >= 256) || old.reason === "version_limit" || old.reason === "retention_bytes_limit" ||
        events.slice(0, row.seq - 1).some(r => r.name === "code/observer_resumed" && r.payload.commandId === p.commandId) ||
        retained.length >= 32 || retained.reduce((sum, r) => sum + Number(r.payload.blob_bytes), 0) >= 64 * 1024 * 1024) fail();
      states.set(p.policyDigest, { ...old, state: "active", reason: null, checks: p.newWindow ? 0 : old.checks,
        window: p.window, revision: row.seq });
    } else if (row.name === "code/observer_watcher") {
      const p = watcher.parse(row.payload);
      states.set(p.policyDigest, { ...old, revision: row.seq,
        watcher: { mode: p.mode, intervalMs: p.intervalMs, runtime: p.runtime } });
    } else if (row.name === "code/observer_checked") {
      const p = checked.parse(row.payload);
      const source = events[p.source.seq - 1];
      if (
        !source ||
        source.hash !== p.source.hash ||
        source.seq >= row.seq ||
        p.check !== old.checks + 1 ||
        (p.boundary === "idle" && old.watcher?.runtime !== "started") ||
        canonicalJson(p.files.map((f) => f.path).sort()) !==
          canonicalJson(scopes.get(p.policyDigest))
      )
        fail();
      if (old.lifetimeChecks >= Number.MAX_SAFE_INTEGER) fail();
      states.set(p.policyDigest, { ...old, checks: p.check, lifetimeChecks: old.lifetimeChecks + 1, revision: row.seq });
    } else if (row.name === "code/observer_paused") {
      const p = paused.parse(row.payload);
      states.set(p.policyDigest, { ...old, state: "paused", reason: p.reason, revision: row.seq });
    } else {
      const p = disabled.parse(row.payload);
      states.set(p.policyDigest, { ...old, state: "off", revision: row.seq });
    }
  }
  const selected = policyDigest ?? latest;
  const publications = events.filter(r => r.name === "code/version");
  const sizes = publications.map(r => r.payload.blob_bytes);
  if (sizes.some(n => !Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 8 * 1024 * 1024)) fail();
  const retainedBytes = sizes.reduce<number>((sum, n) => sum + Number(n), 0);
  if (!Number.isSafeInteger(retainedBytes)) fail();
  return { ...(!selected || !states.has(selected)
    ? { state: "off" as const, policyDigest: null, paths: 0, checks: 0, reason: null,
      revision: 0, window: 0, lifetimeChecks: 0, retainedVersions: 0, retainedBytes: 0 }
    : states.get(selected)!), retainedVersions: publications.length, retainedBytes };
}
