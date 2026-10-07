import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import {
  collectStrings,
  containsPrivateInfrastructure,
  containsSecret,
  normalizeHomePaths,
  redactText,
} from "./redact.ts";
import type { EventRecord } from "./schema.ts";

/**
 * The versioned capability readiness report (#230, TS-32). One report feeds
 * every surface — `dokkabi doctor` text, `--json`, the persisted
 * `doctor/report` row and the dashboard's ALERTS — so the surfaces cannot
 * disagree about what is ready.
 *
 * `ready` is always scoped to the evidence level beside it:
 * - `configuration`: the operator's configuration and the profile's manifest
 *   say so. Nothing ran.
 * - `registered`: a live runtime's own inventory (its EventLog plugin rows)
 *   shows the provider registered.
 * - `local-probe`: an approved local probe (the fenced toolchain probe) ran
 *   on this machine and observed it.
 * There is deliberately no level for "authenticated" or "works": v1 never
 * makes a provider request, so no report can claim one succeeded.
 *
 * Secrets cannot enter by construction (#230 round 2, D3): every free-text
 * field is drawn from a closed vocabulary — reason codes, typed references
 * (`kind=value` with a validator per kind) and action ids with typed
 * arguments. Nothing in a report is a substring of a configuration value; the
 * pattern sanitiser below is defence in depth, not the mechanism.
 */

