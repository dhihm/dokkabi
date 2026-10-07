import type { ModelResilienceService } from "./model-resilience.ts";
import { isRecoveryTerminalError } from "../host/recovery.ts";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventLog } from "../host/event-log.ts";
import type { PluginModule, ToolContributionRegistry } from "../loader/types.ts";
import { clampToolResultText, producerTruncation } from "../tools/model-result.ts";
import { openAcceptanceVerifier, type AcceptanceVerifierSession } from "../work/accept-session.ts";
import { buildAcceptanceSpecPrompt } from "../work/prompt.ts";
import { streamFinalChunk } from "../work/turn-support.ts";

/**
 * `blind_spec` (interfaces-v2.md §4): the anti-anchoring value of the blind
 * spec, kept as a tool. A fresh session of the same route/model — the
 * accept-spec manifest, no workspace tools — sees only the order rendered
 * through prompts/work/accept-spec.md and answers with its
 * BOUNDARIES/CONTRACT/COUNTEREXAMPLE/CHECK text. That text comes back
 * verbatim: nothing parses it, retries it, or coaches on it, and nothing but
 * the calling model consumes it. The call itself is on the parent's record
 * as work/blind_spec with both digests and the session id.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function textResult(text: string, error = false) {
  return { content: [{ type: "text" as const, text: clampToolResultText(text) }], details: { error, ...producerTruncation(text) } };
}

export function createBlindSpecTool(input: {
  readonly log: EventLog;
  readonly sessionId: string;
  readonly openSession: (sessionId: string) => Promise<AcceptanceVerifierSession>;
}): AgentTool {
  return {
    name: "blind_spec",
    label: "blind spec",
    description:
      "Ask a fresh reader of the same model who sees only the order — never your plan or code — what would falsify an implementation. Returns BOUNDARIES / CONTRACT / COUNTEREXAMPLE / CHECK text.",
    parameters: {
      type: "object",
      properties: {
        order: { type: "string", description: "The operator order to review, verbatim." },
      },
      required: ["order"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const order = typeof (params as { order?: unknown }).order === "string" ? (params as { order: string }).order : "";
      if (!order) return textResult("blind_spec: order is required", true);
      const sessionId = `${input.sessionId}-blind-spec-${randomUUID()}`;
      let session: AcceptanceVerifierSession;
      try {
        session = await input.openSession(sessionId);
      } catch (error) {
        if (isRecoveryTerminalError(error)) throw error;
        return textResult(`blind_spec unavailable: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      try {
        const text = await streamFinalChunk(session.loop, buildAcceptanceSpecPrompt(order), { providerRole: "spec" });
        input.log.append({
          kind: "observe",
          name: "work/blind_spec",
          payload: { order_digest: sha256(order), text_digest: sha256(text), session: session.sessionId },
        });
        return textResult(text);
      } finally {
        await session.close();
      }
    },
  };
}

export const plugin: PluginModule = {
  id: "blind-spec-tool",
  claims: [
    // The route is read lazily per call: llm providers register after the
    // tool does, the same pattern model-loop-tools documents.
    { key: "llm", role: "consumer", optional: true },
    { key: "model_resilience", role: "consumer", optional: true },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
  ],
  register(ctx) {
    const tool = createBlindSpecTool({
      log: ctx.log,
      sessionId: ctx.sessionId,
      openSession: (sessionId) => {
        const route = ctx.llm?.activeName;
        if (!route) throw new Error("blind_spec requires an active llm route");
        const operation = ctx.tryGet<ModelResilienceService>("model_resilience")?.recovery.currentInput();
        return openAcceptanceVerifier({
          sessionId,
          ...(operation ? { recovery: { parentLog: ctx.log, operation, scope: "blind-spec" } } : {}),
          workspaceRoot: ctx.workspaceRoot,
          phase: "spec",
          manifestPath: resolve(REPO_ROOT, "plugins", "manifest.accept-spec.json"),
          repoRoot: REPO_ROOT,
          route,
        });
      },
    });
    const registry = ctx.inject<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.effect(() => {
      const dispose = registry.register(plugin.id, tool);
      return () => {
        void dispose();
      };
    });
  },
};
