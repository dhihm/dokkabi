import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { prepareBoot, resolveBootRequest, type BootRequest } from "../boot.ts";
import { resolvePluginManifest, type ResolvedManifest } from "../loader/manifest.ts";
import type { BootPreparation } from "../loader/types.ts";
import { readConfig, resolveLlmSelection, configPath } from "./config.ts";
import { hostReadiness, modelReadiness, probeMachine } from "./doctor-machine.ts";
import { attestFence } from "./doctor-freshness.ts";
import { authenticateReport, configDigest, installationKey, keyIdOf, type InstallationKey } from "./doctor-identity.ts";
import type { SessionRead } from "./doctor-session.ts";
import {
  action,
  assertDoctorReportSecretFree,
  digestOf,
  DOCTOR_REPORT_EVENT,
  DOCTOR_REPORT_VERSION,
  evidenceRank,
  inventorySnapshotFromEvents,
  isCapabilityId,
  isReasonCode,
  isSessionIdReference,
  isValidAction,
  isValidRef,
  MAX_CONTRIBUTOR_ROWS,
  MAX_REPORT_ROWS,
  MAX_ROW_REFS,
  READINESS_EVIDENCE_LEVELS,
  READINESS_STATUSES,
  ref,
  type ActionId,
  type CapabilityReadiness,
  type ContributorOutcome,
  type DoctorReport,
  type InventoryPlugin,
  type InventorySnapshot,
  type ReadinessEvidenceLevel,
  type ReadinessStatus,
  type ReasonCode,
  type SessionIdentity,
  PROBE_TOOLS,
  FENCE_ATTESTATION,
} from "./doctor-report.ts";
import { EventLog } from "./event-log.ts";
import {
  EXECUTION_PROFILE_NAMES,
  effectiveManifestPath,
  effectiveWorkProfile,
  isExecutionProfileName,
  profileManifestPath,
  type ExecutionProfileName,
} from "./execution-profile.ts";
import { dokkabiHome, piAuthPath, resolveWorkspaceRoot, sessionLogPath } from "./paths.ts";

/**
 * Capability readiness contributors (#230, TS-32) and the runner that owns
 * them. A contributor is a read-only reader of one kind of truth — the
 * profile's manifest and boot rules, a session's inventory, a plugin
 * package's descriptor, the machine probe — never a table of what should be
 * there, and never a copy of a decision the runtime makes (D1).
 *
 * The runner, not the contributor, is trusted:
 * - each contributor gets its own AbortSignal and deadline, and the deadline
 *   is measured — a synchronous contributor that returns late is timed out
 *   too (D5);
 * - no row disappears (D2): a failed or late contributor becomes an unknown
 *   row, a refused row becomes an unknown row for the same capability (or for
 *   the contributor when its id is unusable), and the report is partial;
 * - rows are bounded where they enter (D5): past MAX_CONTRIBUTOR_ROWS or
 *   MAX_REPORT_ROWS they are cut with an explicit unknown marker;
 * - the protected-state fingerprint (operator config, credential store,
 *   workspace) is compared around each contributor, and a contributor that
 *   changed it is refused.
 */

export type ReadinessRow = Omit<CapabilityReadiness, "contributor">;

export interface DeclaredCapability {
  readonly id: string;
  readonly required: boolean;
}

export interface ReadinessInput {
  readonly profile: string;
  readonly allowLocalProbe: boolean;
}

export interface ReadinessContributor {
  readonly id: string;
  /** Capability id namespaces this contributor owns (`plugin`, `host`, …). */
  readonly namespaces: readonly string[];
  /** The strongest evidence this contributor can observe. A row claiming more is refused. */
  readonly maxEvidence: ReadinessEvidenceLevel;
  /** Whether it owns a required capability: its failure is then a required unknown. */
  readonly required: boolean;
  /** Its own deadline; the runner's default when absent. A local diagnosis
   * policy — it never touches a model's reasoning or task budget. */
  readonly deadlineMs?: number;
  inspect(input: ReadinessInput, signal: AbortSignal): Promise<readonly ReadinessRow[]>;
}

export const DEFAULT_CONTRIBUTOR_DEADLINE_MS = 10_000;

function contributorRow(
  contributor: ReadinessContributor,
  profile: string,
  status: "unknown" | "degraded",
  reasonCode: ReasonCode,
  required: boolean = contributor.required,
): CapabilityReadiness {
  return {
    capabilityId: `contributor:${contributor.id}`,
    profile,
    descriptorDigest: digestOf({ contributor: contributor.id, namespaces: contributor.namespaces }),
    status,
    evidenceLevel: "configuration",
    reasonCode,
    evidenceRefs: [ref("owns", contributor.namespaces.join(","))],
    required,
    contributor: contributor.id,
  };
}

/** Why a returned row cannot stand as given, or undefined when it can. */
function rowRefusal(row: ReadinessRow, contributor: ReadinessContributor, profile: string): ReasonCode | undefined {
  if (typeof row !== "object" || row === null) return "row_refused";
  if (!isCapabilityId(row.capabilityId)) return "row_refused";
  if (!contributor.namespaces.includes(row.capabilityId.split(":")[0]!)) return "row_refused";
  if (row.profile !== profile) return "row_refused";
  if (!(READINESS_STATUSES as readonly string[]).includes(row.status)) return "row_refused";
  if (!(READINESS_EVIDENCE_LEVELS as readonly string[]).includes(row.evidenceLevel)) return "row_refused";
  if (row.requiredEvidence !== undefined
    && !(READINESS_EVIDENCE_LEVELS as readonly string[]).includes(row.requiredEvidence)) return "row_refused";
  if (!isReasonCode(row.reasonCode)) return "row_refused";
  if (typeof row.descriptorDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.descriptorDigest)) return "row_refused";
  if (!Array.isArray(row.evidenceRefs) || row.evidenceRefs.length > MAX_ROW_REFS || !row.evidenceRefs.every(isValidRef)) return "row_refused";
  if (row.suggestedAction !== undefined && !isValidAction(row.suggestedAction)) return "row_refused";
  if (typeof row.required !== "boolean") return "row_refused";
  return undefined;
}