export const READINESS_STATUSES = ["ready", "disabled", "missing", "unsupported", "degraded", "unknown"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const READINESS_EVIDENCE_LEVELS = ["configuration", "registered", "local-probe"] as const;
export type ReadinessEvidenceLevel = (typeof READINESS_EVIDENCE_LEVELS)[number];

export function evidenceRank(level: ReadinessEvidenceLevel): number {
  return READINESS_EVIDENCE_LEVELS.indexOf(level);
}

export const DOCTOR_REPORT_VERSION = 1;
export const DOCTOR_REPORT_EVENT = "doctor/report";

/** Bounds applied where rows enter a report (D5). */
export const MAX_REPORT_ROWS = 400;
export const MAX_CONTRIBUTOR_ROWS = 200;
export const MAX_ROW_REFS = 8;

// ---------------------------------------------------------------------------
// Closed vocabulary
// ---------------------------------------------------------------------------

export const REASON_CODES = [
  // profile manifest (static descriptors)
  "listed_in_profile_manifest", "declared_by_profile_package",
  // profile admissibility (the runtime's own refusals)
  "boot_admissible", "boot_refused_manifest", "boot_refused_import", "boot_refused_claims", "boot_refused_activation",
  "boot_refused_registration_precondition", "boot_not_preparable",
  // the boot prepare phase's verdict per plugin
  "activates_at_boot", "activation_refused", "not_preparable",
  // live or recorded inventory
  "registered_by_runtime", "not_in_inventory", "inventory_digest_differs", "skipped_not_configured",
  "skipped_invalid_configuration", "skipped_unavailable", "skipped_unclassified", "unloaded_at_runtime",
  "pending_dependency", "transition_failed", "inventory_live", "inventory_recorded_not_live",
  "inventory_belongs_to_other_profile", "inventory_overflow", "session_log_unreadable", "session_log_too_large",
  "session_has_no_inventory",
  // package capabilities
  "provider_not_in_profile", "provider_registered", "provider_skipped_not_configured",
  "provider_skipped_invalid_configuration", "provider_skipped_unavailable", "provider_skipped_unclassified",
  "provider_unloaded_at_runtime", "provider_transition_failed", "provider_pending", "provider_not_in_inventory",
  "provider_activates_at_boot", "provider_activation_refused", "provider_not_preparable", "descriptor_unreadable",
  // host
  "operator_switch_off", "backend_not_installed", "platform_has_no_backend", "backend_present_not_probed",
  "fence_opened", "fence_probe_failed", "visible_in_fence", "not_visible_in_fence", "not_probed",
  "network_allowed", "network_denied", "network_switch_invalid", "mode_ask", "mode_bypass",
  "aliases_configured", "no_ssh_alias", "config_present", "config_absent_defaults_apply",
  // model
  "route_known_model_selected", "route_unknown", "credential_present_request_unverified",
  "no_stored_credential_request_unverified", "credential_store_unreadable",
  // runner
  "contributor_failed", "contributor_timed_out", "contributor_mutated_protected_state",
  "evidence_above_contributor_scope", "row_refused", "rows_truncated", "protected_state_changed",
  "contributor_empty", "capability_not_reported",
  // report identity
  "key_unavailable",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
const REASON_SET = new Set<string>(REASON_CODES);

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && REASON_SET.has(value);
}

export const SKIP_CLASSES = ["not_configured", "invalid_configuration", "unavailable", "unclassified"] as const;
export type SkipClass = (typeof SKIP_CLASSES)[number];

export const PROFILE_NAMES = ["default", "ledger", "plan-v2", "model-loop"] as const;
const PLATFORMS = ["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"];
export const PROBE_TOOLS = ["python3", "python", "git", "gh", "node", "npm", "bun", "uv", "rg", "jq"] as const;

const IDENT = /^[a-z][a-z0-9_.-]{0,63}$/u;
const NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/u;
const HEX12 = /^[a-f0-9]{12}$/u;
const INT = /^(?:0|[1-9][0-9]{0,8})$/u;
const ROUTE = /^[a-z][a-z0-9-]{0,31}$/u;

const oneOf = (values: readonly string[]) => (value: string) => values.includes(value);

/** Every reference kind a row may carry, and the only values it accepts. */
const REF_KINDS: Readonly<Record<string, (value: string) => boolean>> = {
  kind: oneOf(["module", "package"]),
  plugin: (value) => IDENT.test(value),
  provider: (value) => IDENT.test(value),
  stage: oneOf(["manifest", "import", "claims", "activation", "preflight"]),
  key_problem: oneOf(["home_unusable", "inside_workspace", "dir_not_private", "missing", "not_regular", "not_private", "wrong_length", "unreadable", "create_failed", "exposed_to_session", "config_untrusted", "not_adopted"]),
  config_problem: oneOf(["config_link", "config_not_regular", "config_not_owned", "config_writable_by_others",
    "config_directory_writable_by_others", "config_inside_workspace", "config_exposed_to_session"]),
  skip: oneOf(SKIP_CLASSES),
  inventory_seq: (value) => INT.test(value),
  inventory: oneOf(["live", "recorded", "static", "none"]),
  session_manifest: (value) => HEX12.test(value),
  owns: (value) => value.split(",").every((part) => NAMESPACE.test(part)),
  backend: oneOf(["seatbelt", "bwrap", "docker", "none"]),
  platform: oneOf(PLATFORMS),
  toolchain_roots: (value) => INT.test(value),
  location: oneOf(["system", "toolchain_root", "home", "workspace", "other"]),
  failure: oneOf(["policy", "spawn", "timeout", "aborted"]),
  switch: (value) => /^DOKKABI_[A-Z_]{1,40}$/u.test(value),
  relay_timeout_s: (value) => INT.test(value),
  permission_source: oneOf(["default", "cli", "env", "config", "tui"]),
  aliases: (value) => INT.test(value),
  scp: oneOf(["ok", "missing"]),
  rsync: oneOf(["ok", "missing"]),
  config: oneOf(["present", "absent"]),
  route: (value) => value === "custom" || ROUTE.test(value),
  model_id: oneOf(["unchecked"]),
  provider_request: oneOf(["none"]),
  registration: oneOf(["not_observed"]),
  refused: (value) => IDENT.test(value),
  rows: (value) => INT.test(value),
};

/** Build a typed reference; throws on a value outside its kind's grammar. */
export function ref(kind: string, value: string | number): string {
  const text = String(value);
  const valid = Object.hasOwn(REF_KINDS, kind) ? REF_KINDS[kind] : undefined;
  if (!valid || !valid(text)) throw new Error(`doctor reference ${kind} refuses its value`);
  return `${kind}=${text}`;
}

export function isValidRef(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 128) return false;
  const index = value.indexOf("=");
  if (index <= 0) return false;
  const kind = value.slice(0, index);
  const valid = Object.hasOwn(REF_KINDS, kind) ? REF_KINDS[kind] : undefined;
  return valid !== undefined && valid(value.slice(index + 1));
}

const isProfile = oneOf(PROFILE_NAMES);
const isTool = oneOf(PROBE_TOOLS);

interface ActionTemplate {
  /** Validators for the fixed arguments, then one for every further argument. */
  readonly args: readonly ((value: string) => boolean)[];
  readonly rest?: (value: string) => boolean;
  render(args: readonly string[]): string;
}

