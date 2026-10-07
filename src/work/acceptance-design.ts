import { z } from "zod";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { EventLog } from "../host/event-log.ts";
import type { WorkPlan } from "./schema.ts";
import { canonicalJson } from "../host/canonical.ts";
import { bindPlan } from "./log.ts";
import { projectObligations } from "./evidence/obligations.ts";
import { acceptanceCandidate, acceptanceTemplateSchema, enrollAcceptanceContract, type AcceptanceContract } from "./evidence/acceptance-contract.ts";
import { enrollFixture, fixturePathSchema, readFixtureEnrollment, recordFixtureBody } from "./evidence/fixture-manifest.ts";
import { readEvidenceBodies } from "./evidence/bodies.ts";

const checkerRoot = ".dokkabi-acceptance";
const checkerPath = fixturePathSchema.refine(path => path.startsWith(checkerRoot + "/"));
const readySchema = z.strictObject({
  status: z.literal("ready"),
  checks: z.array(z.strictObject({ id: z.string().min(1).max(128), scenario: z.string().min(1),
    statement: z.string().min(1).max(4096), template: acceptanceTemplateSchema })).min(1).max(32),
  files: z.array(z.strictObject({ path: checkerPath, content: z.string().min(1).max(65536) })).min(1).max(16),
});
export const acceptanceDesignSchema = z.discriminatedUnion("status", [readySchema,
  z.strictObject({ status: z.literal("unsupported"), reason: z.string().min(1).max(4096) }),
]);
export type AcceptanceDesign = z.infer<typeof acceptanceDesignSchema>;
export interface AcceptancePreparationInput {
  order: string;
  plan: WorkPlan;
  /** Explicit host selection of generated, protected public-output criteria. */
  generate?(prompt: string): Promise<{ proposal: unknown; source: string }>;
}

/** The prework design already supplies the blind-to-final-artifact criteria.
 * Reuse them verbatim; another model must not re-author that frozen inventory. */
export function preworkAcceptanceSpecification(contract: AcceptanceContract): string {
  return [
    `BOUNDARIES: ${JSON.stringify(contract.required_checks.map(check => check.statement))}`,
    `CONTRACT: ${JSON.stringify(contract.order)}`,
    "COUNTEREXAMPLE: a public invocation differs from its frozen expected result",
    `CHECK: ${JSON.stringify(contract.required_checks.map(check => check.id))}`,
  ].join("\n");
}

/** Reuse the actual closed design child, including its retained replay identity,
 * when publishing final delivery. A proposal alone cannot invent a child. */
export function preworkSpecificationSource(log: EventLog, proposalRef: string) {
  const proposalEvent = log.events.find(event => event.name === "acceptance/proposal" && event.payload.blob === proposalRef);
  const proposal = readEvidenceBodies(log).get(proposalRef) as { source?: unknown } | undefined;
  const child = log.events.find(event => event.name === "acceptance/design_session" && event.seq < (proposalEvent?.seq ?? 0)
    && event.payload.session === proposal?.source);
  if (!child || typeof child.payload.session !== "string" ||
    ![child.payload.digest, child.payload.log_hash].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("acceptance_prework_source_delivery_missing");
  }
  return { spec_session: child.payload.session, spec_digest: child.payload.digest, spec_log_hash: child.payload.log_hash };
}

export function buildAcceptanceDesignPrompt(order: string, plan: WorkPlan): string {
  return [
    "Prepare executable acceptance criteria BEFORE implementation. You review the original request and pre-change workspace in a separate read-only session.",
    "Inspect the real public API and necessary source with the available read-only tools. Do not implement the fix or write workspace files.",
    "Return exactly one JSON object, without a markdown fence. Cover every scenario ID in the sealed plan. Derive expected behavior from the request, never from the current broken implementation's output.",
    "Schema: {status:'ready',checks:[{id,scenario,statement,template:{id,kind:'public-process-output-v1',argv:[...],stdin:'',expected:{stdout,stderr,exit_code},timeout_ms}}],files:[{path,content}]}.",
    "Use JSON double quotes. IDs must be nonempty and unique. Each check's id equals its template id. timeout_ms is 1..60000. Each check names one existing scenario; multiple checks may cover it.",
    "All checker files are under .dokkabi-acceptance/. The host installs these files only in its evaluation snapshot; the implementation cannot change their frozen bytes. Every argv must invoke one declared checker file. Include all checker helpers in files.",
    "Checkers invoke the real candidate's public behavior and print its actual returned values or serialized observable results. They must not print a PASS flag, synthesize the desired answer, replace candidate functions, or contain the expected-output comparison. The HOST compares retained output bytes to expected. Do not reduce a behavior check to a test runner's success message or exit code.",
    "The process starts at the candidate workspace root, with a read-only filesystem and no network. Account for your runtime's import path when invoking a checker in a subdirectory. Use deterministic serialization. Framework bootstrapping belongs in the checker when required. Do not assume future code structure beyond the public interface required by the task.",
    "Use the smallest discriminating set covering the requested behavior and relevant edge cases. Combine inputs for one boundary in one checker and print a compact JSON result. Do not add redundant probes, exhaustive enumerations or requirements absent from the order. If this public-process protocol cannot express a required boundary, return {status:'unsupported',reason:'the exact unsupported boundary and missing capability'}; do not silently omit it.",
    `Original operator request:\n${order}`,
    `Sealed plan:\n${canonicalJson(plan)}`,
  ].join("\n\n");
}

