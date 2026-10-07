import { z } from "zod";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type { EventLog } from "../../host/event-log.ts";
import { BlobStore } from "../../host/blob-store.ts";
import { canonicalJson } from "../../host/canonical.ts";
import { evidenceDigest, freezeEvidence } from "./contract.ts";
import { projectObligations } from "./obligations.ts";
import { fixtureRoot, readFixtureEnrollment, recordFixtureBody } from "./fixture-manifest.ts";
import { listFixtureDirectory, withFixtureFileReader } from "./fixture-files.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const streamText = z.string().max(2 * 1024 * 1024).refine(value => Buffer.byteLength(value) <= 2 * 1024 * 1024, "acceptance stream exceeds its byte limit");
export const acceptanceTemplateSchema = z.strictObject({
  id, kind: z.literal("public-process-output-v1"),
  // These are public candidate invocations, not scripts whose PASS flag is trusted.
  argv: z.array(z.string().min(1).max(4096).refine(value => !value.includes("\0"))).min(1).max(64),
  stdin: streamText,
  expected: z.strictObject({ stdout: streamText, stderr: streamText, exit_code: z.number().int().min(0).max(125) }),
  timeout_ms: z.number().int().min(1).max(60000),
});
export type AcceptanceTemplate = z.infer<typeof acceptanceTemplateSchema>;
export const acceptanceEnrollmentSchema = z.strictObject({
  schema_version: z.literal(1), order: z.string().min(1),
  origin: z.strictObject({ kind: z.literal("generated_prework"), proposal_ref: digest }).optional(),
  required_checks: z.array(z.strictObject({ id, obligation_key: digest, template_id: id, statement: z.string().min(1).max(4096) })).min(1).max(32),
  templates: z.array(acceptanceTemplateSchema).min(1).max(32),
});
const contractSchema = acceptanceEnrollmentSchema.extend({
  workspace: z.string(), fixture_digest: digest, scope_seq: z.number().int().positive(),
  obligations: z.array(z.strictObject({ key: digest, signature: digest })).min(1),
});
export type AcceptanceContract = z.infer<typeof contractSchema>;
export const ACCEPTANCE_BODY_EVENTS = new Set(["acceptance/proposal", "acceptance/enrolled", "acceptance/specification", "acceptance/candidate", "acceptance/process", "acceptance/decision", "acceptance/current"]);

function validateInventory(contract: z.infer<typeof acceptanceEnrollmentSchema>): void {
  for (const rows of [contract.required_checks, contract.templates]) {
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("acceptance_duplicate_identity");
  }
  if (contract.required_checks.some(check => !contract.templates.some(template => template.id === check.template_id)) ||
    contract.templates.some(template => !contract.required_checks.some(check => check.template_id === template.id))) {
    throw new Error("acceptance_template_inventory_mismatch");
  }
}

/** Trusted host control plane only. Neither a model declaration nor an ordinary
 * workspace file enrolls requirements. Source fixture authority predates work. */
export function enrollAcceptanceContract(log: EventLog, workspace: string, input: z.infer<typeof acceptanceEnrollmentSchema>): string {
  const enrollment = acceptanceEnrollmentSchema.parse(input); validateInventory(enrollment);
  const root = fixtureRoot(workspace), fixture = readFixtureEnrollment(log, root);
  if (!fixture || fixture.manifest.visibility !== "visible" || !fixture.manifest.commands.includes("dokkabi acceptance")) throw new Error("acceptance_visible_fixture_required");
  const snapshot = projectObligations(log.events).current;
  if (!snapshot) throw new Error("acceptance_operator_obligations_required");
  const keys = [...new Set(enrollment.required_checks.map(check => check.obligation_key))];
  const obligations = keys.map(key => {
    const item = snapshot.obligations.find(row => row.key === key);
    if (!item) throw new Error("acceptance_unknown_obligation");
    return { key, signature: item.signature };
  });
  const contract = contractSchema.parse({ ...enrollment, workspace: root, fixture_digest: fixture.digest, scope_seq: snapshot.scope_seq, obligations });
  const prior = readAcceptanceContract(log, root);
  if (prior) {
    if (evidenceDigest(prior) !== evidenceDigest(contract)) throw new Error("acceptance_contract_already_enrolled");
    return evidenceDigest(prior);
  }
  return recordFixtureBody(log, "acceptance/enrolled", contract, { workspace: root, scope_seq: snapshot.scope_seq });
}

export function readAcceptanceContract(log: EventLog, workspace: string): AcceptanceContract | undefined {
  if (!log.isReadOnly) log.refresh();
  const scope = projectObligations(log.events).current?.scope_seq;
  const root = realpathSync(resolve(workspace));
  const rows = log.events.filter(event => event.name === "acceptance/enrolled" && event.payload.workspace === root && event.payload.scope_seq === scope);
  if (rows.length === 0) return;
  if (rows.length !== 1 || typeof rows[0]!.payload.blob !== "string") throw new Error("acceptance_enrollment_ambiguous");
  const contract = contractSchema.parse(JSON.parse(BlobStore.forSession(log.path).get(rows[0]!.payload.blob)));
  validateInventory(contract);
  if (contract.workspace !== root || contract.scope_seq !== scope) throw new Error("acceptance_enrollment_binding_mismatch");
  return freezeEvidence(contract);
}