function cleanRow(row: ReadinessRow, contributor: string): CapabilityReadiness {
  return {
    capabilityId: row.capabilityId,
    profile: row.profile,
    descriptorDigest: row.descriptorDigest,
    status: row.status,
    evidenceLevel: row.evidenceLevel,
    reasonCode: row.reasonCode,
    evidenceRefs: [...row.evidenceRefs],
    required: row.required,
    ...(row.requiredEvidence !== undefined ? { requiredEvidence: row.requiredEvidence } : {}),
    ...(row.suggestedAction !== undefined ? { suggestedAction: { id: row.suggestedAction.id, args: [...row.suggestedAction.args] } } : {}),
    contributor,
  };
}

/**
 * Run contributors one at a time, each under its own deadline and signal.
 * Sequential on purpose: a protected-state change is then attributable to
 * exactly one contributor, and a slow probe cannot starve another's deadline.
 */
export async function runReadinessContributors(input: {
  readonly profile: string;
  readonly allowLocalProbe: boolean;
  readonly contributors: readonly ReadinessContributor[];
  readonly defaultDeadlineMs?: number;
  /** Fingerprint of what a diagnosis must not change; compared around each contributor. */
  readonly protectedState?: () => string;
  /** The closed vocabulary of capability ids (D3): an id outside it is refused
   * and never reported, whatever the contributor built it from. */
  readonly knownCapability?: (id: string) => boolean;
  /** The capabilities each contributor's descriptor owns (D5'): when it
   * fails, times out, is refused or returns nothing, every one of them stays
   * as an unknown row with its declared required-ness. */
  readonly declared?: (contributor: ReadinessContributor) => readonly DeclaredCapability[];
  readonly now?: () => number;
}): Promise<{ capabilities: CapabilityReadiness[]; contributors: ContributorOutcome[]; partial: boolean; truncated: boolean }> {
  const now = input.now ?? (() => performance.now());
  const capabilities: CapabilityReadiness[] = [];
  const outcomes: ContributorOutcome[] = [];
  const owned = new Set<string>();
  let partial = false;
  let truncated = false;
  const fillDeclared = (contributor: ReadinessContributor, reasonCode: ReasonCode): number => {
    let filled = 0;
    for (const declared of (input.declared?.(contributor) ?? []).slice(0, MAX_CONTRIBUTOR_ROWS)) {
      if (owned.has(declared.id) || capabilities.length >= MAX_REPORT_ROWS) continue;
      if (!contributor.namespaces.includes(declared.id.split(":")[0]!)) continue;
      owned.add(declared.id);
      filled += 1;
      capabilities.push({
        capabilityId: declared.id,
        profile: input.profile,
        descriptorDigest: digestOf({ capabilityId: declared.id, declared: true }),
        status: "unknown",
        evidenceLevel: "configuration",
        reasonCode,
        evidenceRefs: [ref("owns", contributor.namespaces.join(","))],
        required: declared.required,
        contributor: contributor.id,
      });
    }
    return filled;
  };
  for (const contributor of input.contributors) {
    const before = input.protectedState?.();
    const started = now();
    const controller = new AbortController();
    const deadline = contributor.deadlineMs ?? input.defaultDeadlineMs ?? DEFAULT_CONTRIBUTOR_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("readiness contributor deadline passed"));
        resolve("timed_out");
      }, deadline);
    });
    let result: unknown;
    try {
      const running = Promise.resolve().then(() => contributor.inspect(
        Object.freeze({ profile: input.profile, allowLocalProbe: input.allowLocalProbe }),
        controller.signal,
      ));
      // A contributor that ignores its signal may still settle after the
      // deadline; its late answer is dropped, never reported.
      running.catch(() => undefined);
      result = await Promise.race([running, expired]);
    } catch {
      result = { failed: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Dispose: whatever the contributor still holds is told to stop.
      if (!controller.signal.aborted) controller.abort(new Error("readiness contributor finished"));
    }
    const elapsed = now() - started;
    const elapsedMs = Math.max(0, Math.round(elapsed));
    // A contributor that blocked the thread past its deadline answered late,
    // whatever it answered: measured, not trusted.
    if (result !== "timed_out" && elapsed > deadline) result = "timed_out";
    const after = input.protectedState?.();
    const room = MAX_REPORT_ROWS - capabilities.length;
    if (before !== after) {
      partial = true;
      outcomes.push({ id: contributor.id, outcome: "refused", reasonCode: "contributor_mutated_protected_state", elapsedMs });
      capabilities.push(contributorRow(contributor, input.profile, "degraded", "contributor_mutated_protected_state"));
      fillDeclared(contributor, "contributor_mutated_protected_state");
      continue;
    }
    if (result === "timed_out") {
      partial = true;
      outcomes.push({ id: contributor.id, outcome: "timed_out", reasonCode: "contributor_timed_out", elapsedMs });
      capabilities.push(contributorRow(contributor, input.profile, "unknown", "contributor_timed_out"));
      fillDeclared(contributor, "contributor_timed_out");
      continue;
    }
    if (!Array.isArray(result)) {
      partial = true;
      outcomes.push({ id: contributor.id, outcome: "failed", reasonCode: "contributor_failed", elapsedMs });
      capabilities.push(contributorRow(contributor, input.profile, "unknown", "contributor_failed"));
      fillDeclared(contributor, "contributor_failed");
      continue;
    }
    if ((result as readonly unknown[]).length === 0) {
      // Nothing answered: every capability it owns is unknown, and a required
      // contributor that owns none it declared still stands as unknown.
      const filled = fillDeclared(contributor, "contributor_empty");
      if (filled === 0 && !contributor.required) {
        outcomes.push({ id: contributor.id, outcome: "ok", elapsedMs });
        continue;
      }
      partial = true;
      if (filled === 0) capabilities.push(contributorRow(contributor, input.profile, "unknown", "contributor_empty"));
      outcomes.push({ id: contributor.id, outcome: "refused", reasonCode: "contributor_empty", elapsedMs });
      continue;
    }
    const limit = Math.max(0, Math.min(MAX_CONTRIBUTOR_ROWS, room));
    let refusal: ReasonCode | undefined;
    let unattributed = false;
    let unattributedRequired = false;
    const rows = result as readonly ReadinessRow[];
    for (const raw of rows.slice(0, limit)) {
      const why = rowRefusal(raw, contributor, input.profile)
        ?? (input.knownCapability !== undefined && !input.knownCapability(raw.capabilityId) ? "row_refused" : undefined);
      const usableId = typeof raw === "object" && raw !== null && isCapabilityId(raw.capabilityId)
        && contributor.namespaces.includes(raw.capabilityId.split(":")[0]!) && !owned.has(raw.capabilityId)
        && (input.knownCapability === undefined || input.knownCapability(raw.capabilityId));
      // Required-ness a row does not state plainly counts as required.
      const rawRequired = typeof raw !== "object" || raw === null || raw.required !== false;
      if (why !== undefined) {
        refusal ??= why;
        if (usableId) {
          // No row disappears: the capability stays, as unknown.
          owned.add(raw.capabilityId);
          capabilities.push({
            capabilityId: raw.capabilityId,
            profile: input.profile,
            descriptorDigest: digestOf({ capabilityId: raw.capabilityId, refused: true }),
            status: "unknown",
            evidenceLevel: "configuration",
            reasonCode: "row_refused",
            evidenceRefs: [ref("owns", contributor.namespaces.join(","))],
            required: rawRequired || contributor.required,
            contributor: contributor.id,
          });
        } else {
          unattributed = true;
          unattributedRequired ||= rawRequired || contributor.required;
        }
        continue;
      }
      if (owned.has(raw.capabilityId)) {
        refusal ??= "row_refused";
        unattributed = true;
        unattributedRequired ||= raw.required || contributor.required;
        continue;
      }
      owned.add(raw.capabilityId);
      let row = raw;
      if (evidenceRank(row.evidenceLevel) > evidenceRank(contributor.maxEvidence)) {
        // Evidence this contributor cannot have observed is not evidence.
        refusal ??= "evidence_above_contributor_scope";
        row = { ...row, status: "unknown", evidenceLevel: contributor.maxEvidence, reasonCode: "evidence_above_contributor_scope", suggestedAction: undefined as never };
        const { suggestedAction: _dropped, ...rest } = row;
        row = rest;
      }
      capabilities.push(cleanRow(row, contributor.id));
    }
    // One stand-in row per contributor: a cut beats a refusal as its reason,
    // and it is required when either would be.
    if (rows.length > limit) {
      truncated = true;
      refusal ??= "rows_truncated";
      capabilities.push(contributorRow(contributor, input.profile, "unknown", "rows_truncated", contributor.required || unattributedRequired));
    } else if (unattributed) {
      capabilities.push(contributorRow(contributor, input.profile, "unknown", "row_refused", unattributedRequired));
    }
    if (refusal !== undefined) {
      partial = true;
      outcomes.push({ id: contributor.id, outcome: "refused", reasonCode: refusal, elapsedMs });
    } else {
      outcomes.push({ id: contributor.id, outcome: "ok", elapsedMs });
    }
  }
  return { capabilities, contributors: outcomes, partial, truncated };
}