/** Every action a row may suggest, with typed arguments and fixed text. */
const ACTIONS = {
  install_bubblewrap: { args: [], render: () => "install bubblewrap (apt/dnf: bubblewrap) to restore the fence, or set DOKKABI_SANDBOX=off to run unfenced on purpose" },
  no_platform_backend: { args: [], render: () => "this platform has no supported backend; set DOKKABI_SANDBOX=off to run unfenced on purpose" },
  probe_fence: { args: [], render: () => "run dokkabi doctor without --no-probe to open the fence once" },
  fix_fence: { args: [], render: () => "the fence could not open; run the legacy dokkabi doctor to see why, or set DOKKABI_SANDBOX=off" },
  extend_toolchain_roots: { args: [isTool], render: ([tool]) => `if ${tool} is installed under a directory the fence does not list, add it to the toolchain roots or run with DOKKABI_SANDBOX=off` },
  permission_bypass: { args: [], render: () => "unattended runs park each approval for dokkabi approve; set DOKKABI_PERMISSION_MODE=bypass or permissions.default_mode to skip approvals" },
  add_ssh_alias: { args: [], render: () => "add a Host alias to ~/.ssh/config, or in chat ask for ssh op=enroll with the address" },
  fix_network_switch: { args: [], render: () => "set DOKKABI_SANDBOX_NET to allow or deny; the fence refuses any other value" },
  choose_known_route: { args: [], render: () => "choose a known route with dokkabi model --route NAME" },
  login_route: { args: [(value) => ROUTE.test(value)], render: ([route]) => `dokkabi login ${route}` },
  use_profile_mounting: {
    args: [isProfile, (value) => IDENT.test(value)], rest: isProfile,
    render: ([profile, provider, ...others]) => `profile ${profile} does not mount ${provider}; profiles that do: ${others.join(", ")}`,
  },
  no_profile_mounts: { args: [isProfile, (value) => IDENT.test(value)], render: ([profile, provider]) => `profile ${profile} does not mount ${provider}, and no selectable profile does` },
  knowledge_init: { args: [], render: () => "dokkabi knowledge init --profile NAME --root PATH" },
  fix_plugin_configuration: { args: [(value) => IDENT.test(value)], render: ([plugin]) => `the configuration ${plugin} reads is invalid; it refuses to activate, and dokkabi work refuses to boot, until it is fixed` },
  reset_doctor_key: { args: [], render: () => "the doctor key is unusable; keep it outside every session workspace (doctor.key_directory in the config, a private 0700 directory), then run dokkabi doctor --rotate-key" },
  pass_session_profile: { args: [], render: () => "pass the --profile the session was booted with, or omit --profile to infer it" },
  session_not_live: { args: [], render: () => "the session is not running; rerun against a running session for current registration" },
  fix_boot: { args: [], render: () => "dokkabi work refuses to boot this profile in this environment; fix what the refused plugin names, or choose another profile" },
} as const satisfies Record<string, ActionTemplate>;

export type ActionId = keyof typeof ACTIONS;
export interface SuggestedAction {
  readonly id: ActionId;
  readonly args: readonly string[];
}

export function isValidAction(value: unknown): value is SuggestedAction {
  if (value === null || typeof value !== "object") return false;
  const { id, args } = value as { id?: unknown; args?: unknown };
  if (typeof id !== "string" || !Object.hasOwn(ACTIONS, id) || !Array.isArray(args) || args.length > 8) return false;
  const template: ActionTemplate = ACTIONS[id as ActionId];
  if (args.length < template.args.length) return false;
  return args.every((arg, index) => typeof arg === "string" && (index < template.args.length
    ? template.args[index]!(arg)
    : template.rest !== undefined && template.rest(arg)));
}

export function action(id: ActionId, ...args: string[]): SuggestedAction {
  const built = { id, args };
  if (!isValidAction(built)) throw new Error(`doctor action ${id} refuses its arguments`);
  return built;
}

export function renderAction(value: SuggestedAction): string {
  return (ACTIONS[value.id] as ActionTemplate).render(value.args);
}

// ---------------------------------------------------------------------------
// Types and schema
// ---------------------------------------------------------------------------