export function assertAcceptanceContract(log: EventLog, contract: AcceptanceContract, order: string): void {
  const current = readAcceptanceContract(log, contract.workspace), snapshot = projectObligations(log.events).current;
  if (!current || evidenceDigest(current) !== evidenceDigest(contract) || order !== contract.order || !snapshot || snapshot.scope_seq !== contract.scope_seq ||
    contract.obligations.some(item => !snapshot.obligations.some(row => row.key === item.key && row.signature === item.signature)) ||
    readFixtureEnrollment(log, contract.workspace)?.digest !== contract.fixture_digest) throw new Error("acceptance_contract_changed");
}

/** No candidate, checker implementation, expected outputs or hidden oracle data
 * enters the blind phase. Exact required identities cannot be dropped by prose. */
export function blindAcceptanceInventory(contract: AcceptanceContract): string {
  return canonicalJson(contract.required_checks.map(({ id, statement, obligation_key, template_id }) => ({ id, statement, obligation_key, template_id })));
}
export type AcceptanceCheckInventoryIssue = "check_field_missing" | "check_trailing_text" | "check_json_malformed" |
  "check_not_array" | "check_id_not_string" | "check_id_duplicate" | "check_id_foreign" | "check_id_missing";
export type AcceptanceCheckInventory = { readonly complete: true } |
  { readonly complete: false; readonly issue: AcceptanceCheckInventoryIssue; readonly reason: string };

/** End of a leading top-level JSON array, for diagnosis only. The strict
 * parse below still refuses it; no prefix is ever accepted as CHECK. */
function leadingArrayEnd(text: string): number | undefined {
  if (!text.startsWith("[")) return;
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === "\"") quoted = false; continue; }
    if (char === "\"") quoted = true;
    else if (char === "[" || char === "{") depth += 1;
    else if ((char === "]" || char === "}") && --depth === 0) return index + 1;
  }
}

/** Strict CHECK field: only a JSON array holding every enrolled ID exactly once.
 * The bounded reason names host-enrolled IDs only, never model-supplied text. */
export function validateAcceptanceCheckInventory(review: string, contract: AcceptanceContract): AcceptanceCheckInventory {
  const refuse = (issue: AcceptanceCheckInventoryIssue, reason: string): AcceptanceCheckInventory =>
    ({ complete: false, issue, reason: reason.length > 512 ? reason.slice(0, 509) + "..." : reason });
  const line = review.split(/\r?\n/u).find(value => value.startsWith("CHECK:"));
  if (line === undefined) return refuse("check_field_missing", "the CHECK field is missing");
  const text = line.slice(6).trim();
  let ids: unknown;
  try { ids = JSON.parse(text); } catch {
    const end = leadingArrayEnd(text);
    if (end !== undefined && end < text.length) {
      try {
        JSON.parse(text.slice(0, end));
        return refuse("check_trailing_text", "the CHECK field has text after its JSON array; CHECK must contain only the JSON array");
      } catch { /* the prefix is malformed too */ }
    }
    return refuse("check_json_malformed", "the CHECK field is not valid JSON");
  }
  if (!Array.isArray(ids)) return refuse("check_not_array", "the CHECK field JSON is not an array");
  if (ids.some(value => typeof value !== "string")) return refuse("check_id_not_string", "the CHECK array contains a value that is not a string ID");
  if (new Set(ids).size !== ids.length) return refuse("check_id_duplicate", "the CHECK array lists an ID more than once");
  const enrolled = new Set(contract.required_checks.map(check => check.id));
  const foreign = ids.filter(value => !enrolled.has(value)).length;
  if (foreign > 0) return refuse("check_id_foreign", `the CHECK array contains ${foreign} ID(s) that are not enrolled`);
  const missing = contract.required_checks.filter(check => !ids.includes(check.id)).map(check => check.id);
  if (missing.length > 0) return refuse("check_id_missing", `the CHECK array omits enrolled ID(s): ${missing.join(", ")}`);
  return { complete: true };
}
export function completeAcceptanceSpec(review: string, contract: AcceptanceContract): boolean {
  return validateAcceptanceCheckInventory(review, contract).complete;
}

/** Full delivered tree identity, including untracked files and directory modes.
 * Only existing host bookkeeping exclusions from fixture preparation apply. */
export function acceptanceCandidate(log: EventLog, root: string, excluded: readonly string[] = []): { digest: string; body: unknown } {
  const omitted = [".git", ".dokkabi-home", ...excluded,
    relative(root, log.path), relative(root, join(dirname(log.path), "blobs"))].map(path => path.replaceAll("\\", "/"));
  const rows: { path: string; kind: string; mode: number; sha256?: string; bytes?: number }[] = [{ path: ".", kind: "directory", mode: lstatSync(root).mode & 0o7777 }];
  let bytes = 0;
  withFixtureFileReader(root, read => {
    const visit = (directory = ""): void => {
      for (const entry of listFixtureDirectory(root, directory || undefined)) {
        const path = directory ? directory + "/" + entry.name : entry.name;
        if (omitted.some(prefix => path === prefix || path.startsWith(prefix + "/"))) continue;
        if (rows.length >= 100000) throw new Error("acceptance_candidate_limit");
        if (entry.kind === "directory") {
          rows.push({ path, kind: "directory", mode: lstatSync(join(root, path)).mode & 0o7777 }); visit(path);
        } else {
          const file = read(path); bytes += file.bytes.length;
          if (bytes > 1024 ** 3 || file.identity !== entry.identity) throw new Error("acceptance_candidate_changed_or_oversized");
          rows.push({ path, kind: "file", mode: file.mode, sha256: evidenceDigestBytes(file.bytes), bytes: file.bytes.length });
        }
      }
    }; visit();
  });
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { digest: evidenceDigest(rows), body: rows };
}

function evidenceDigestBytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