// ---------------------------------------------------------------------------
// Contributors on the real resolver, manifest, boot and registry
// ---------------------------------------------------------------------------

/** The boot's own verdict, shared by the contributors that read it. */
export interface BootVerdictHolder {
  verdict?: BootPreparation;
}

const BOOT_REFUSAL: Record<string, ReasonCode> = {
  manifest: "boot_refused_manifest",
  import: "boot_refused_import",
  claims: "boot_refused_claims",
  activation: "boot_refused_activation",
  preflight: "boot_refused_registration_precondition",
};

/**
 * `profile:boot` IS the boot (#230 round 5, B0): the boot's own prepare phase
 * (boot.ts `prepareBoot`) on the request `dokkabi work` would build from the
 * same inputs (`resolveBootRequest`) — manifest swap, loader, claim
 * validation, activation and every plugin's preflight — which is the phase
 * where every boot refusal is made; `work` commits after it. Any refusal is
 * the boot's own; a plugin the prepare phase cannot judge makes it unknown.
 */
export function profileBootContributor(input: {
  readonly request: BootRequest;
  readonly holder: BootVerdictHolder;
  readonly prepare?: (request: BootRequest) => Promise<BootPreparation>;
}): ReadinessContributor {
  return {
    id: "boot",
    namespaces: ["profile"],
    maxEvidence: "configuration",
    required: true,
    deadlineMs: 30_000,
    async inspect(request) {
      const verdict = input.prepare ? await input.prepare(input.request) : (await prepareBoot(input.request)).verdict;
      input.holder.verdict = verdict;
      const base = { capabilityId: "profile:boot", profile: request.profile, descriptorDigest: digestOf({ capabilityId: "profile:boot", manifest: basename(input.request.manifestPath) }), required: true };
      if (verdict.status === "admissible") {
        return [{ ...base, status: "ready", evidenceLevel: "configuration", reasonCode: "boot_admissible", evidenceRefs: [] }];
      }
      const refs = verdict.pluginId !== undefined && /^[a-z][a-z0-9_.-]{0,63}$/u.test(verdict.pluginId) ? [ref("refused", verdict.pluginId)] : [];
      if (verdict.status === "unknown") {
        return [{ ...base, status: "unknown", evidenceLevel: "configuration", reasonCode: "boot_not_preparable", evidenceRefs: refs }];
      }
      return [{ ...base, status: "degraded", evidenceLevel: "configuration", reasonCode: BOOT_REFUSAL[verdict.stage]!,
        evidenceRefs: [...refs, ref("stage", verdict.stage)],
        suggestedAction: verdict.stage === "activation" && verdict.pluginId !== undefined && refs.length > 0
          ? action("fix_plugin_configuration", verdict.pluginId)
          : action("fix_boot") }];
    },
  };
}

const DRY_SKIP: Record<string, { status: ReadinessStatus; reason: ReasonCode; required: boolean }> = {
  not_configured: { status: "disabled", reason: "skipped_not_configured", required: false },
  invalid_configuration: { status: "degraded", reason: "skipped_invalid_configuration", required: true },
  unavailable: { status: "unsupported", reason: "skipped_unavailable", required: false },
  unclassified: { status: "unknown", reason: "skipped_unclassified", required: true },
};

/** Static descriptors of a profile: what its manifest lists, each plugin
 * judged by the boot's prepare phase — would it activate, skip (as it classifies
 * itself), refuse, or could the prepare phase not tell. */