export interface CapabilityReadiness {
  readonly capabilityId: string;
  readonly profile: string;
  /** Digest of the code-defined descriptor this row was judged against
   * (manifest entry, package descriptor, probe script) — never of a value
   * from the operator's configuration. */
  readonly descriptorDigest: string;
  readonly status: ReadinessStatus;
  readonly evidenceLevel: ReadinessEvidenceLevel;
  readonly reasonCode: ReasonCode;
  readonly evidenceRefs: readonly string[];
  readonly required: boolean;
  /** The evidence a required capability must be ready at; configuration when absent. */
  readonly requiredEvidence?: ReadinessEvidenceLevel;
  readonly suggestedAction?: SuggestedAction;
  /** The contributor that owns this row. Filled by the runner, never trusted from a contributor. */
  readonly contributor: string;
}

export type ContributorOutcomeKind = "ok" | "failed" | "timed_out" | "refused";

export interface ContributorOutcome {
  readonly id: string;
  readonly outcome: ContributorOutcomeKind;
  readonly reasonCode?: ReasonCode;
  readonly elapsedMs: number;
}

export interface SessionIdentity {
  /** The session directory name, when it is a plain id. */
  readonly id?: string;
  /** Digest over the pinned log's device, inode, size and last record hash. */
  readonly log: string;
  readonly lastSeq: number;
  readonly live: boolean;
}

export interface DoctorReport {
  readonly version: 1;
  readonly profile: string;
  /** Keyed digest of the configuration's structure and the diagnosed
   * switches (doctor-identity.ts): not invertible without this installation's key. */
  readonly configDigest: string;
  readonly manifestDigest: string;
  /** `static:<manifest digest>` for descriptors read from the manifest;
   * `live:`/`recorded:` over a session inventory. */
  readonly inventoryGeneration?: string;
  readonly inventorySource: "static" | "live" | "recorded";
  readonly session?: SessionIdentity;
  readonly probe: boolean;
  /** The fence as `attestFence` observed it (doctor-freshness.ts). */
  readonly fenceAttestation: string;
  readonly capabilities: readonly CapabilityReadiness[];
  readonly contributors: readonly ContributorOutcome[];
  readonly partial: boolean;
  readonly truncated: boolean;
  /** HMAC over the canonical report without this field, under the key named. */
  readonly authentication: { readonly keyId: string; readonly mac: string };
}

export const FENCE_ATTESTATION = /^(?:off|none|unknown|(?:seatbelt|bwrap|docker):(?:unprobed|opened|refused))$/u;

const CAPABILITY_ID = /^[a-z][a-z0-9-]{0,31}(?::[a-z0-9][a-z0-9._-]{0,63}){0,3}$/u;
const CONTRIBUTOR_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isCapabilityId(value: unknown): value is string {
  return typeof value === "string" && CAPABILITY_ID.test(value);
}

export function isSessionIdReference(value: string): boolean {
  return SESSION_ID.test(value) && reportLeakClasses(value).length === 0;
}

const statusSchema = z.enum(READINESS_STATUSES);
const levelSchema = z.enum(READINESS_EVIDENCE_LEVELS);
const hexDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const reasonSchema = z.enum(REASON_CODES);

const capabilitySchema = z.object({
  capabilityId: z.string().regex(CAPABILITY_ID),
  profile: z.enum(PROFILE_NAMES),
  descriptorDigest: hexDigest,
  status: statusSchema,
  evidenceLevel: levelSchema,
  reasonCode: reasonSchema,
  evidenceRefs: z.array(z.string().refine(isValidRef)).max(MAX_ROW_REFS),
  required: z.boolean(),
  requiredEvidence: levelSchema.optional(),
  suggestedAction: z.object({ id: z.string(), args: z.array(z.string()).max(8) }).strict().refine(isValidAction).optional(),
  contributor: z.string().regex(CONTRIBUTOR_ID),
}).strict();