/** A generated contract is a fallible, recorded interpretation of the task, not
 * an operator-authored research oracle. Its bytes and execution are host-owned. */
export async function prepareGeneratedAcceptance(log: EventLog, workspace: string, input: AcceptancePreparationInput): Promise<void> {
  if (!input.generate) throw new Error("acceptance_generation_not_selected");
  if (readFixtureEnrollment(log, workspace) || existsSync(join(workspace, ".swe-test.patch"))) throw new Error("acceptance_existing_fixture_requires_explicit_catalog");
  if (existsSync(join(workspace, checkerRoot))) throw new Error("acceptance_checker_path_already_exists");
  bindPlan(log, input.plan);
  const snapshot = projectObligations(log.events).current!;
  if (input.order !== input.plan.goal.statement) throw new Error("acceptance_order_mismatch");
  if (log.events.some(event => event.seq > snapshot.scope_seq && event.name === "work/step" && event.payload.action === "implement")) {
    throw new Error("acceptance_design_must_precede_implementation");
  }
  const before = acceptanceCandidate(log, workspace).digest;
  log.append({ kind: "observe", name: "acceptance/readiness", payload: { status: "preparing", scope_seq: snapshot.scope_seq } });
  try {
    const generated = await input.generate(buildAcceptanceDesignPrompt(input.order, input.plan));
    const proposal = acceptanceDesignSchema.parse(generated.proposal);
    const proposalRef = recordFixtureBody(log, "acceptance/proposal", { proposal, source: generated.source, order: input.order,
      scope_seq: snapshot.scope_seq, original_candidate: before });
    if (proposal.status === "unsupported") throw new Error(`acceptance_unsupported: ${proposal.reason}`);
    if (acceptanceCandidate(log, workspace).digest !== before || projectObligations(log.events).current?.digest !== snapshot.digest) {
      throw new Error("acceptance_original_task_changed_during_design");
    }
    if (new Set(proposal.checks.map(check => check.id)).size !== proposal.checks.length ||
      new Set(proposal.files.map(file => file.path)).size !== proposal.files.length) throw new Error("acceptance_duplicate_identity");
    if (proposal.files.reduce((n, file) => n + Buffer.byteLength(file.content), 0) > 262144) throw new Error("acceptance_checker_size_limit");
    const required = input.plan.scenarios.map(scenario => scenario.id);
    if (!required.length || required.some(id => !proposal.checks.some(check => check.scenario === id)) ||
      proposal.checks.some(check => !required.includes(check.scenario))) throw new Error("acceptance_scenario_coverage_incomplete");
    for (const check of proposal.checks) {
      if (check.id !== check.template.id || !proposal.files.some(file => check.template.argv.includes(file.path))) {
        throw new Error("acceptance_checker_invocation_mismatch");
      }
    }
    const required_checks = proposal.checks.map(check => {
      const obligation = snapshot.obligations.find(item => item.kind === "scenario" && item.alias === check.scenario);
      if (!obligation?.key) throw new Error("acceptance_unknown_operator_obligation");
      return { id: check.id, obligation_key: obligation.key, template_id: check.template.id, statement: check.statement };
    });
    const sourceRoot = mkdtempSync(join(tmpdir(), "dokkabi-acceptance-source-"));
    try {
      for (const file of proposal.files) {
        const path = join(sourceRoot, file.path); mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content, { flag: "wx", mode: 0o600 });
      }
      enrollFixture(log, { id: `acceptance-${proposalRef}`, workspace, sourceRoot, visibility: "visible", scope: "acceptance",
        files: proposal.files.map(file => ({ path: file.path, role: "entrypoint" as const })),
        discoveryRoots: [checkerRoot], environment: { PYTHONDONTWRITEBYTECODE: "1" }, commands: ["dokkabi acceptance"] });
    } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
    enrollAcceptanceContract(log, workspace, { schema_version: 1, order: input.order, required_checks,
      templates: proposal.checks.map(check => check.template), origin: { kind: "generated_prework", proposal_ref: proposalRef } });
    log.append({ kind: "observe", name: "acceptance/readiness", payload: { status: "prepared", scope_seq: snapshot.scope_seq,
      origin: "generated_prework", proposal_ref: proposalRef, required_checks: required_checks.length } });
  } catch (error) {
    log.append({ kind: "observe", name: "acceptance/readiness", payload: { status: "unavailable", scope_seq: snapshot.scope_seq,
      reason: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}