export function profileManifestContributor(manifest: () => ResolvedManifest, holder: BootVerdictHolder): ReadinessContributor {
  return {
    id: "profile",
    namespaces: ["plugin", "skill"],
    maxEvidence: "configuration",
    required: true,
    async inspect(input) {
      const resolved = manifest();
      const rows: ReadinessRow[] = [];
      for (const plugin of resolved.plugins) {
        const base = { capabilityId: `plugin:${plugin.id}`, profile: input.profile, descriptorDigest: plugin.digest, evidenceLevel: "configuration" as const };
        const refs = [ref("kind", plugin.kind)];
        const verdict = holder.verdict?.plugins.get(plugin.id);
        if (verdict?.verdict === "active") {
          rows.push({ ...base, status: "ready", reasonCode: "activates_at_boot", evidenceRefs: refs, required: true });
        } else if (verdict?.verdict === "skipped") {
          const skip = DRY_SKIP[verdict.kind]!;
          rows.push({ ...base, status: skip.status, reasonCode: skip.reason, evidenceRefs: [...refs, ref("skip", verdict.kind)], required: skip.required });
        } else if (verdict?.verdict === "refused") {
          rows.push({ ...base, status: "degraded", reasonCode: "activation_refused", evidenceRefs: [...refs, ref("stage", verdict.stage)], required: true,
            suggestedAction: action("fix_plugin_configuration", plugin.id) });
        } else {
          rows.push({ ...base, status: "unknown", reasonCode: "not_preparable", evidenceRefs: refs, required: true });
        }
        // A skill stands or falls with its plugin, and is never required.
        const own = rows.at(-1)!;
        for (const skill of plugin.skills) {
          rows.push({
            capabilityId: `skill:${skill.id}`,
            profile: input.profile,
            descriptorDigest: skill.digest,
            status: own.status,
            evidenceLevel: "configuration",
            reasonCode: verdict?.verdict === "active" ? "declared_by_profile_package" : own.reasonCode,
            evidenceRefs: [ref("plugin", plugin.id)],
            required: false,
          });
        }
      }
      return rows;
    },
  };
}

const SKIP_STATUS: Record<string, { status: ReadinessStatus; reason: ReasonCode; required: boolean }> = {
  not_configured: { status: "disabled", reason: "skipped_not_configured", required: false },
  invalid_configuration: { status: "degraded", reason: "skipped_invalid_configuration", required: true },
  unavailable: { status: "unsupported", reason: "skipped_unavailable", required: false },
  unclassified: { status: "unknown", reason: "skipped_unclassified", required: true },
};

/** A session's own record of what registered. `registered` is the strongest
 * claim it makes: registration is not a successful request. When the session
 * is not running, the inventory is `recorded`, and one required unknown row
 * says so — strict never treats a recorded inventory as current (D4). */
export function sessionInventoryContributor(
  snapshot: InventorySnapshot,
  manifest: ResolvedManifest,
  live: boolean,
): ReadinessContributor {
  return {
    id: "inventory",
    namespaces: ["plugin", "skill", "inventory"],
    maxEvidence: "registered",
    required: true,
    async inspect(input) {
      const rows: ReadinessRow[] = [];
      const seq = (plugin?: InventoryPlugin) => ref("inventory_seq", plugin?.seq ?? snapshot.observedSeq);
      rows.push({
        capabilityId: "inventory:session",
        profile: input.profile,
        descriptorDigest: digestOf({ capabilityId: "inventory:session", manifest: manifest.digest }),
        status: live ? "ready" : "unknown",
        evidenceLevel: "registered",
        reasonCode: live ? "inventory_live" : "inventory_recorded_not_live",
        evidenceRefs: [ref("inventory", live ? "live" : "recorded"), seq()],
        required: true,
        ...(live ? {} : { suggestedAction: action("session_not_live") }),
      });
      for (const plugin of manifest.plugins) {
        const found = snapshot.plugins.get(plugin.id);
        const refs = [seq(found)];
        const base = { capabilityId: `plugin:${plugin.id}`, profile: input.profile, descriptorDigest: plugin.digest };
        if (!found) {
          rows.push({ ...base, status: "unknown", evidenceLevel: "registered", reasonCode: "not_in_inventory", evidenceRefs: refs, required: true });
          continue;
        }
        if (found.digest !== plugin.digest) {
          rows.push({ ...base, status: "degraded", evidenceLevel: "registered", reasonCode: "inventory_digest_differs", evidenceRefs: refs, required: true });
          continue;
        }
        switch (found.state) {
          case "active": {
            rows.push({ ...base, status: "ready", evidenceLevel: "registered", reasonCode: "registered_by_runtime", evidenceRefs: refs, required: true });
            const declared = new Set(plugin.skills.map((skill) => skill.id));
            for (const skill of plugin.skills) {
              if (!found.skills.includes(skill.id) || !declared.has(skill.id)) continue;
              rows.push({ capabilityId: `skill:${skill.id}`, profile: input.profile, descriptorDigest: skill.digest,
                status: "ready", evidenceLevel: "registered", reasonCode: "registered_by_runtime", evidenceRefs: [ref("plugin", plugin.id)], required: false });
            }
            break;
          }
          case "skipped": {
            const verdict = SKIP_STATUS[found.skipClass ?? "unclassified"]!;
            rows.push({ ...base, status: verdict.status, evidenceLevel: "registered", reasonCode: verdict.reason,
              evidenceRefs: [...refs, ref("skip", found.skipClass ?? "unclassified")], required: verdict.required });
            break;
          }
          case "unloaded":
            rows.push({ ...base, status: "disabled", evidenceLevel: "registered", reasonCode: "unloaded_at_runtime", evidenceRefs: refs, required: false });
            break;
          case "pending":
            rows.push({ ...base, status: "unknown", evidenceLevel: "registered", reasonCode: "pending_dependency", evidenceRefs: refs, required: true });
            break;
          case "failed":
            rows.push({ ...base, status: "degraded", evidenceLevel: "registered", reasonCode: "transition_failed", evidenceRefs: refs, required: true });
            break;
        }
      }
      return rows;
    },
  };
}

/** A session whose inventory cannot stand as this profile's registration:
 * another profile's, unreadable, too large, or overflowing. One required
 * unknown row says which; the static descriptors stand beside it. */
export function sessionProblemContributor(reasonCode: ReasonCode, manifestDigest?: string): ReadinessContributor {
  return {
    id: "inventory",
    namespaces: ["inventory"],
    maxEvidence: "registered",
    required: true,
    async inspect(input) {
      return [{
        capabilityId: "inventory:session",
        profile: input.profile,
        descriptorDigest: digestOf({ capabilityId: "inventory:session", reasonCode }),
        status: "unknown",
        evidenceLevel: "configuration",
        reasonCode,
        evidenceRefs: manifestDigest ? [ref("session_manifest", manifestDigest.slice(0, 12))] : [],
        required: true,
        ...(reasonCode === "inventory_belongs_to_other_profile" ? { suggestedAction: action("pass_session_profile") } : {}),
      }];
    },
  };
}

