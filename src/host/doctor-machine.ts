import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { APPROVAL_TIMEOUT_ENV, approvalTimeoutMs } from "./approval-relay.ts";
import { configPath, readConfig, resolveLlmSelection } from "./config.ts";
import { isAbsolute, relative } from "node:path";
import { action, digestOf, ref, type CapabilityReadiness } from "./doctor-report.ts";
import { piAuthPath } from "./paths.ts";
import { PERMISSION_MODE_ENV, resolvePermissionMode } from "./permissions.ts";
import {
  createPolicy,
  detectBackend,
  disposeSandboxPolicy,
  networkDenied,
  sandboxDisabled,
  spawnFencedAsync,
  type SandboxPolicy,
} from "./sandbox.ts";
import { SANDBOX_TOOLCHAIN_ENV, toolchainRoots } from "./sandbox-toolchain.ts";
import { readOperatorSshAliases } from "./ssh-aliases.ts";
import { BUILTIN_ROUTE_SPECS } from "../plugins/llm-route-catalog.ts";
import { OPERATOR_ENDPOINTS } from "../plugins/operator-endpoints.ts";
import { assertKnownLlmRoute } from "../plugins/llm-routes.ts";

/**
 * The machine checks `dokkabi doctor` has always made — sandbox backend and
 * fence, the tools the fenced shell can see, permissions, model route, ssh
 * aliases, config — as one probe with two readers: the legacy text (kept
 * byte-for-byte) and the readiness rows of the `host` and `model`
 * contributors. One implementation, so the two can never drift.
 */

/** The fenced toolchain probe script (unchanged since the first doctor). */
export const TOOLCHAIN_PROBE_SCRIPT = [
  "for t in python3 python git gh node npm bun uv rg jq; do",
  '  if p=$(command -v "$t" 2>/dev/null); then printf "%s=%s\\n" "$t" "$p"; else printf "%s=missing\\n" "$t"; fi;',
  "done",
].join(" ");
export const TOOLCHAIN_PROBE_TIMEOUT_MS = 20_000;

export type SandboxFacts =
  | { readonly state: "off" }
  | { readonly state: "none" }
  | { readonly state: "unprobed"; readonly backend: string }
  | { readonly state: "probed"; readonly backend: string; readonly policyRoots: number; readonly entries: readonly string[]; readonly timedOut?: true }
  | { readonly state: "failed"; readonly backend: string; readonly policyRoots?: number; readonly message: string; readonly failure: "policy" | "spawn" | "timeout" | "aborted" };

export interface MachineFacts {
  readonly platform: NodeJS.Platform;
  readonly sandbox: SandboxFacts;
  readonly roots: number;
  readonly network: string;
  readonly permissions: { readonly mode: string; readonly source: string };
  readonly relayTimeoutSeconds: number;
  readonly selection: { readonly route: string; readonly model?: string };
  readonly aliases: readonly string[];
  readonly scp: boolean;
  readonly rsync: boolean;
  readonly configPath: string;
  readonly configExists: boolean;
  readonly toolchainSwitch: string;
  /** The fence's own verdict on DOKKABI_SANDBOX_NET (networkDenied). */
  readonly networkVerdict: "allow" | "deny" | "invalid";
  /** Where located tools may live, for classifying a probed path (never reported). */
  readonly places: { readonly home: string; readonly workspace: string; readonly toolchainRoots: readonly string[] };
}

/**
 * Observe the machine. With `probe` the fence is opened and the toolchain
 * script runs inside it (the only process this starts); without it nothing is
 * spawned. The policy's temporary files are released before returning.
 */
