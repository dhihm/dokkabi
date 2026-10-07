import type { Api, Model } from "@earendil-works/pi-ai";
import {
  agentTranscriptPath,
  inspectAgentTranscript,
  type AgentTranscriptExpectation,
} from "../host/agent-transcript.ts";
import { frozenPrefixHash, systemPromptHash, toolSchemaHash } from "../host/prefix.ts";
import { reseedAgentTranscript, sessionReseedMaxBytes } from "../host/session-resume.ts";
import type { HostContext, LlmFacade, LoopFacade } from "../loader/types.ts";

export interface LiveSessionResumeControl {
  control(command: string): Promise<string>;
}

/** Live-chat control for inspecting or explicitly reseeding the current session. */
export function createLiveSessionResumeControl(input: {
  ctx: HostContext;
  llm: LlmFacade;
  loop: LoopFacade;
  pluginManifestDigest: string;
}): LiveSessionResumeControl {
  const surface = async (): Promise<{
    expectation: AgentTranscriptExpectation;
    contextWindow: number;
  }> => {
    const route = input.llm.active();
    const model = await route.resolveModel(input.llm.activeModelId) as Model<Api>;
    if (!model || typeof model.id !== "string" || !model.id) {
      throw new Error("current model identity is unavailable");
    }
    if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
      throw new Error("current model context window is unavailable");
    }
    const expectation = {
      prefix_hash: frozenPrefixHash({
        systemPrompt: input.ctx.systemPrompt,
        toolSchemas: input.ctx.toolSchemas,
      }),
      system_prompt_hash: systemPromptHash(input.ctx.systemPrompt),
      tool_schema_hash: toolSchemaHash(input.ctx.toolSchemas),
      plugin_manifest_digest: input.pluginManifestDigest,
      model_id: model.id,
      route: route.name,
    };
    return { expectation, contextWindow: model.contextWindow };
  };

  return {
    async control(command) {
      const normalized = command.trim().toLowerCase().replace(/\s+/gu, " ");
      if (normalized !== "" && normalized !== "status" && normalized !== "--reseed") {
        throw new Error("usage: /resume [--reseed]");
      }
      const current = await surface();
      const path = agentTranscriptPath(input.ctx.log.path);
      const inspected = inspectAgentTranscript(path, current.expectation);
      if (normalized !== "--reseed") return formatInspection(inspected);

      const reseed = reseedAgentTranscript({
        log: input.ctx.log,
        transcriptPath: path,
        expectation: current.expectation,
        maxBytes: sessionReseedMaxBytes(input.ctx.systemPrompt, input.ctx.toolSchemas, current.contextWindow),
        reason: inspected.restored ? "operator_requested" : inspected.reason,
        ...(!inspected.restored && inspected.mismatches ? { mismatches: inspected.mismatches } : {}),
      });
      if (!reseed.saved) throw new Error("session reseed could not persist safe non-empty history");
      const verified = inspectAgentTranscript(path, current.expectation);
      if (!verified.restored) throw new Error(`session reseed verification failed: ${verified.reason}`);
      input.loop.invalidateSurface();
      input.ctx.log.append({
        kind: "observe",
        name: "session/resume",
        payload: {
          restored: true,
          messages: verified.stored_messages,
          source: "event-log-reseed",
        },
      });
      return `resume=reseeded messages=${verified.stored_messages} dropped=${reseed.dropped_messages}; the next message will use the rebuilt context`;
    },
  };
}

function formatInspection(inspected: ReturnType<typeof inspectAgentTranscript>): string {
  if (inspected.restored) return `resume=restored messages=${inspected.stored_messages} source=agent.json`;
  const mismatches = inspected.mismatches?.length ? inspected.mismatches.join(",") : "unknown";
  return `resume=not-restored stored=${inspected.stored_messages} reason=${inspected.reason} mismatches=${mismatches} — /resume --reseed`;
}