const DESCRIPTOR_MAX_BYTES = 64 * 1024;
/** How far into an unreadable descriptor its declared ids are looked for. */
const DESCRIPTOR_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_DESCRIPTOR_CAPABILITIES = 16;
const PACKAGE_ID = /^[a-z][a-z0-9_.-]{0,63}$/u;
const CAPABILITY_NAME = /^[a-z][a-z0-9_.-]{0,63}$/u;

const PackageReadinessSchema = z.object({
  format: z.literal(1),
  capabilities: z.array(z.object({
    id: z.string().regex(CAPABILITY_NAME),
    summary: z.string().min(1).max(200),
    enable_action: z.enum(["knowledge_init"]).optional(),
  }).strict()).max(MAX_DESCRIPTOR_CAPABILITIES),
}).strict();

export interface PackageCapabilityDescriptor {
  readonly id: string;
  readonly provider: string;
  readonly enableAction?: ActionId;
  readonly digest: string;
}

export interface BrokenDescriptor {
  readonly provider: string;
  /** The capability ids the unreadable descriptor still declares, as far as
   * they can be read; empty when none can. */
  readonly ids: readonly string[];
}

export interface PackageDescriptors {
  readonly descriptors: readonly PackageCapabilityDescriptor[];
  /** Packages whose descriptor could not be read: their capabilities are unknown. */
  readonly broken: readonly BrokenDescriptor[];
}

/** Up to `limit` bytes of a regular file, opened without following a link. */
function boundedRead(path: string, limit: number): { bytes: Buffer; size: number } {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error("descriptor is not a regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, read), size: stat.size };
  } finally {
    closeSync(fd);
  }
}

/** The ids an unreadable descriptor still declares (D5'): from its parsed
 * `capabilities` when it is JSON of the wrong shape, else from `"id": "…"`
 * pairs in its first bytes. Bounded; ids only, never other text. */
function declaredIds(text: string): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && CAPABILITY_NAME.test(value) && !ids.includes(value) && ids.length < MAX_DESCRIPTOR_CAPABILITIES) ids.push(value);
  };
  try {
    const parsed = JSON.parse(text) as { capabilities?: unknown };
    if (Array.isArray(parsed?.capabilities)) for (const entry of parsed.capabilities) add((entry as { id?: unknown })?.id);
    return ids;
  } catch {
    for (const match of text.matchAll(/"id"\s*:\s*"([a-z][a-z0-9_.-]{0,63})"/gu)) add(match[1]);
    return ids;
  }
}

/**
 * The capability descriptors plugin packages ship beside their plugin.json
 * (`readiness.json`): read-only data a package declares about itself, read
 * without importing the package, bounded in size and count. A descriptor that
 * cannot be read keeps the capability ids it still declares, as unknown rows
 * under those ids (D2, D5'); only one that declares none readable falls back
 * to its package's name. It never empties the inventory.
 */
export function readPackageCapabilityDescriptors(pluginsDir: string): PackageDescriptors {
  const descriptors: PackageCapabilityDescriptor[] = [];
  const broken: BrokenDescriptor[] = [];
  if (!existsSync(pluginsDir)) return { descriptors, broken };
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, 256)) {
    if (!entry.isDirectory()) continue;
    const descriptorPath = join(pluginsDir, entry.name, "readiness.json");
    if (!existsSync(descriptorPath)) continue;
    let provider = PACKAGE_ID.test(entry.name) ? entry.name : "unnamed";
    let text = "";
    try {
      const pkg = boundedRead(join(pluginsDir, entry.name, "plugin.json"), DESCRIPTOR_MAX_BYTES);
      provider = z.object({ id: z.string().regex(PACKAGE_ID) }).passthrough().parse(JSON.parse(pkg.bytes.toString("utf8"))).id;
      const read = boundedRead(descriptorPath, DESCRIPTOR_SCAN_BYTES);
      text = read.bytes.toString("utf8");
      if (read.size > DESCRIPTOR_MAX_BYTES) throw new Error("descriptor out of bounds");
      const parsed = PackageReadinessSchema.parse(JSON.parse(text));
      for (const capability of parsed.capabilities) {
        descriptors.push({
          id: capability.id,
          provider,
          ...(capability.enable_action !== undefined ? { enableAction: capability.enable_action } : {}),
          digest: digestOf({ provider, capability }),
        });
      }
    } catch {
      broken.push({ provider, ids: declaredIds(text) });
    }
  }
  return { descriptors, broken };
}

const PROVIDER_SKIP: Record<string, { status: ReadinessStatus; reason: ReasonCode }> = {
  not_configured: { status: "disabled", reason: "provider_skipped_not_configured" },
  invalid_configuration: { status: "degraded", reason: "provider_skipped_invalid_configuration" },
  unavailable: { status: "unsupported", reason: "provider_skipped_unavailable" },
  unclassified: { status: "unknown", reason: "provider_skipped_unclassified" },
};

/**
 * Package capabilities for the selected profile. A capability's provider not
 * in the profile's manifest is missing there, whatever the configuration
 * says. Otherwise the provider's own activation decides, as the boot's prepare
 * phase observed it (never a doctor-side copy of a gate, D1'): it activates
 * (ready), skips as it classifies itself, refuses (degraded), or the prepare phase
 * could not tell (unknown). A session inventory decides registration when one
 * is present. Configuration alone never reaches `registered`.
 */