export async function probeMachine(input: {
  readonly cwd: string;
  readonly probe: boolean;
  readonly signal?: AbortSignal;
}): Promise<MachineFacts> {
  const cwd = input.cwd;
  const off = sandboxDisabled();
  let sandbox: SandboxFacts;
  if (off) {
    sandbox = { state: "off" };
  } else {
    const backend = detectBackend(cwd);
    if (backend === "none") {
      sandbox = { state: "none" };
    } else if (!input.probe) {
      sandbox = { state: "unprobed", backend };
    } else {
      let policy: SandboxPolicy | undefined;
      try {
        policy = createPolicy({ mode: "workspace-write", workspaceRoot: cwd });
        const policyRoots = policy.toolchainRoots.length;
        try {
          const probe = await spawnFencedAsync(policy, TOOLCHAIN_PROBE_SCRIPT, {
            timeoutMs: TOOLCHAIN_PROBE_TIMEOUT_MS,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (probe.aborted) throw Object.assign(new Error("toolchain probe cancelled"), { failure: "aborted" });
          sandbox = { state: "probed", backend, policyRoots, entries: probe.stdout.trim().split("\n").filter(Boolean),
            ...(probe.timedOut === true ? { timedOut: true } : {}) };
        } catch (error) {
          const failure = (error as { failure?: unknown }).failure === "aborted" ? "aborted" : "spawn";
          sandbox = { state: "failed", backend, policyRoots, message: error instanceof Error ? error.message : String(error), failure };
        }
      } catch (error) {
        sandbox = { state: "failed", backend, message: error instanceof Error ? error.message : String(error), failure: "policy" };
      } finally {
        if (policy) disposeSandboxPolicy(policy);
      }
    }
  }
  const rootPaths = off ? [] : toolchainRoots({ workspaceRoot: cwd });
  const roots = rootPaths.length;
  let networkVerdict: MachineFacts["networkVerdict"];
  try {
    networkVerdict = networkDenied("workspace-write") ? "deny" : "allow";
  } catch {
    networkVerdict = "invalid";
  }
  const permissions = resolvePermissionMode({
    env: process.env[PERMISSION_MODE_ENV],
    configured: readConfig().permissions?.default_mode,
  });
  const selection = resolveLlmSelection();
  const config = configPath();
  return {
    platform: process.platform,
    sandbox,
    roots,
    network: process.env.DOKKABI_SANDBOX_NET?.trim() || "allow",
    permissions: { mode: permissions.mode, source: permissions.source },
    relayTimeoutSeconds: approvalTimeoutMs() / 1000,
    selection: { route: selection.route, ...(selection.model !== undefined ? { model: selection.model } : {}) },
    aliases: readOperatorSshAliases(process.env),
    scp: existsSync("/usr/bin/scp"),
    rsync: existsSync("/usr/bin/rsync"),
    configPath: config,
    configExists: existsSync(config),
    toolchainSwitch: process.env[SANDBOX_TOOLCHAIN_ENV] ?? "allow",
    networkVerdict,
    places: { home: homedir(), workspace: cwd, toolchainRoots: rootPaths },
  };
}

/** The legacy `dokkabi doctor` text, exactly as it has always read. */
export function renderLegacyDoctor(facts: MachineFacts): string {
  const lines: string[] = [];
  const fixes: string[] = [];
  const row = (label: string, text: string): void => {
    lines.push(`${label.padEnd(12)}${text}`);
  };
  const sandbox = facts.sandbox;
  if (sandbox.state === "off") {
    row("sandbox", "off  (operator switch: fence disabled, commands run with your own environment)");
  } else if (sandbox.state === "none") {
    row("sandbox", "none  (no backend on this host; sessions open unfenced and say so)");
    fixes.push(facts.platform === "linux"
      ? "install bubblewrap (apt/dnf: bubblewrap) to restore the fence, or set DOKKABI_SANDBOX=off to stop the warning"
      : "this platform has no supported backend; set DOKKABI_SANDBOX=off to stop the warning");
  } else if (sandbox.state === "probed") {
    row("sandbox", `${sandbox.backend}  probe=full  toolchain_roots=${sandbox.policyRoots}`);
    const seen = sandbox.entries;
    const missing = seen.filter((entry) => entry.endsWith("=missing")).map((entry) => entry.split("=")[0]);
    for (const entry of seen) {
      const [tool, path] = entry.split("=");
      row(tool === seen[0]?.split("=")[0] ? "toolchain" : "", `${(tool ?? "").padEnd(8)} ${path}`);
    }
    if (missing.length > 0) {
      fixes.push(`not visible inside the fence: ${missing.join(", ")}. If they live under a directory the fence does not list, `
        + `add it to the toolchain roots (sandbox-toolchain.ts) or run with --sandbox off; ${SANDBOX_TOOLCHAIN_ENV}=${facts.toolchainSwitch}`);
    }
  } else if (sandbox.state === "failed") {
    if (sandbox.policyRoots !== undefined) {
      row("sandbox", `${sandbox.backend}  probe=full  toolchain_roots=${sandbox.policyRoots}`);
    }
    row("sandbox", `${sandbox.backend}  FAILED: ${sandbox.message}`);
    fixes.push("the fence could not open; run with --sandbox off, or fix the reason above and try again");
  } else {
    // The legacy command always probes; an unprobed fact never reaches it.
    row("sandbox", `${sandbox.backend}  probe=skipped`);
  }
  if (facts.roots > 0) row("roots", `${facts.roots} toolchain roots visible read-only (Homebrew, Nix, conda, and package caches under HOME)`);
  row("network", `${facts.network}  (DOKKABI_SANDBOX_NET)`);
  row("permissions", `${facts.permissions.mode}  source=${facts.permissions.source}  relay_timeout=${facts.relayTimeoutSeconds}s (${APPROVAL_TIMEOUT_ENV})`);
  if (facts.permissions.mode !== "bypass") { // auto still asks for approvals
    fixes.push("unattended runs will park each ssh/github/mcp approval for `dokkabi approve`; to skip approvals set "
      + `${PERMISSION_MODE_ENV}=bypass or permissions.default_mode in the config file`);
  }
  row("model", `${facts.selection.route} / ${facts.selection.model}  (credentials: run dokkabi status)`);
  row("ssh", `aliases=${facts.aliases.length > 0 ? facts.aliases.join(",") : "(none)"}  scp=${facts.scp ? "ok" : "missing"}  rsync=${facts.rsync ? "ok" : "missing"}`);
  if (facts.aliases.length === 0) {
    fixes.push("no Host alias in ~/.ssh/config; add one, or in chat ask for `ssh op=enroll` with the address (recorded as the alias only)");
  }
  row("config", facts.configExists
    ? `${facts.configPath.replace(homedir(), "~")}  ok`
    : `${facts.configPath.replace(homedir(), "~")}  (absent; defaults apply)`);
  return `${lines.join("\n")}\n${fixes.length === 0 ? "FIX         (none)\n" : `FIX\n${fixes.map((fix) => `  - ${fix}`).join("\n")}\n`}`;
}

type Row = Omit<CapabilityReadiness, "contributor">;

/** Descriptor digests are over code-defined descriptors only — never over a
 * value from the operator's configuration or environment (D3). */
function descriptor(capabilityId: string, extra: unknown = null): string {
  return digestOf({ capabilityId, extra });
}

function within(parent: string, child: string): boolean {
  if (parent === "") return false;
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Where a probed tool lives, as a class — its path is never reported. */
function locationOf(path: string, places: MachineFacts["places"]): string {
  if (places.toolchainRoots.some((root) => within(root, path))) return "toolchain_root";
  if (within(places.workspace, path)) return "workspace";
  if (within(places.home, path)) return "home";
  if (["/usr/", "/bin/", "/sbin/", "/opt/homebrew/", "/usr/local/"].some((prefix) => path.startsWith(prefix))) return "system";
  return "other";
}

/**
 * The readiness rows of the machine facts (`host:*`). The sandbox fence is
 * required at local-probe evidence unless the operator switched it off, in
 * which case it is disabled and optional; the network switch is judged by the
 * fence's own function and is required (an invalid value makes the fence
 * refuse every session); everything else is optional. Every word is from the
 * report vocabulary.
 */
export function hostReadiness(facts: MachineFacts, profile: string): Row[] {
  const rows: Row[] = [];
  const base = (capabilityId: string, extra: unknown = null): Pick<Row, "capabilityId" | "profile" | "descriptorDigest"> => ({
    capabilityId,
    profile,
    descriptorDigest: descriptor(capabilityId, extra),
  });
  const sandbox = facts.sandbox;
  const fence = base("host:sandbox");
  const platform = ref("platform", facts.platform);
  if (sandbox.state === "off") {
    rows.push({ ...fence, status: "disabled", evidenceLevel: "configuration", reasonCode: "operator_switch_off",
      evidenceRefs: [ref("switch", "DOKKABI_SANDBOX")], required: false });
  } else if (sandbox.state === "none") {
    const linux = facts.platform === "linux";
    rows.push({ ...fence, status: linux ? "missing" : "unsupported", evidenceLevel: "configuration",
      reasonCode: linux ? "backend_not_installed" : "platform_has_no_backend",
      evidenceRefs: [platform], required: true, requiredEvidence: "local-probe",
      suggestedAction: linux ? action("install_bubblewrap") : action("no_platform_backend") });
  } else if (sandbox.state === "unprobed") {
    rows.push({ ...fence, status: "ready", evidenceLevel: "configuration", reasonCode: "backend_present_not_probed",
      evidenceRefs: [ref("backend", sandbox.backend), platform], required: true, requiredEvidence: "local-probe",
      suggestedAction: action("probe_fence") });
  } else if (sandbox.state === "probed" && sandbox.timedOut === true) {
    rows.push({ ...fence, status: "degraded", evidenceLevel: "local-probe", reasonCode: "fence_probe_failed",
      evidenceRefs: [ref("backend", sandbox.backend), ref("failure", "timeout")], required: true, requiredEvidence: "local-probe",
      suggestedAction: action("fix_fence") });
  } else if (sandbox.state === "probed") {
    rows.push({ ...fence, status: "ready", evidenceLevel: "local-probe", reasonCode: "fence_opened",
      evidenceRefs: [ref("backend", sandbox.backend), ref("toolchain_roots", sandbox.policyRoots)], required: true, requiredEvidence: "local-probe" });
  } else {
    rows.push({ ...fence, status: "degraded", evidenceLevel: "local-probe", reasonCode: "fence_probe_failed",
      evidenceRefs: [ref("backend", sandbox.backend), ref("failure", sandbox.failure)], required: true, requiredEvidence: "local-probe",
      suggestedAction: action("fix_fence") });
  }
  if (sandbox.state === "probed") {
    const seen = new Set<string>();
    for (const entry of sandbox.entries) {
      const index = entry.indexOf("=");
      const tool = index > 0 ? entry.slice(0, index) : entry;
      const path = index > 0 ? entry.slice(index + 1) : "";
      // Only the probe's own tool names become capabilities; anything else the
      // fenced shell printed is not a row.
      if (!(PROBE_TOOL_NAMES as readonly string[]).includes(tool) || seen.has(tool)) continue;
      seen.add(tool);
      const visible = path !== "missing" && path !== "";
      rows.push({ ...base(`host:toolchain:${tool}`, TOOLCHAIN_PROBE_SCRIPT),
        status: visible ? "ready" : "missing", evidenceLevel: "local-probe",
        reasonCode: visible ? "visible_in_fence" : "not_visible_in_fence",
        evidenceRefs: visible ? [ref("location", locationOf(path, facts.places))] : [], required: false,
        ...(visible ? {} : { suggestedAction: action("extend_toolchain_roots", tool) }) });
    }
  } else if (sandbox.state === "unprobed") {
    rows.push({ ...base("host:toolchain", TOOLCHAIN_PROBE_SCRIPT), status: "unknown", evidenceLevel: "configuration",
      reasonCode: "not_probed", evidenceRefs: [], required: false });
  }
  const network = base("host:network");
  if (facts.networkVerdict === "invalid") {
    rows.push({ ...network, status: "degraded", evidenceLevel: "configuration", reasonCode: "network_switch_invalid",
      evidenceRefs: [ref("switch", "DOKKABI_SANDBOX_NET")], required: true, suggestedAction: action("fix_network_switch") });
  } else {
    rows.push({ ...network, status: "ready", evidenceLevel: "configuration",
      reasonCode: facts.networkVerdict === "deny" ? "network_denied" : "network_allowed",
      evidenceRefs: [ref("switch", "DOKKABI_SANDBOX_NET")], required: true });
  }
  const bypass = facts.permissions.mode === "bypass";
  rows.push({ ...base("host:permissions"), status: "ready", evidenceLevel: "configuration",
    reasonCode: bypass ? "mode_bypass" : "mode_ask",
    evidenceRefs: [ref("permission_source", facts.permissions.source), ref("relay_timeout_s", Math.round(facts.relayTimeoutSeconds))], required: false,
    ...(bypass ? {} : { suggestedAction: action("permission_bypass") }) });
  rows.push({ ...base("host:ssh"), status: facts.aliases.length > 0 ? "ready" : "missing",
    evidenceLevel: "configuration", reasonCode: facts.aliases.length > 0 ? "aliases_configured" : "no_ssh_alias",
    evidenceRefs: [ref("aliases", facts.aliases.length), ref("scp", facts.scp ? "ok" : "missing"), ref("rsync", facts.rsync ? "ok" : "missing")],
    required: false,
    ...(facts.aliases.length === 0 ? { suggestedAction: action("add_ssh_alias") } : {}) });
  rows.push({ ...base("host:config"), status: "ready", evidenceLevel: "configuration",
    reasonCode: facts.configExists ? "config_present" : "config_absent_defaults_apply",
    evidenceRefs: [ref("config", facts.configExists ? "present" : "absent")], required: false });
  return rows;
}

const PROBE_TOOL_NAMES = ["python3", "python", "git", "gh", "node", "npm", "bun", "uv", "rg", "jq"] as const;

/** Every route name the runtime accepts, from its own catalog. */
function knownRoute(route: string): boolean {
  try {
    assertKnownLlmRoute(route);
    return true;
  } catch {
    return false;
  }
}

/** The route/model rows. A known route and a stored credential are
 * configuration facts: v1 never makes a provider request, so authentication
 * is at best unknown — never ready. A route name outside the runtime's own
 * catalog is never reported, only `route=custom`. */
export function modelReadiness(
  selection: { readonly route: string; readonly model?: string },
  profile: string,
): Row[] {
  const known = knownRoute(selection.route);
  const routeRef = ref("route", known && /^[a-z][a-z0-9-]{0,31}$/u.test(selection.route) ? selection.route : "custom");
  const rows: Row[] = [];
  rows.push({
    capabilityId: "model:selection",
    profile,
    descriptorDigest: descriptor("model:selection"),
    status: known ? "ready" : "missing",
    evidenceLevel: "configuration",
    reasonCode: known ? "route_known_model_selected" : "route_unknown",
    evidenceRefs: [routeRef, ref("model_id", "unchecked")],
    required: true,
    ...(known ? {} : { suggestedAction: action("choose_known_route") }),
  });
  const spec = known ? [...BUILTIN_ROUTE_SPECS, ...OPERATOR_ENDPOINTS].find((candidate) => candidate.name === selection.route) : undefined;
  const stored = spec ? storedCredentialPresent(spec.providerId) : "unreadable";
  rows.push({
    capabilityId: "model:authentication",
    profile,
    descriptorDigest: descriptor("model:authentication"),
    status: "unknown",
    evidenceLevel: "configuration",
    reasonCode: stored === "present"
      ? "credential_present_request_unverified"
      : stored === "absent" ? "no_stored_credential_request_unverified" : "credential_store_unreadable",
    evidenceRefs: [routeRef, ref("provider_request", "none")],
    required: false,
    ...(stored !== "present" && known && routeRef !== "route=custom" ? { suggestedAction: action("login_route", selection.route) } : {}),
  });
  return rows;
}

/** Whether the shared credential store names this provider. Reads the store's
 * keys only — never a value — and never touches its mode or content (the
 * store's own reader chmods; a diagnosis must not). */
function storedCredentialPresent(providerId: string): "present" | "absent" | "unreadable" {
  const path = piAuthPath();
  if (!existsSync(path)) return "absent";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
    return Object.hasOwn(parsed, providerId) ? "present" : "absent";
  } catch {
    return "unreadable";
  }
}
