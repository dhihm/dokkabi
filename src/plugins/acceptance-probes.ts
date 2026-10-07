import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ArtifactContributionRegistry, EvaluationRegistry, HostContext, PluginModule } from "../loader/types.ts";
import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import { appendSandboxExecutionEvent, spawnPreparedSandbox, createPolicy, disposeSandboxPolicy, type SandboxExecutionResult } from "../host/sandbox.ts";
import { workspaceToolsPolicy } from "./workspace-tools.ts";
import { assertPreparedFixture, assertPreparedFixtureEnvironment } from "../work/evidence/fixture-prepare.ts";
import { effectiveSandboxChildEnvironment } from "../host/sandbox.ts";
import { deriveAcceptanceProbe } from "../work/evidence/acceptance-decision.ts";
import { recordFixtureBody } from "../work/evidence/fixture-manifest.ts";
import type { AcceptanceProbeExecutor } from "../work/evidence/acceptance-execution.ts";

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
export function createAcceptanceProbeExecutor(ctx: HostContext): AcceptanceProbeExecutor {
  const registry = ctx.get<EvaluationRegistry>("evaluation");
  const artifacts = ctx.get<ArtifactContributionRegistry>("artifact_contributions");
  let ordinal = 0;
  return Object.freeze({
    async execute(input: Parameters<AcceptanceProbeExecutor["execute"]>[0]) {
      assertPreparedFixture(input.prepared);
      const tools = ctx.get<AgentTool[]>("tools"), basePolicy = workspaceToolsPolicy(tools);
      if (!basePolicy || basePolicy.disabled || basePolicy.backend === "none" || basePolicy.mode !== "read-only" || basePolicy.workspaceRoot !== input.prepared.root ||
        ctx.workspaceRoot !== input.prepared.root || (basePolicy.writablePaths?.length ?? 0) !== 0) throw new Error("acceptance_native_read_only_required");
      let policy;
      try {
        policy = createPolicy({ mode: "read-only", workspaceRoot: input.prepared.root, backend: basePolicy.backend, observerIsolation: true, writablePaths: [], log: ctx.log });
      } catch {
        ctx.log.append({ kind: "observe", name: "evaluation/refused", payload: { status: "unavailable", reason_code: "acceptance_isolation_unavailable" } });
        return { evaluation: { status: "unavailable" as const, reason_code: "acceptance_isolation_unavailable" }, process: { exitCode: 1, stdout: "", stderr: "", error: "acceptance_isolation_unavailable" } };
      }
      try {
        assertPreparedFixtureEnvironment(input.prepared, effectiveSandboxChildEnvironment(policy));
        const blobs = BlobStore.forSession(ctx.log.path), candidate = blobs.put(canonicalJson(input.candidate)), contract = blobs.put(canonicalJson(input.contract));
        const body = { schema_version: 2 as const, authority: { kind: "deployment" as const, phase: "acceptance" as const, audience: "deployment" as const, role: "acceptance_checker" as const },
          candidate_ref: { path: blobs.pathOf(candidate), digest: candidate }, contract_ref: { path: blobs.pathOf(contract), digest: contract },
          requirements: { evidence_level: "execution" as const, metric: { unit: "checks", source: "host.public-process-output-v1" } } };
        const contextRef = artifacts.record({ kind: "evidence-record-v2", name: "evaluation/context", body });
        const evaluatorId = `acceptance-${++ordinal}-${createHash("sha256").update(input.checkId).digest("hex")}`;
        let process: SandboxExecutionResult | undefined;
        const release = registry.register({ id: evaluatorId, role: "acceptance_checker", phases: ["acceptance"], audiences: ["deployment"], isolation: "process",
          module_path: import.meta.path,
          dependency_paths: [resolve(import.meta.dir, "../work/evidence/acceptance-decision.ts"), resolve(import.meta.dir, "../host/sandbox.ts")], config: input.template }, request => {
          assertPreparedFixture(input.prepared);
          const command = input.template.argv.map(quote).join(" ");
          const native = appendSandboxExecutionEvent({ log: ctx.log, policy, evidence: { kind: "direct", commandDigest: createHash("sha256").update(command).digest("hex") } });
          process = spawnPreparedSandbox(native, command, input.timeoutMs, { stdin: Buffer.from(input.template.stdin), maxBuffer: 4 * 1024 * 1024, captureBytes: true });
          recordFixtureBody(ctx.log, "acceptance/process", { check_id: input.checkId, execution_id: request.dispatch.execution_id, command, stdin: input.template.stdin, process, native_digest: native.digest, boundary: native.observerBoundary });
          assertPreparedFixture(input.prepared);
          const derived = deriveAcceptanceProbe(input.template, process);
          // The evaluator outcome describes this host comparison. The candidate's
          // actual exit, including a required error exit, remains in the raw body.
          return { outcome: { status: derived === "unavailable" ? "error" : derived, exit_code: derived === "passed" ? 0 : derived === "failed" ? 1 : null, signal: process.signal ?? null },
            metric: { ...body.requirements.metric, value: derived === "passed" ? 1 : 0 }, output: { process, template: input.template, comparison: derived } };
        });
        try {
          const evaluation = await registry.dispatchForContext({ evaluator_id: evaluatorId, contract_ref: contract, input_ref: contextRef.digest }, { ...body, context_ref: contextRef });
          return { evaluation, process: process ?? { exitCode: 1, stdout: "", stderr: "", error: "acceptance_not_executed" } };
        } finally { await release(); }
      } finally { disposeSandboxPolicy(policy); }
    },
  });
}

export const plugin: PluginModule = {
  id: "acceptance-probes",
  claims: [{ key: "evaluation", role: "consumer" }, { key: "artifact_contributions", role: "consumer" }, { key: "tools", role: "consumer" },
    { key: "acceptance_probes", role: "definition" }, { key: "acceptance_probes", role: "provider" }],
  register(ctx) {
    ctx.define("acceptance_probes", { visibility: "host_only", role: "acceptance_checker", protocol: "public-process-output-v1" });
    ctx.provide("acceptance_probes", createAcceptanceProbeExecutor(ctx));
  },
};