export function packageCapabilityContributor(input: {
  readonly descriptors: () => PackageDescriptors;
  readonly manifest: () => ResolvedManifest;
  readonly boot: BootVerdictHolder;
  readonly snapshot?: InventorySnapshot;
  /** Other selectable profiles that mount a provider, for the suggested action. */
  readonly mountedBy: (provider: string) => readonly ExecutionProfileName[];
}): ReadinessContributor {
  return {
    id: "capabilities",
    namespaces: ["capability"],
    maxEvidence: input.snapshot ? "registered" : "configuration",
    required: false,
    async inspect(request) {
      const manifest = input.manifest();
      const mounted = new Set(manifest.plugins.map((plugin) => plugin.id));
      const rows: ReadinessRow[] = [];
      const { descriptors, broken } = input.descriptors();
      for (const damaged of broken) {
        const ids = damaged.ids.length > 0 ? damaged.ids : [damaged.provider];
        for (const id of ids) {
          rows.push({ capabilityId: `capability:${id}`, profile: request.profile, descriptorDigest: digestOf({ broken: damaged.provider, id }),
            status: "unknown", evidenceLevel: "configuration", reasonCode: "descriptor_unreadable",
            evidenceRefs: damaged.provider === "unnamed" ? [] : [ref("provider", damaged.provider)], required: false });
        }
      }
      for (const descriptor of descriptors) {
        const base = { capabilityId: `capability:${descriptor.id}`, profile: request.profile, descriptorDigest: descriptor.digest, required: false };
        const refs = [ref("provider", descriptor.provider)];
        if (!mounted.has(descriptor.provider)) {
          const others = input.mountedBy(descriptor.provider).filter((profile) => profile !== request.profile);
          rows.push({ ...base, status: "missing", evidenceLevel: "configuration", reasonCode: "provider_not_in_profile",
            evidenceRefs: refs,
            suggestedAction: others.length > 0
              ? action("use_profile_mounting", request.profile, descriptor.provider, ...others)
              : action("no_profile_mounts", request.profile, descriptor.provider) });
          continue;
        }
        if (input.snapshot) {
          const found = input.snapshot.plugins.get(descriptor.provider);
          const liveRefs = [...refs, ref("inventory_seq", found?.seq ?? input.snapshot.observedSeq)];
          if (found?.state === "active") {
            rows.push({ ...base, status: "ready", evidenceLevel: "registered", reasonCode: "provider_registered", evidenceRefs: liveRefs });
          } else if (found?.state === "skipped") {
            const skip = PROVIDER_SKIP[found.skipClass ?? "unclassified"]!;
            rows.push({ ...base, status: skip.status, evidenceLevel: "registered", reasonCode: skip.reason, evidenceRefs: liveRefs,
              ...(found.skipClass === "not_configured" && descriptor.enableAction ? { suggestedAction: action(descriptor.enableAction) } : {}) });
          } else if (found?.state === "unloaded") {
            rows.push({ ...base, status: "disabled", evidenceLevel: "registered", reasonCode: "provider_unloaded_at_runtime", evidenceRefs: liveRefs });
          } else if (found?.state === "failed") {
            rows.push({ ...base, status: "degraded", evidenceLevel: "registered", reasonCode: "provider_transition_failed", evidenceRefs: liveRefs });
          } else {
            rows.push({ ...base, status: "unknown", evidenceLevel: "registered",
              reasonCode: found ? "provider_pending" : "provider_not_in_inventory", evidenceRefs: liveRefs });
          }
          continue;
        }
        const verdict = input.boot.verdict?.plugins.get(descriptor.provider);
        if (verdict?.verdict === "active") {
          rows.push({ ...base, status: "ready", evidenceLevel: "configuration", reasonCode: "provider_activates_at_boot",
            evidenceRefs: [...refs, ref("registration", "not_observed")] });
        } else if (verdict?.verdict === "skipped") {
          const skip = PROVIDER_SKIP[verdict.kind]!;
          rows.push({ ...base, status: skip.status, evidenceLevel: "configuration", reasonCode: skip.reason, evidenceRefs: [...refs, ref("skip", verdict.kind)],
            ...(verdict.kind === "not_configured" && descriptor.enableAction ? { suggestedAction: action(descriptor.enableAction) } : {}) });
        } else if (verdict?.verdict === "refused") {
          rows.push({ ...base, status: "degraded", evidenceLevel: "configuration", reasonCode: "provider_activation_refused",
            evidenceRefs: [...refs, ref("stage", verdict.stage)], suggestedAction: action("fix_plugin_configuration", descriptor.provider) });
        } else {
          rows.push({ ...base, status: "unknown", evidenceLevel: "configuration", reasonCode: "provider_not_preparable", evidenceRefs: refs });
        }
      }
      return rows;
    },
  };
}

/** The existing machine probe as a contributor: the fenced toolchain probe
 * runs only with allowLocalProbe, killed on the contributor's signal. */
export function hostContributor(cwd: string): ReadinessContributor {
  return {
    id: "host",
    namespaces: ["host"],
    maxEvidence: "local-probe",
    required: true,
    deadlineMs: 30_000,
    async inspect(input, signal) {
      const facts = await probeMachine({ cwd, probe: input.allowLocalProbe, signal });
      return hostReadiness(facts, input.profile);
    },
  };
}

/** Route and credential presence. Configuration evidence only. */
export function modelContributor(): ReadinessContributor {
  return {
    id: "model",
    namespaces: ["model"],
    maxEvidence: "configuration",
    required: true,
    async inspect(input) {
      return modelReadiness(resolveLlmSelection(), input.profile);
    },
  };
}

// ---------------------------------------------------------------------------
// Protected state (D5': bounded by declaration, passed by the CLI)
// ---------------------------------------------------------------------------

/**
 * What a diagnosis must leave as it found it, by declaration (D5'): the
 * identity of each declared path — device, inode, type, mode, size, change and
 * modification times, without following a link — not a walk. Its cost is the
 * number of declared paths, and it is complete for them: any write to one
 * moves its change time.
 */
