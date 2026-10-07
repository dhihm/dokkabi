import { z } from "zod";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { PluginModule } from "../loader/types.ts";
import type { WorkPlan } from "../work/schema.ts";
import { bindPlan } from "../work/log.ts";
import { freezeEvidence } from "../work/evidence/contract.ts";
import { readFixtureFile } from "../work/evidence/fixture-files.ts";
import { commitBootFixtureEnrollment, fixturePathSchema, prepareBootFixtureEnrollment } from "../work/evidence/fixture-manifest.ts";
import { acceptanceEnrollmentSchema, acceptanceTemplateSchema, assertAcceptanceContract, enrollAcceptanceContract, readAcceptanceContract } from "../work/evidence/acceptance-contract.ts";
import { projectObligations } from "../work/evidence/obligations.ts";
import { prepareGeneratedAcceptance, type AcceptancePreparationInput } from "../work/acceptance-design.ts";
import { enrollWorkReview } from "../work/evidence/work-review.ts";

const requirement = acceptanceEnrollmentSchema.shape.required_checks.element.omit({ obligation_key: true }).extend({
  obligation: z.strictObject({ kind: z.enum(["goal", "todo", "scenario", "case"]), alias: z.string().min(1) }),
});
export const acceptanceCatalogSchema = z.strictObject({
  schema_version: z.literal(1), order: z.string().min(1),
  required_checks: z.array(requirement).min(1).max(32), templates: z.array(acceptanceTemplateSchema).min(1).max(32),
  fixture: z.strictObject({ id: z.string().min(1), sourceRoot: z.string().min(1),
    files: z.array(z.strictObject({ path: fixturePathSchema, role: z.enum(["entrypoint", "helper", "config", "import", "discovery"]) })).min(1),
    discoveryRoots: z.array(fixturePathSchema).optional(), environment: z.record(z.string(), z.string()), commands: z.array(z.string()).min(1),
    excludedCandidateRoots: z.array(fixturePathSchema).optional(), absentPaths: z.array(fixturePathSchema).optional() }),
});
export interface AcceptanceCatalog {
  bind(order: string, plan: WorkPlan): void;
  prepare(input: AcceptancePreparationInput): Promise<void>;
}
function outside(workspace: string, path: string): boolean {
  const rel = relative(workspace, path); return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

/** The operator's acceptance catalog, when one is named, or the refusal it
 * is: unparseable, or inside the candidate workspace. Read-only. This
 * optional path is an explicit operator input to the host process; it is
 * never discovered in candidate-controlled workspace configuration. */
function operatorCatalog(workspaceRoot: string) {
  const path = process.env.DOKKABI_ACCEPTANCE_MANIFEST;
  const catalog = path ? freezeEvidence(acceptanceCatalogSchema.parse(JSON.parse(readFixtureFile(dirname(resolve(path)), basename(path), { maxBytes: 8 * 1024 * 1024 }).bytes.toString("utf8")))) : undefined;
  if (catalog && (!outside(workspaceRoot, resolve(path!)) || !isAbsolute(catalog.fixture.sourceRoot) || !outside(workspaceRoot, catalog.fixture.sourceRoot))) {
    throw new Error("acceptance_catalog_must_be_outside_candidate");
  }
  return catalog;
}

export const plugin: PluginModule = {
  id: "acceptance-catalog",
  claims: [{ key: "acceptance_catalog", role: "definition" }, { key: "acceptance_catalog", role: "provider" }],
  // The catalog refusals, checked by every boot before register and by its
  // prepare phase (#230 round 4, D1'').
  preflight(ctx) {
    const catalog = operatorCatalog(ctx.workspaceRoot);
    // Enrollment's own refusals are decided here too: the checker closure it
    // reads, and the retained authority a same-session boot reuses exactly
    // or refuses (#230 round 5, B0; R8-06j3 exact boot reuse).
    if (catalog) prepareBootFixtureEnrollment(ctx.log, { ...catalog.fixture, workspace: ctx.workspaceRoot, visibility: "visible" });
  },
  register(ctx) {
    const catalog = operatorCatalog(ctx.workspaceRoot);
    if (catalog) {
      // A first boot enrolls the whole checker closure before any model
      // turn; a restart of the same session reuses the retained authority
      // without writing (R8-06j3).
      commitBootFixtureEnrollment(ctx.log, prepareBootFixtureEnrollment(ctx.log, { ...catalog.fixture, workspace: ctx.workspaceRoot, visibility: "visible" }));
    }
    ctx.define("acceptance_catalog", { visibility: "host_only", source: "explicit_operator_manifest", configured: catalog !== undefined });
    const service: AcceptanceCatalog = { async prepare(input) {
      if (catalog) { service.bind(input.order, input.plan); return; }
      const current = readAcceptanceContract(ctx.log, ctx.workspaceRoot);
      if (current) { assertAcceptanceContract(ctx.log, current, input.order); return; }
      if (input.generate) await prepareGeneratedAcceptance(ctx.log, ctx.workspaceRoot, input);
      else enrollWorkReview(ctx.log, ctx.workspaceRoot, input.order, input.plan);
    }, bind(order, plan) {
      if (!catalog) return;
      if (catalog.order !== order) throw new Error("acceptance_order_mismatch");
      bindPlan(ctx.log, plan);
      const snapshot = projectObligations(ctx.log.events).current!;
      const required_checks = catalog.required_checks.map(({ obligation, ...check }) => {
        const found = snapshot.obligations.find(item => item.kind === obligation.kind && item.alias === obligation.alias);
        if (!found?.key) throw new Error("acceptance_unknown_operator_obligation");
        return { ...check, obligation_key: found.key };
      });
      enrollAcceptanceContract(ctx.log, ctx.workspaceRoot, { schema_version: 1, order, required_checks, templates: catalog.templates });
    } };
    ctx.provide("acceptance_catalog", service);
  },
};
