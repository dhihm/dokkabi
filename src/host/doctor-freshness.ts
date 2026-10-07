import { resolvePluginManifest } from "../loader/manifest.ts";
import { configDigest, reportAuthentic, type InstallationKey } from "./doctor-identity.ts";
import {
  reportFreshness,
  type DoctorReport,
  type ObservedIdentity,
  type StaleReason,
} from "./doctor-report.ts";
import { readSessionForDoctor } from "./doctor-session.ts";
import {
  effectiveManifestPath,
  isExecutionProfileName,
  profileManifestPath,
} from "./execution-profile.ts";
import { createPolicy, detectBackend, disposeSandboxPolicy, sandboxDisabled } from "./sandbox.ts";

/**
 * One freshness function (#230 round 3, D5'): `dokkabi doctor` (right after
 * it builds a report) and the dashboard (before it shows a recorded one)
 * decide "current" here, over the same inputs — the report's authenticity
 * under the installation key, its profile, configuration digest, manifest or
 * session-inventory generation, fence attestation and key id against what
 * this machine has now.
 */

/**
 * The fence as a diagnosis sees it, in the closed vocabulary of
 * FENCE_ATTESTATION. Without `probe` nothing is started (switch and backend
 * only); with it the policy is created — its startup attestation runs — and
 * released at once. Never throws.
 */
export function attestFence(input: { readonly cwd: string; readonly probe: boolean }): string {
  let off: boolean;
  try {
    off = sandboxDisabled();
  } catch {
    return "unknown";
  }
  if (off) return "off";
  let backend: string;
  try {
    backend = detectBackend(input.cwd);
  } catch {
    return "unknown";
  }
  if (backend === "none") return "none";
  if (!["seatbelt", "bwrap", "docker"].includes(backend)) return "unknown";
  if (!input.probe) return `${backend}:unprobed`;
  try {
    const policy = createPolicy({ mode: "workspace-write", workspaceRoot: input.cwd });
    disposeSandboxPolicy(policy);
    return `${backend}:opened`;
  } catch {
    return `${backend}:refused`;
  }
}

export interface FreshnessInputs {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly env: NodeJS.Dict<string>;
  readonly config: () => unknown;
  /** The key a verifier holds; an ephemeral one verifies only what it signed. */
  readonly key: InstallationKey;
  /** The fence attestation now; attestFence when absent. */
  readonly fence?: (probe: boolean) => string;
  /** The Dokkabi home a session-based report's session is re-read from. */
  readonly home?: string;
}

/** What this machine has now for a report's profile, or undefined when some
 * part of it cannot be observed. */
export function observeReadinessIdentity(
  report: Pick<DoctorReport, "profile" | "probe" | "session" | "inventorySource">,
  inputs: FreshnessInputs,
): ObservedIdentity | undefined {
  if (!isExecutionProfileName(report.profile)) return undefined;
  let inventoryGeneration: string | undefined;
  if (report.inventorySource === "static") {
    const manifest = resolvePluginManifest(effectiveManifestPath(profileManifestPath(inputs.repoRoot, report.profile, inputs.env), inputs.env));
    inventoryGeneration = `static:${manifest.digest}`;
  } else {
    if (report.session?.id === undefined) return undefined;
    const read = readSessionForDoctor(report.session.id, inputs.home);
    if (!read.ok || read.snapshot === undefined) return undefined;
    inventoryGeneration = `${read.identity.live ? "live" : "recorded"}:${read.snapshot.digest}`;
  }
  return {
    profile: report.profile,
    configDigest: configDigest(inputs.config(), inputs.env, inputs.key.key),
    inventoryGeneration,
    fenceAttestation: (inputs.fence ?? ((probe: boolean) => attestFence({ cwd: inputs.cwd, probe })))(report.probe),
    keyId: inputs.key.keyId,
  };
}

/** The one decision: is this report current readiness here and now? */
export function freshnessNow(
  report: DoctorReport,
  inputs: FreshnessInputs,
): { readonly current: boolean; readonly reasons: readonly StaleReason[] } {
  let observed: ObservedIdentity | undefined;
  try {
    observed = observeReadinessIdentity(report, inputs);
  } catch {
    observed = undefined;
  }
  return reportFreshness(report, observed, reportAuthentic(report, inputs.key));
}