export function protectedStateFingerprint(paths: readonly string[]): string {
  return digestOf(paths.map((path) => {
    try {
      const stat = lstatSync(path, { bigint: true });
      return `${path}\0${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.ctimeNs}:${stat.mtimeNs}`;
    } catch {
      return `${path}\0absent`;
    }
  }).join("\n"));
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function manifestFor(repoRoot: string, profile: ExecutionProfileName, env: NodeJS.Dict<string>): string {
  return effectiveManifestPath(profileManifestPath(repoRoot, profile, env), env);
}

/** The selectable profile a session's inventory was booted with, if any. */
export function profileOfInventory(
  repoRoot: string,
  snapshot: InventorySnapshot,
  env: NodeJS.Dict<string> = process.env,
): ExecutionProfileName | undefined {
  for (const profile of EXECUTION_PROFILE_NAMES) {
    try {
      if (resolvePluginManifest(manifestFor(repoRoot, profile, env)).digest === snapshot.manifestDigest) return profile;
    } catch {
      // An unresolvable manifest names no session.
    }
  }
  return undefined;
}

/** The fixed capabilities and their declared required-ness. */
const FIXED_CAPABILITIES: readonly DeclaredCapability[] = [
  { id: "profile:boot", required: true },
  { id: "inventory:session", required: true },
  { id: "host:sandbox", required: true },
  { id: "host:network", required: true },
  { id: "host:toolchain", required: false },
  { id: "host:permissions", required: false },
  { id: "host:ssh", required: false },
  { id: "host:config", required: false },
  ...PROBE_TOOLS.map((tool) => ({ id: `host:toolchain:${tool}`, required: false })),
  { id: "model:selection", required: true },
  { id: "model:authentication", required: false },
  { id: "doctor:key", required: false },
];

/**
 * The closed vocabulary of capability ids a report may name (D3): the fixed
 * host, model, profile and inventory ids, the probe's own tools, and every
 * plugin, skill and package capability the repository's manifests and
 * descriptors define. Nothing from the operator's configuration is in it.
 */
export function knownCapabilities(repoRoot: string, env: NodeJS.Dict<string>): Set<string> {
  const known = new Set<string>(FIXED_CAPABILITIES.map((entry) => entry.id));
  for (const profile of EXECUTION_PROFILE_NAMES) {
    try {
      for (const plugin of resolvePluginManifest(manifestFor(repoRoot, profile, env)).plugins) {
        known.add(`plugin:${plugin.id}`);
        for (const skill of plugin.skills) known.add(`skill:${skill.id}`);
      }
    } catch {
      // An unresolvable manifest defines nothing.
    }
  }
  const { descriptors, broken } = readPackageCapabilityDescriptors(join(repoRoot, "plugins"));
  for (const descriptor of descriptors) known.add(`capability:${descriptor.id}`);
  for (const damaged of broken) {
    if (damaged.ids.length === 0) known.add(`capability:${damaged.provider}`);
    for (const id of damaged.ids) known.add(`capability:${id}`);
  }
  return known;
}

/** Every capability the selected profile's contributors own (D5'). */
function declaredCapabilities(manifest: ResolvedManifest | undefined, packages: PackageDescriptors, session: boolean): DeclaredCapability[] {
  const declared: DeclaredCapability[] = FIXED_CAPABILITIES.filter((entry) => entry.id !== "doctor:key" && (session || entry.id !== "inventory:session"));
  for (const plugin of manifest?.plugins ?? []) {
    declared.push({ id: `plugin:${plugin.id}`, required: true });
    for (const skill of plugin.skills) declared.push({ id: `skill:${skill.id}`, required: false });
  }
  for (const descriptor of packages.descriptors) declared.push({ id: `capability:${descriptor.id}`, required: false });
  for (const damaged of packages.broken) {
    for (const id of damaged.ids.length > 0 ? damaged.ids : [damaged.provider]) declared.push({ id: `capability:${id}`, required: false });
  }
  return declared;
}

/** A key the caller passed, if it is one; never a throw (D3'). */
function usableKey(value: unknown): InstallationKey | undefined {
  if (Buffer.isBuffer(value)) return value.length === 32 ? { key: value, keyId: keyIdOf(value), persistent: true } : undefined;
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<InstallationKey>;
  return Buffer.isBuffer(candidate.key) && candidate.key.length === 32 && typeof candidate.keyId === "string" && typeof candidate.persistent === "boolean"
    ? candidate as InstallationKey : undefined;
}

export class DoctorEnvironmentError extends Error {
  constructor(readonly code: "work_refuses_environment" | "profile_unknown" | "session_profile_unknown", message: string) {
    super(message);
  }
}

/** Work's refusal, in the closed vocabulary: never the value it refused. */
function workRefusal(error: unknown): DoctorEnvironmentError {
  const message = error instanceof Error ? error.message : "";
  const detail = message.startsWith("--planner ledger runs its own session")
    ? "--planner ledger runs its own session; --loop model does not apply to it"
    : message.startsWith("--loop must be")
      ? "DOKKABI_WORK_LOOP must be graph or model"
      : message.startsWith("--planner must be")
        ? "DOKKABI_WORK_PLANNER must be host, model or ledger"
        : "the environment is not one it can boot";
  return new DoctorEnvironmentError("work_refuses_environment", `doctor: dokkabi work refuses this environment, so there is no profile to diagnose: ${detail}`);
}

export async function buildDoctorReport(input: {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly profile?: string;
  /** A session read by readSessionForDoctor. */
  readonly session?: SessionRead;
  readonly allowLocalProbe: boolean;
  readonly env?: NodeJS.Dict<string>;
  readonly config?: () => unknown;
  /** This installation's key (doctor-identity.ts); obtained — made on first
   * use, ephemeral on any problem — when absent or unusable. A bare 32-byte
   * buffer is taken as a key the caller holds. */
  readonly key?: InstallationKey | Buffer;
  /** The fence attestation (doctor-freshness.ts attestFence when absent). */
  readonly fence?: (probe: boolean) => string;
  /** The boot's prepare phase (boot.ts prepareBoot when absent). */
  readonly prepare?: (request: BootRequest) => Promise<BootPreparation>;
  /** `--workspace`, as `dokkabi work` takes it. */
  readonly workspace?: string;
  /** Replaces the machine and model contributors (tests inject fakes here). */
  readonly machineContributors?: readonly ReadinessContributor[];
  /** Added after the built-in contributors (fault-injection seam). */
  readonly extraContributors?: readonly ReadinessContributor[];
  readonly protectedState?: () => string;
  readonly defaultDeadlineMs?: number;
}): Promise<DoctorReport> {
  const env = input.env ?? process.env;
  const config = input.config ?? (() => readConfig());
  const session = input.session;
  const snapshot = session?.ok ? session.snapshot : undefined;
  let profile: ExecutionProfileName;
  if (input.profile !== undefined) {
    if (!isExecutionProfileName(input.profile)) {
      throw new DoctorEnvironmentError("profile_unknown", `usage: doctor --profile takes one of ${EXECUTION_PROFILE_NAMES.join(", ")}`);
    }
    profile = input.profile;
  } else if (snapshot) {
    const inferred = profileOfInventory(input.repoRoot, snapshot, env);
    if (!inferred) throw new DoctorEnvironmentError("session_profile_unknown", "doctor: the session's manifest matches no selectable profile; pass --profile");
    profile = inferred;
  } else {
    // The profile `dokkabi work` would boot — or its own refusal (D1).
    try {
      profile = effectiveWorkProfile(env);
    } catch (error) {
      throw workRefusal(error);
    }
  }
  const key = usableKey(input.key) ?? installationKey({ create: true, workspace: input.cwd });
  const requested = profileManifestPath(input.repoRoot, profile, env);
  let manifest: ResolvedManifest | undefined;
  try {
    manifest = resolvePluginManifest(manifestFor(input.repoRoot, profile, env));
  } catch {
    manifest = undefined;
  }
  const requireManifest = (): ResolvedManifest => {
    if (!manifest) throw new Error("profile manifest does not resolve");
    return manifest;
  };
  const packages = readPackageCapabilityDescriptors(join(input.repoRoot, "plugins"));
  const usable = snapshot !== undefined && manifest !== undefined && snapshot.manifestDigest === manifest.digest && !snapshot.overflow;
  const live = usable && session?.ok === true && session.identity.live;
  const holder: BootVerdictHolder = {};
  // The request `dokkabi work` would boot, from the same inputs by the same resolver.
  const bootRequest = resolveBootRequest({
    profile, sessionId: "doctor-prepare", repoRoot: input.repoRoot, env, cwd: input.cwd,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
  });
  const contributors: ReadinessContributor[] = [profileBootContributor({
    request: bootRequest, holder, ...(input.prepare ? { prepare: input.prepare } : {}),
  })];
  if (usable) {
    contributors.push(sessionInventoryContributor(snapshot!, manifest!, live));
  } else {
    contributors.push(profileManifestContributor(requireManifest, holder));
    if (session !== undefined) {
      const problem: ReasonCode = !session.ok
        ? session.reasonCode
        : snapshot === undefined ? "session_has_no_inventory"
          : snapshot.overflow ? "inventory_overflow" : "inventory_belongs_to_other_profile";
      contributors.push(sessionProblemContributor(problem, snapshot?.manifestDigest));
    }
  }
  contributors.push(packageCapabilityContributor({
    descriptors: () => packages,
    manifest: requireManifest,
    boot: holder,
    ...(usable ? { snapshot } : {}),
    mountedBy: (provider) => EXECUTION_PROFILE_NAMES.filter((candidate) => {
      try {
        return resolvePluginManifest(manifestFor(input.repoRoot, candidate, env)).plugins.some((plugin) => plugin.id === provider);
      } catch {
        return false;
      }
    }),
  }));
  contributors.push(...(input.machineContributors ?? [hostContributor(input.cwd), modelContributor()]));
  contributors.push(...(input.extraContributors ?? []));
  const known = knownCapabilities(input.repoRoot, env);
  const declared = declaredCapabilities(manifest, packages, session !== undefined);
  const run = await runReadinessContributors({
    profile,
    allowLocalProbe: input.allowLocalProbe,
    contributors,
    knownCapability: (id) => known.has(id) || (id.startsWith("contributor:") && contributors.some((item) => `contributor:${item.id}` === id)),
    declared: (contributor) => declared.filter((entry) => contributor.namespaces.includes(entry.id.split(":")[0]!)),
    ...(input.defaultDeadlineMs !== undefined ? { defaultDeadlineMs: input.defaultDeadlineMs } : {}),
    ...(input.protectedState ? { protectedState: input.protectedState } : {}),
  });
  const capabilities = [...run.capabilities];
  if (!key.persistent) {
    // An unusable key is said, never a crash (D3'): this report is signed by
    // an ephemeral key, so nothing can recheck it later.
    capabilities.push({
      capabilityId: "doctor:key", profile, descriptorDigest: digestOf({ capabilityId: "doctor:key" }), status: "unknown",
      evidenceLevel: "configuration", reasonCode: "key_unavailable",
      evidenceRefs: [
        ...(key.problem ? [ref("key_problem", key.problem)] : []),
        ...(key.configProblem ? [ref("config_problem", key.configProblem)] : []),
      ], required: false,
      suggestedAction: action("reset_doctor_key"), contributor: "identity",
    });
  }
  const generation = usable
    ? `${live ? "live" : "recorded"}:${snapshot!.digest}`
    : manifest ? `static:${manifest.digest}` : undefined;
  let fenceAttestation: string;
  try {
    fenceAttestation = (input.fence ?? ((probe: boolean) => attestFence({ cwd: input.cwd, probe })))(input.allowLocalProbe);
  } catch {
    fenceAttestation = "unknown";
  }
  const body = {
    version: DOCTOR_REPORT_VERSION,
    profile,
    configDigest: configDigest(config(), env, key.key),
    manifestDigest: manifest?.digest ?? digestOf({ unresolved: basename(requested) }),
    ...(generation ? { inventoryGeneration: generation } : {}),
    inventorySource: usable ? (live ? "live" : "recorded") : "static",
    ...(session?.ok ? { session: session.identity } : {}),
    probe: input.allowLocalProbe,
    fenceAttestation: FENCE_ATTESTATION.test(fenceAttestation) ? fenceAttestation : "unknown",
    capabilities,
    contributors: run.contributors,
    // A profile its own boot refuses is not observed running by any row, an
    // unreadable descriptor leaves its package's capabilities unknown, and an
    // ephemeral key leaves the report uncheckable.
    partial: run.partial || manifest === undefined || (session !== undefined && !usable) || !key.persistent
      || run.capabilities.some((entry) => (entry.capabilityId === "profile:boot" && entry.status !== "ready")
        || entry.reasonCode === "descriptor_unreadable"),
    truncated: run.truncated,
  } as const;
  const report = authenticateReport(body, key) as DoctorReport;
  assertDoctorReportSecretFree(report);
  return report;
}

/** The protected paths a CLI diagnosis declares: the operator config, the
 * credential store and its directory, the Dokkabi home and the workspace. */
export function cliProtectedState(workspaceRoot: string): () => string {
  const credentials = piAuthPath();
  const paths = [configPath(), credentials, dirname(credentials), dokkabiHome(), workspaceRoot];
  return () => protectedStateFingerprint(paths);
}

/**
 * The standalone diagnosis record: one `doctor/report` row in a fresh log of
 * its own, never appended to the diagnosed session (whose log only its own
 * runtime writes). `dokkabi dash --session <id>` shows it under ALERTS.
 */
export function recordDoctorReport(report: DoctorReport): { sessionId: string; path: string } {
  assertDoctorReportSecretFree(report);
  const sessionId = `doctor-${report.profile}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const path = sessionLogPath(sessionId);
  const log = EventLog.create(path);
  log.appendDurable({ kind: "observe", name: DOCTOR_REPORT_EVENT, payload: { report } });
  return { sessionId, path };
}
