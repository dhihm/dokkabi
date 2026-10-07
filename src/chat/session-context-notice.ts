import type { Api, Model } from "@earendil-works/pi-ai";
import {
  agentTranscriptPath,
  inspectAgentTranscript,
  type AgentTranscriptMismatchReason,
} from "../host/agent-transcript.ts";
import { frozenPrefixHash, systemPromptHash, toolSchemaHash } from "../host/prefix.ts";
import { containsPrivateInfrastructure, redactText } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";
import type { HostContext, LlmFacade } from "../loader/types.ts";
import { WORK_LEDGER_DISCIPLINE, workLedgerDigestText } from "../work/ledger-digest.ts";

export interface SessionContinuityNotice {
  /** Return the operator text, prefixed once with the fresh-context notice
   * when a stored transcript exists but will not restore. */
  fold(text: string): Promise<string>;
}

/**
 * The host knows when a saved session transcript cannot be carried into a new
 * process (session/resume fresh_start), but the model would otherwise meet a
 * bare "continue" with no idea that it is missing history — and go rebuild it
 * from the workspace on its own. Fold that fact into the first chat turn's
 * text before appendUserMessage records it, so the recorded user/message stays
 * exactly what the model saw (constitution 1) and the model can answer
 * honestly that the prior context was not carried over.
 */
export function createSessionContinuityNotice(input: {
  ctx: HostContext;
  llm: LlmFacade;
  pluginManifestDigest: string;
}): SessionContinuityNotice {
  let decided = false;
  return {
    async fold(text) {
      if (decided) return text;
      let inspected: ReturnType<typeof inspectAgentTranscript>;
      try {
        const route = input.llm.active();
        const model = await route.resolveModel(input.llm.activeModelId) as Model<Api>;
        if (!model || typeof model.id !== "string" || !model.id) return text;
        inspected = inspectAgentTranscript(agentTranscriptPath(input.ctx.log.path), {
          prefix_hash: frozenPrefixHash({
            systemPrompt: input.ctx.systemPrompt,
            toolSchemas: input.ctx.toolSchemas,
          }),
          system_prompt_hash: systemPromptHash(input.ctx.systemPrompt),
          tool_schema_hash: toolSchemaHash(input.ctx.toolSchemas),
          plugin_manifest_digest: input.pluginManifestDigest,
          model_id: model.id,
          route: route.name,
        });
      } catch {
        // The route was not ready to name a model; decide on the next turn.
        return text;
      }
      decided = true;
      if (inspected.restored) return text;
      const parts: string[] = [];
      if (inspected.reason !== "transcript_missing" && inspected.stored_messages > 0) {
        parts.push(sessionContinuityPreamble(inspected.stored_messages, inspected.reason));
      } else {
        // The fresh-start contract archives the transcript aside before the
        // first turn, so the file is missing here — but the conversation
        // existed. The log's session/fresh_start row keeps the disclosure
        // honest: the model is told what it is not remembering.
        const archived = lastFreshStartArchive(input.ctx.log.events);
        if (archived > 0) {
          parts.push(sessionContinuityPreamble(archived, "fresh start — resume was not requested"));
        }
      }
      // Log-derived orientation: what the recent runs on this session were
      // doing (orders, ssh aliases), so a terse follow-up order neither sends
      // the model brute-forcing aliases nor lets it silently "continue" work
      // it no longer remembers.
      const recent = recentRunsDigest(input.ctx.log.events);
      if (recent) parts.push(recent);
      // Every fresh context — carried-over or brand-new — learns the recorded
      // work position, so a bare continuation neither re-explores nor claims
      // progress beyond the ledger.
      const ledger = workLedgerDigestText(input.ctx.workspaceRoot);
      if (ledger) parts.push(`${ledger}\n${WORK_LEDGER_DISCIPLINE}`);
      if (parts.length === 0) return text;
      return `${parts.join("\n\n")}\n\n${text}`;
    },
  };
}

/** The newest session/fresh_start archive size, or 0 when none is recorded. */
function lastFreshStartArchive(events: readonly EventRecord[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.name !== "session/fresh_start") continue;
    const count = event.payload.archived_messages;
    return typeof count === "number" ? count : 0;
  }
  return 0;
}

const RECENT_ORDERS = 3;
const RECENT_ALIASES = 6;

/**
 * Log-derived orientation for a fresh context: the last operator orders and
 * the ssh aliases the earlier runs on this session actually used. Without it
 * a terse follow-up ("다시 A 작업") met a blank model that brute-forced ssh
 * aliases turn after turn, or — worse — silently "continued" the previous
 * run's work as if it remembered it. The digest is explicitly framed as
 * labels, not memory: the current instruction is the only task, and any
 * referenced earlier work must be re-verified before building on it.
 */
export function recentRunsDigest(events: readonly EventRecord[]): string | undefined {
  let lastOpen = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.name === "session/open") {
      lastOpen = i;
      break;
    }
  }
  if (lastOpen <= 0) return undefined;
  const prior = events.slice(0, lastOpen);
  const orders: string[] = [];
  const aliases: string[] = [];
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const event = prior[i]!;
    if (event.name === "user/message" && orders.length < RECENT_ORDERS) {
      const raw = typeof event.payload.text === "string" ? event.payload.text : "";
      const safe = redactText(raw).replace(/\s+/gu, " ").trim().slice(0, 120);
      if (safe && !containsPrivateInfrastructure(safe)) orders.push(safe);
    }
    if (event.name === "ssh/exec" && aliases.length < RECENT_ALIASES) {
      const target = event.payload.target;
      if (typeof target === "string" && target && !aliases.includes(target)) aliases.push(target);
    }
    if (orders.length >= RECENT_ORDERS && aliases.length >= RECENT_ALIASES) break;
  }
  if (orders.length === 0 && aliases.length === 0) return undefined;
  const lines = ["Recent runs on this session (log-derived orientation — NOT your memory):"];
  if (orders.length > 0) {
    lines.push(`- recent operator orders (newest first): ${orders.map((order) => `"${order}"`).join(" · ")}`);
  }
  if (aliases.length > 0) {
    lines.push(`- ssh aliases recently used: ${aliases.join(", ")}`);
  }
  lines.push(
    "These are labels for the operator's references, not work you remember doing. "
    + "Your task is solely the instruction below — do not continue or merge in any "
    + "earlier order unless the instruction names it, and when it does, re-verify "
    + "the actual current state (remote hosts, files, ledger) before building on it.",
  );
  return lines.join("\n");
}

/** The prompt prefix disclosing a fresh context to the model. */
export function sessionContinuityPreamble(
  storedMessages: number,
  reason: AgentTranscriptMismatchReason | string,
): string {
  return "Session notice (host, first turn of a fresh context): "
    + `a prior conversation for this session (${storedMessages} messages) `
    + `was not carried into your context (${reason}). You have no memory of it. `
    + "If the operator asks to continue earlier work, say plainly that the prior "
    + "context was not carried over and ask what to work on, or suggest "
    + "\"/resume --reseed\" to rebuild it. Do not reconstruct the missing "
    + "history by exploring the workspace on your own.";
}