const reportSchema = z.object({
  version: z.literal(DOCTOR_REPORT_VERSION),
  profile: z.enum(PROFILE_NAMES),
  configDigest: hexDigest,
  manifestDigest: hexDigest,
  inventoryGeneration: z.string().regex(/^(?:static|live|recorded):[a-f0-9]{64}$/u).optional(),
  inventorySource: z.enum(["static", "live", "recorded"]),
  session: z.object({
    id: z.string().regex(SESSION_ID).refine((value) => reportLeakClasses(value).length === 0).optional(),
    log: hexDigest,
    lastSeq: z.number().int().nonnegative(),
    live: z.boolean(),
  }).strict().optional(),
  probe: z.boolean(),
  fenceAttestation: z.string().regex(FENCE_ATTESTATION),
  capabilities: z.array(capabilitySchema).max(MAX_REPORT_ROWS + 64),
  contributors: z.array(z.object({
    id: z.string().regex(CONTRIBUTOR_ID),
    outcome: z.enum(["ok", "failed", "timed_out", "refused"]),
    reasonCode: reasonSchema.optional(),
    elapsedMs: z.number().int().nonnegative(),
  }).strict()).max(64),
  partial: z.boolean(),
  truncated: z.boolean(),
  authentication: z.object({ keyId: z.string().regex(/^k:[a-f0-9]{16}$/u), mac: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict();

/** Fail-closed read of a persisted or received report. */
export function parseDoctorReport(value: unknown): DoctorReport {
  const parsed = reportSchema.parse(value) as DoctorReport;
  assertDoctorReportSecretFree(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Defence in depth
// ---------------------------------------------------------------------------

const URL_SHAPE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/giu;
const RAW_HEADER = /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-[a-z0-9-]*(?:key|token|secret|auth|signature)[a-z0-9-]*)\s*:\s*[^\s,;]+(?:[ \t]+[^\s,;]+)?/giu;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/gu;
/** A dotted host name with a private-looking or any multi-label suffix. */
const HOSTNAME = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|corp|intra|intranet|home|private|localdomain)\b/giu;
const WITHHELD = "[withheld]";

/** What a string in a report must never contain, by class. Empty means clean. */
export function reportLeakClasses(text: string): string[] {
  const classes: string[] = [];
  const plain = text.replace(CONTROL, "");
  URL_SHAPE.lastIndex = 0;
  if (URL_SHAPE.test(plain)) classes.push("endpoint");
  RAW_HEADER.lastIndex = 0;
  if (RAW_HEADER.test(plain)) classes.push("raw_header");
  HOSTNAME.lastIndex = 0;
  if (HOSTNAME.test(plain)) classes.push("private_hostname");
  if (containsSecret(plain)) classes.push("credential");
  if (containsPrivateInfrastructure(plain)) classes.push("private_endpoint");
  return classes;
}

/** Defence in depth only (D3): report fields are built from the closed
 * vocabulary above; this bounds and masks any other text that reaches a
 * surface (the legacy text is not a report and is not passed through it). */
export function sanitizeReportText(text: string): string {
  let out = normalizeHomePaths(String(text).replace(CONTROL, ""));
  URL_SHAPE.lastIndex = 0;
  out = out.replace(URL_SHAPE, "[endpoint withheld]");
  RAW_HEADER.lastIndex = 0;
  out = out.replace(RAW_HEADER, "[header withheld]");
  out = redactText(out);
  if (reportLeakClasses(out).length > 0) return WITHHELD;
  return out.length > 400 ? `${out.slice(0, 399)}…` : out;
}

/** Refuse a report that carries any leak class anywhere. The last gate before
 * a report is printed, persisted or rendered. */
export function assertDoctorReportSecretFree(report: DoctorReport): void {
  for (const text of collectStrings(report)) {
    const classes = reportLeakClasses(text);
    if (classes.length > 0) throw new Error(`doctor report refused: carries ${classes.join(", ")}`);
  }
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// Currency: a report is readiness only for the identity it was taken under
// ---------------------------------------------------------------------------

export type StaleReason =
  | "unauthenticated" | "version" | "profile" | "config" | "inventory" | "fence" | "key" | "unobservable" | "recorded";

/** What this machine has now, for a report's profile (doctor-freshness.ts). */
export interface ObservedIdentity {
  readonly profile: string;
  readonly configDigest: string;
  readonly inventoryGeneration?: string;
  readonly fenceAttestation: string;
  readonly keyId: string;
}

/**
 * Whether a report may be presented as current readiness (D5'): it must be
 * authentic (a valid HMAC under the installation key — digest equality alone
 * is never enough), and its profile, configuration digest, generation, fence
 * attestation and key id must equal what is observed now. A report over a
 * recorded (not running) inventory is never current. Pure: the CLI and the
 * dashboard both reach it through doctor-freshness.ts.
 */
export function reportFreshness(
  report: Pick<DoctorReport, "version" | "profile" | "configDigest" | "inventoryGeneration" | "inventorySource" | "fenceAttestation" | "authentication">,
  observed: ObservedIdentity | undefined,
  authentic: boolean,
): { readonly current: boolean; readonly reasons: readonly StaleReason[] } {
  const reasons: StaleReason[] = [];
  if (!authentic) reasons.push("unauthenticated");
  if (observed === undefined) {
    reasons.push("unobservable");
    return { current: false, reasons };
  }
  if (report.version !== DOCTOR_REPORT_VERSION) reasons.push("version");
  if (report.profile !== observed.profile) reasons.push("profile");
  if (report.configDigest !== observed.configDigest) reasons.push("config");
  if (report.inventoryGeneration !== observed.inventoryGeneration) reasons.push("inventory");
  if (report.fenceAttestation !== observed.fenceAttestation) reasons.push("fence");
  if (report.authentication?.keyId !== observed.keyId) reasons.push("key");
  if (report.inventorySource === "recorded") reasons.push("recorded");
  return { current: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Strict verdict
// ---------------------------------------------------------------------------

/** The required capabilities of the report's profile that are not ready at
 * the evidence level they declare. Optional capabilities — including every
 * operator-disabled one — never appear here. Unknown is never ready. */
export function strictFailures(report: DoctorReport): CapabilityReadiness[] {
  return report.capabilities.filter((entry) => {
    if (!entry.required) return false;
    const needed = entry.requiredEvidence ?? "configuration";
    return entry.profile !== report.profile
      || !(entry.status === "ready" && evidenceRank(entry.evidenceLevel) >= evidenceRank(needed));
  });
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function renderDoctorJson(report: DoctorReport): string {
  assertDoctorReportSecretFree(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}

function collapsible(entry: CapabilityReadiness): boolean {
  return (entry.capabilityId.startsWith("plugin:") || entry.capabilityId.startsWith("skill:"))
    && entry.status === "ready";
}

/**
 * The concise text view: one header, one row per capability that is not a
 * plainly ready plugin or skill (those collapse into one count per evidence
 * level), the partial and strict verdicts, then the actions. Every word comes
 * from the report's closed vocabulary. Details live in `--json`.
 */
export function renderDoctorText(
  report: DoctorReport,
  options: { readonly strict?: boolean; readonly record?: string; readonly stale?: readonly StaleReason[] } = {},
): string {
  assertDoctorReportSecretFree(report);
  const lines: string[] = [];
  const generation = report.inventoryGeneration ? report.inventoryGeneration.split(":").map((part, index) => index === 0 ? part : part.slice(0, 12)).join(":") : "none";
  lines.push(`profile     ${report.profile}  inventory=${report.inventorySource} (${generation})  config=${report.configDigest.slice(0, 12)}  probe=${report.probe ? "on" : "off"}${report.partial ? "  PARTIAL" : ""}${report.truncated ? "  TRUNCATED" : ""}`);
  if (report.session) {
    lines.push(`session     ${report.session.id ?? "(id withheld)"}  log=${report.session.log.slice(0, 12)}  seq=${report.session.lastSeq}  ${report.session.live ? "live" : "recorded (not running)"}`);
  }
  lines.push("            ready is scoped to its evidence: configuration < registered < local-probe; no provider request was made");
  const collapsed = new Map<string, number>();
  for (const entry of report.capabilities) {
    if (!collapsible(entry)) continue;
    const key = `${entry.capabilityId.split(":")[0]}s ready (${entry.evidenceLevel})`;
    collapsed.set(key, (collapsed.get(key) ?? 0) + 1);
  }
  for (const [key, count] of collapsed) lines.push(`            ${count} ${key}`);
  for (const entry of report.capabilities) {
    if (collapsible(entry)) continue;
    const need = entry.required
      ? `required${entry.requiredEvidence && entry.requiredEvidence !== "configuration" ? `@${entry.requiredEvidence}` : ""}`
      : "optional";
    lines.push(`  ${entry.capabilityId.padEnd(26)} ${entry.status.padEnd(11)} ${entry.evidenceLevel.padEnd(13)} ${need.padEnd(20)} ${entry.reasonCode}`);
  }
  const failedContributors = report.contributors.filter((item) => item.outcome !== "ok");
  if (failedContributors.length > 0) {
    lines.push(`PARTIAL     ${failedContributors.map((item) => `${item.id}=${item.outcome}${item.reasonCode ? `(${item.reasonCode})` : ""}`).join("  ")}; their capabilities are unknown, other results are kept`);
  }
  if (options.stale && options.stale.length > 0) {
    lines.push(`STALE       ${options.stale.join(",")}: this report is not current readiness`);
  }
  if (options.strict) {
    const failures = strictFailures(report);
    lines.push(failures.length === 0
      ? "STRICT      pass (every required capability is ready at its declared evidence)"
      : `STRICT      fail: ${failures.map((entry) => `${entry.capabilityId} ${entry.status}@${entry.evidenceLevel} needs ready@${entry.requiredEvidence ?? "configuration"}`).join("; ")}`);
  }
  const actions = [...new Set(report.capabilities
    .filter((entry) => entry.status !== "ready" && entry.suggestedAction)
    .map((entry) => `${entry.capabilityId}: ${renderAction(entry.suggestedAction!)}`))];
  lines.push(actions.length === 0 ? "FIX         (none)" : `FIX\n${actions.map((line) => `  - ${line}`).join("\n")}`);
  if (options.record) lines.push(`record      ${options.record}`);
  const text = `${lines.join("\n")}\n`;
  for (const line of text.split("\n")) {
    if (reportLeakClasses(line).length > 0) throw new Error("doctor text refused: a rendered line carries a leak class");
  }
  return text;
}

/**
 * The dashboard's reading of a recorded report (ALERTS). A report whose
 * identity could not be rechecked, or differs from what was observed, says
 * only that it is stale; a current one raises its partial state and every
 * required capability that is not ready. Optional gaps stay in the report.
 */
export function doctorReportAlerts(
  report: DoctorReport,
  currency: { readonly current: boolean; readonly reasons: readonly StaleReason[] },
  seq: number,
): { text: string; bad: boolean }[] {
  if (!currency.current) {
    return [{
      text: `doctor_stale profile=${report.profile} reasons=${currency.reasons.join(",")} — not current readiness; rerun dokkabi doctor --profile ${report.profile} seq=${seq}`,
      bad: false,
    }];
  }
  const out: { text: string; bad: boolean }[] = [];
  if (report.partial) {
    const failed = report.contributors.filter((item) => item.outcome !== "ok").map((item) => `${item.id}=${item.outcome}`);
    out.push({ text: `doctor_partial profile=${report.profile} ${failed.join(" ")}${report.truncated ? " truncated" : ""} seq=${seq}`, bad: true });
  }
  for (const entry of strictFailures(report)) {
    out.push({
      text: `doctor_required ${entry.capabilityId} status=${entry.status} evidence=${entry.evidenceLevel} needs=${entry.requiredEvidence ?? "configuration"} reason=${entry.reasonCode} seq=${seq}`,
      bad: true,
    });
  }
  if (out.length === 0) {
    out.push({ text: `doctor_ready profile=${report.profile} inventory=${report.inventorySource} seq=${seq}`, bad: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live inventory: what a runtime itself recorded, read without activating it
// ---------------------------------------------------------------------------

export type InventoryPluginState = "active" | "skipped" | "unloaded" | "pending" | "failed";

export interface InventoryPlugin {
  readonly id: string;
  readonly state: InventoryPluginState;
  readonly digest: string;
  readonly generation: number;
  readonly skipClass?: SkipClass;
  readonly skills: readonly string[];
  readonly seq: number;
}

export interface InventorySnapshot {
  readonly manifestDigest: string;
  /** Digest over every plugin's state, digest and fiber generation. Any
   * transition a runtime records moves it. */
  readonly digest: string;
  readonly plugins: ReadonlyMap<string, InventoryPlugin>;
  readonly observedSeq: number;
  /** The runtime recorded its own end (`session/close` or `session/crash`). */
  readonly terminated: boolean;
  /** More distinct plugins or skills than any runtime registers: not an inventory. */
  readonly overflow: boolean;
}

export const MAX_INVENTORY_PLUGINS = 128;
export const MAX_INVENTORY_SKILLS = 32;

const PLUGIN_ROWS: Record<string, InventoryPluginState> = {
  "plugin/load": "active",
  "plugin/skip": "skipped",
  "plugin/unload": "unloaded",
  "plugin/pending": "pending",
  "plugin/transition_failed": "failed",
};

/**
 * The inventory snapshot of a runtime: the plugin rows its own loader
 * appended to its EventLog since the boot that made the current manifest
 * live. Reading it runs no plugin code and changes nothing. Returns undefined
 * for a log no runtime booted in. Bounded: past MAX_INVENTORY_PLUGINS
 * distinct ids or MAX_INVENTORY_SKILLS skills a snapshot is `overflow`.
 *
 * The anchor is the OLDEST open in the trailing streak of same-digest opens —
 * a restart on the same build appends a new open but reuses the fibers
 * without new load rows (the loader's alreadyLoaded rule).
 */
export function inventorySnapshotFromEvents(events: readonly EventRecord[]): InventorySnapshot | undefined {
  let anchor = -1;
  let digest: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name !== "session/open") continue;
    const candidate = event.payload.plugin_manifest_digest;
    if (typeof candidate !== "string") break;
    if (digest === undefined) digest = candidate;
    if (candidate !== digest) break;
    anchor = index;
  }
  if (anchor < 0 || digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) return undefined;
  const plugins = new Map<string, InventoryPlugin>();
  let observedSeq = events[anchor]!.seq;
  let terminated = false;
  let overflow = false;
  for (let index = anchor + 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.name === "session/close" || event.name === "session/crash") {
      terminated = true;
      observedSeq = event.seq;
      continue;
    }
    const state = PLUGIN_ROWS[event.name];
    if (state === undefined) continue;
    const id = event.payload.id;
    if (typeof id !== "string" || !IDENT.test(id)) continue;
    if (!plugins.has(id) && plugins.size >= MAX_INVENTORY_PLUGINS) {
      overflow = true;
      continue;
    }
    const rawSkills = Array.isArray(event.payload.skills) ? event.payload.skills : [];
    if (rawSkills.length > MAX_INVENTORY_SKILLS) overflow = true;
    const skills = rawSkills.slice(0, MAX_INVENTORY_SKILLS).filter((skill): skill is string => typeof skill === "string" && IDENT.test(skill));
    const skipClass = event.payload.skip_class;
    plugins.set(id, {
      id,
      state,
      digest: typeof event.payload.digest === "string" && /^[a-f0-9]{64}$/u.test(event.payload.digest) ? event.payload.digest : "",
      generation: typeof event.payload.generation === "number" && Number.isSafeInteger(event.payload.generation) ? event.payload.generation : 0,
      ...(state === "skipped"
        ? { skipClass: typeof skipClass === "string" && (SKIP_CLASSES as readonly string[]).includes(skipClass) ? skipClass as SkipClass : "unclassified" }
        : {}),
      skills: state === "active" ? skills : [],
      seq: event.seq,
    });
    observedSeq = event.seq;
  }
  const identity = [...plugins.values()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((plugin) => ({ id: plugin.id, state: plugin.state, digest: plugin.digest, generation: plugin.generation }));
  return {
    manifestDigest: digest,
    digest: digestOf({ manifest: digest, plugins: identity, terminated, overflow }),
    plugins,
    observedSeq,
    terminated,
    overflow,
  };
}

/**
 * The dashboard's reading of the newest `doctor/report` row in a log. It
 * never shows a report without deciding its freshness through `freshness` —
 * the same function the CLI uses (doctor-freshness.ts). A report that is not
 * authentic or not current raises only `doctor_stale`.
 */
export function doctorAlertsFromEvents(
  events: readonly EventRecord[],
  freshness: (report: DoctorReport) => { readonly current: boolean; readonly reasons: readonly StaleReason[] },
): { text: string; bad: boolean; seq: number }[] {
  let row: EventRecord | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.name === DOCTOR_REPORT_EVENT) {
      row = events[index];
      break;
    }
  }
  if (!row) return [];
  let report: DoctorReport;
  try {
    report = parseDoctorReport(row.payload?.report);
  } catch {
    return [{ text: `doctor_report_unreadable seq=${row.seq}`, bad: true, seq: row.seq }];
  }
  let verdict: { readonly current: boolean; readonly reasons: readonly StaleReason[] };
  try {
    verdict = freshness(report);
  } catch {
    verdict = { current: false, reasons: ["unobservable"] };
  }
  return doctorReportAlerts(report, verdict, row.seq).map((item) => ({ ...item, seq: row.seq }));
}
