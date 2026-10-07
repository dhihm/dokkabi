import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { LspRenamer, RenameOutcome, RenamePlan, RollbackOutcome } from "../host/lsp-rename.ts";

/**
 * `lsp_rename_plan` / `lsp_rename_apply` (#229 LN-02/LN-03): a rename is a
 * host-recorded plan under a host-issued reference, applied file by file
 * under the version authority. The plan tool returns the plan as data (per
 * target: before digest, edit count, previews); the apply tool takes ONLY
 * the plan reference (`op: "rollback"` reverts a plan's committed files that
 * still hold the recorded after bytes). No multi-file atomicity is claimed:
 * `partial` lists the exact receipts. Nothing here is a verdict.
 */

const PlanParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative path of the document holding the symbol." }),
  line: Type.Integer({ minimum: 1, description: "1-based line of the symbol, as read shows it." }),
  character: Type.Integer({ minimum: 1, description: "1-based column of the symbol in UTF-16 units." }),
  new_name: Type.String({ description: "The new identifier. Validated by the host's rule for the language and by the server." }),
}, { additionalProperties: false });

const ApplyParameters = Type.Object({
  plan: Type.String({ description: "The plan reference `rp_…` a previous lsp_rename_plan returned." }),
  op: Type.Optional(Type.Union([Type.Literal("apply"), Type.Literal("rollback")], { description: "apply (default) or rollback of an applied/partial plan." })),
}, { additionalProperties: false });

export const LSP_RENAME_PLAN_TOOL = "lsp_rename_plan";
export const LSP_RENAME_APPLY_TOOL = "lsp_rename_apply";

export function planText(plan: RenamePlan): string {
  return JSON.stringify({
    status: plan.status,
    ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
    ...(plan.detail !== undefined ? { detail: plan.detail } : {}),
    plan: plan.planRef,
    request: plan.requestRef,
    ...(plan.document ? { document: plan.document } : {}),
    position: { line: plan.position.line + 1, character: plan.position.character + 1 },
    ...(plan.oldName !== undefined ? { old_name: plan.oldName } : {}),
    new_name: plan.newName,
    files: plan.files,
    edits: plan.edits,
    patch_bytes: plan.patchBytes,
    documents: plan.documents.map((target) => ({
      path: target.path, before: target.beforeDigest, after: target.afterDigest, edits: target.edits.length,
      bytes: target.edits.map((edit) => [edit.startByte, edit.endByte]), preview: target.preview,
    })),
    ...(plan.previewOmitted > 0 ? { preview_omitted_lines: plan.previewOmitted } : {}),
    note: plan.status === "ready"
      ? "Apply with lsp_rename_apply({plan}) — only this reference; the plan is immutable and applies once, file by file, refusing any target whose bytes changed."
      : "This plan cannot be applied. A stale plan can be planned again; an unsupported one names why.",
  });
}

export function outcomeText(outcome: RenameOutcome | RollbackOutcome): string {
  return JSON.stringify({ ...outcome, note: "Receipts are the authority's operation ids; a `partial`/`unresolved` outcome lists what was and was not applied — read a changed file before editing it again." });
}

export function createLspRenameTools(input: { readonly renamer?: () => LspRenamer | undefined; readonly replay?: boolean }): [AgentTool<typeof PlanParameters>, AgentTool<typeof ApplyParameters>] {
  const replay = (): { content: Array<{ type: "text"; text: string }>; details: { replay: true } } =>
    ({ content: [{ type: "text", text: JSON.stringify({ status: "unavailable", reason: "replay: recorded results only; no language server and no writer runs" }) }], details: { replay: true } });
  const plan: AgentTool<typeof PlanParameters> = {
    name: LSP_RENAME_PLAN_TOOL,
    label: "lsp rename plan",
    description: "Plan a rename of the symbol at a position through the language server: the host records an immutable plan (per file: before digest, exact byte spans, previews) and returns its reference. Nothing is written. Positions are 1-based (line as read shows it, column in UTF-16 units).",
    parameters: PlanParameters,
    async execute(toolCallId, params, signal) {
      const renamer = input.replay ? undefined : input.renamer?.();
      if (!renamer) return replay();
      const planned = await renamer.plan({
        path: String(params.path),
        position: { line: Math.trunc(Number(params.line)) - 1, character: Math.trunc(Number(params.character)) - 1 },
        newName: String(params.new_name),
      }, toolCallId, signal);
      return { content: [{ type: "text", text: planText(planned) }], details: { status: planned.status, plan: planned.planRef } };
    },
  };
  const apply: AgentTool<typeof ApplyParameters> = {
    name: LSP_RENAME_APPLY_TOOL,
    label: "lsp rename apply",
    description: "Apply a plan lsp_rename_plan returned, by its reference only: every target is checked against the plan's before digest first (one stale file: `conflict`, nothing written), then committed file by file through the version authority; a later refusal is `partial` with the exact receipts. op: \"rollback\" reverts a plan's committed files that still hold the recorded bytes.",
    parameters: ApplyParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const renamer = input.replay ? undefined : input.renamer?.();
      if (!renamer) return replay();
      const outcome = params.op === "rollback"
        ? await renamer.rollback(String(params.plan), toolCallId)
        : await renamer.apply(String(params.plan), toolCallId, signal);
      return { content: [{ type: "text", text: outcomeText(outcome) }], details: { status: outcome.status, plan: outcome.planRef } };
    },
  };
  return [plan, apply];
}
