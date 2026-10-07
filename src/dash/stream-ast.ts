import type { EventRecord } from "../host/schema.ts";
import { redactText } from "../host/redact.ts";
import { diffRowTone } from "../host/ssh-remote-diff.ts";
import { renderMarkdown } from "./markdown.ts";
import { wrapText, type Tone } from "./screen.ts";

/**
 * MODEL STREAM as a typed AST (issue #27, tiers 1–2).
 *
 * The raw source here is not a token stream — it is the EventLog, already
 * structured (constitution 1). Tier 1 therefore parses EVENTS into turn
 * blocks of typed nodes; tier 2 applies presentation policy (fold finished
 * thoughts, badge exits, truncate outputs, roll up a turn summary). Frozen
 * turns render once and memoize: a repaint re-renders only the active block.
 */

export interface BaseNode {
  id: string;
  timestamp: number;
  isStreaming: boolean;
}

export interface ThoughtNode extends BaseNode {
  type: "thought";
  content: string;
  durationMs?: number;
}

export interface ToolCallNode extends BaseNode {
  type: "tool_call";
  toolName: string;
  commandPreview: string;
  /** The argument text in full — what actually ran, not a clipped preview. */
  command?: string;
  callId: string;
  /** Unified diff lines for write/edit. */
  diffLines?: string[];
  /** Overrides the default lane tone — a stalled wait reads dimmer. */
  tone?: Tone;
}

export interface ToolResultNode extends BaseNode {
  type: "tool_result";
  callId: string;
  error: boolean;
  output: string;
  durationMs?: number;
  truncated: boolean;
}

export interface NarrativeNode extends BaseNode {
  type: "narrative";
  markdown: string;
}

/** The operator's own message: a conversation is both halves (#37). */
export interface UserNode extends BaseNode {
  type: "user";
  content: string;
}

/** Host-owned lifecycle output. It is deliberately not a narrative node:
 * compaction is a Dokkabi fact, never something the model claimed. */
export interface HostStatusNode extends BaseNode {
  type: "host_status";
  phase: "running" | "done" | "skipped" | "warning" | "info";
  message: string;
}

export interface TurnSummaryNode extends BaseNode {
  type: "turn_summary";
  turnNumber: number;
  stats: { reads: number; writes: number; edits: number; commands: number; durationMs: number };
}

export type StreamNode =
  | ThoughtNode
  | ToolCallNode
  | ToolResultNode
  | NarrativeNode
  | UserNode
  | HostStatusNode
  | TurnSummaryNode;

export interface TurnBlock {
  turn: number;
  frozen: boolean;
  /** Identity for the memo cache: the seq of the last event in this block. */
  lastSeq: number;
  nodes: StreamNode[];
}

const RESULT_TAIL_LINES = 2;
const ACTIVE_THOUGHT_LINES = 4;

function ts(event: EventRecord): number {
  const at = Date.parse(event.ts);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * The whole argument text. `argPreview` clips to 48 characters, which turns a
 * heredoc or a multi-line script into something an operator cannot identify,
 * let alone re-run.
 */
function fullCommand(payload: Record<string, unknown>): string {
  const args = payload.args;
  if (typeof args === "object" && args !== null) {
    const rec = args as Record<string, unknown>;
    for (const key of ["command", "cmd", "path", "file", "pattern", "query"]) {
      const value = rec[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    const parts = Object.entries(rec)
      .filter(([key]) => key !== "edits")
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  return typeof payload.arg_hint === "string" ? payload.arg_hint : "";
}

function argPreview(payload: Record<string, unknown>): string {
  const args = payload.args;
  if (typeof args === "object" && args !== null) {
    const parts = Object.entries(args as Record<string, unknown>)
      .slice(0, 2)
      .map(([key, value]) => {
        const flat = typeof value === "string" ? value : JSON.stringify(value);
        return `${key}=${String(flat).replaceAll("\n", " ").slice(0, 48)}`;
      });
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  return typeof payload.arg_hint === "string" ? payload.arg_hint : "";
}

/** Tier 1: EventLog → turn blocks of typed nodes. Pure. */
/**
 * `startTurn` keeps the numbering honest when the caller hands in a tail.
 *
 * The stream pane shows twenty rows and used to build every turn of the whole
 * session to get them -- 786ms on a live 118,000-event log, ten times what the
 * projection costs. It builds a tail now, and a tail that renumbered its turns
 * from one would relabel `turn 95` as `turn 3`.
 */
export function buildTurnBlocks(
  events: readonly EventRecord[],
  startTurn = 0,
): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  let current: TurnBlock | undefined;
  let turn = startTurn;
  let run = 0;
  let cooperativeDeadline = false;
  let compaction: { before?: number; target?: number; after?: number; dropped?: number } | undefined;
  const toolDurations = new Map<string, number>();
  for (const event of events) {
    if (event.name === "tool/end" && typeof event.payload.duration_ms === "number") {
      const id = typeof event.payload.id === "string" ? event.payload.id : "";
      toolDurations.set(id, event.payload.duration_ms);
    }
  }

  const open = (at: EventRecord): TurnBlock => {
    turn += 1;
    const block: TurnBlock = { turn, frozen: false, lastSeq: at.seq, nodes: [] };
    blocks.push(block);
    return block;
  };
  const freeze = (block: TurnBlock, at: EventRecord): void => {
    block.frozen = true;
    block.lastSeq = at.seq;
    for (const node of block.nodes) {
      node.isStreaming = false;
      if (node.type === "tool_result" && node.durationMs === undefined) {
        node.durationMs = toolDurations.get(node.callId);
      }
    }
    const first = block.nodes[0];
    const start = first ? first.timestamp : ts(at);
    block.nodes.push({
      type: "turn_summary",
      id: `turn-${block.turn}-summary-${at.seq}`,
      timestamp: ts(at),
      isStreaming: false,
      turnNumber: block.turn,
      stats: summarize(block.nodes, ts(at) - start),
    });
  };
  const hostStatus = (
    at: EventRecord,
    phase: HostStatusNode["phase"],
    message: string,
  ): void => {
    // A host lifecycle between turns belongs after the latest turn boundary,
    // but must not create a fake model turn. Before the first turn, use a
    // permanently frozen turn-zero carrier that the first user message leaves.
    if (!current) {
      current = { turn: 0, frozen: true, lastSeq: at.seq, nodes: [] };
      blocks.push(current);
    }
    current.lastSeq = at.seq;
    current.nodes.push({
      type: "host_status",
      id: `host-status-${at.seq}`,
      timestamp: ts(at),
      isStreaming: phase === "running",
      phase,
      message,
    });
  };

  for (const event of events) {
    if (["review/task", "review/audit", "review/audit_confirmation", "review/finished", "review/live", "review/snapshot_binding", "review/report_write", "review/report_result", "loop/completion_continue", "loop/completion_incomplete"].includes(event.name)) {
      const verdict=["APPROVE","REQUEST_CHANGES","COMMENT"].includes(String(event.payload.verdict))?String(event.payload.verdict):"recorded";
      const label=event.name==="loop/completion_continue"?`Automatic completion recovery ${Number(event.payload.round)}`
        :event.name==="loop/completion_incomplete"?"Completion checkpoint exhausted: incomplete"
        :`${event.name.slice(7)} ${verdict}`;
      hostStatus(event,event.name==="loop/completion_incomplete"?"warning":event.name==="review/report_result"?"done":"running",label);
      continue;
    }
    if (event.name === "work/case_decision") {
      const status = safeStatus(String(event.payload.status ?? "unavailable"));
      hostStatus(event, status === "green" ? "done" : "warning",
        `case ${safeStatus(String(event.payload.id ?? "unknown"))} ${status} · ${safeStatus(String(event.payload.reason ?? "unknown"))}`);
      continue;
    }
    if (event.name === "work/execution_start" || event.name === "work/execution_end" || event.name === "work/resume_grant") {
      hostStatus(event, event.name === "work/execution_start" ? "running" : "info",
        `${event.name.slice(5)} · ${safeStatus(String(event.payload.status ?? event.payload.phase ?? "recorded"))} · protection=${safeStatus(String(event.payload.protection ?? "role"))}`);
      continue;
    }
    if (event.name === "work/runner_result") {
      const outcome = event.payload.outcome as { kind?: string; reason?: string } | undefined;
      hostStatus(event, outcome?.kind === "passed" ? "done" : "warning",
        `native case ${safeStatus(String(event.payload.case_id))} · ${safeStatus(outcome?.kind ?? "incomplete")} · ${safeStatus(outcome?.reason ?? "")} · level=workspace_reported`);
      continue;
    }
    if (event.name === "work/case" && event.payload.evidence_source === "protected_observer"
      && (event.payload.status === "green" || event.payload.status === "red")) {
      const status = event.payload.status;
      hostStatus(event, status === "green" ? "done" : "warning", `measured case ${safeStatus(String(event.payload.id ?? "unknown"))} ${status} · level=attested · receipt validated`);
      continue;
    }
    if (event.name === "work/obligations") {
      hostStatus(event, "info", `obligation revision ${event.payload.revision} retained; scope ${event.payload.scope_seq}`);
      continue;
    }
    if (event.name === "work/authority_patch" || event.name === "work/authority_materialized" || event.name === "work/authority_refused") {
      hostStatus(event, event.name === "work/authority_refused" ? "warning" : "info",
        `${event.name.slice(5)}: ${event.payload.reason ?? event.payload.digest ?? "recorded"}`);
      continue;
    }
    if (event.name === "measurement/result") {
      const status = safeStatus(String(event.payload.status ?? "unknown"));
      const level = safeStatus(String(event.payload.evidence_level ?? "unknown"));
      const number = (value: unknown): string => typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "missing";
      const work = `${number(event.payload.correct_elements)}/${number(event.payload.requested_elements)}`;
      const witness = safeStatus(String(event.payload.witness_status ?? "unknown"));
      const uncertainty = safeStatus(String(event.payload.uncertainty ?? "unknown"));
      hostStatus(event, status === "passed" ? "done" : "warning", `measurement sample ${status} · requested_level=${level} · checked=${work} · elapsed_ms=${number(event.payload.elapsed_ms)} · witnesses=${witness} · scope=${uncertainty} · execution validation follows`);
      continue;
    }
    if (event.name === "measurement/refused" || event.name === "work/measurement_refused") {
      hostStatus(event, "warning", `measurement ${safeStatus(String(event.payload.status ?? "refused"))} · ${safeStatus(String(event.payload.reason_code ?? "unknown"))}`);
      continue;
    }
    if (event.name === "measurement/session" || event.name === "measurement/source" || event.name === "measurement/boundary" || event.name === "measurement/challenge" || event.name === "measurement/process") {
      hostStatus(event, event.name === "measurement/session" ? "running" : "info", `measurement ${event.name.slice(12)} retained`);
      continue;
    }
    if (event.name === "fixture/execution") {
      hostStatus(event, "warning", `fixture execution evaluator_error · ${safeStatus(String(event.payload.reason_code ?? "unknown"))}`);
      continue;
    }
    if (event.name === "fixture/environment") {
      hostStatus(event, "info", "fixture environment retained");
      continue;
    }
    if (event.name === "fixture/revoked") {
      hostStatus(event, "warning", "fixture revoked");
      continue;
    }
    if (event.name === "fixture/source" || event.name === "fixture/candidate") {
      hostStatus(event, "info", event.name === "fixture/source" ? "fixture source retained" : "fixture candidate retained");
      continue;
    }
    if (event.name === "fixture/enrolled" || event.name === "fixture/preparing") {
      const preparing = event.name === "fixture/preparing";
      hostStatus(event, preparing ? "running" : "info", `fixture ${preparing ? "preparing" : "enrolled"} · visibility=${safeStatus(String(event.payload.visibility ?? "unknown"))}`);
      continue;
    }
    if (event.name === "fixture/preparation") {
      const status = safeStatus(String(event.payload.status ?? "unknown"));
      const count = (value: unknown): string => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "missing";
      const reason = typeof event.payload.reason_code === "string" ? ` · ${safeStatus(event.payload.reason_code)}` : "";
      const cleanup = typeof event.payload.cleanup_reason_code === "string" ? ` · cleanup=${safeStatus(event.payload.cleanup_reason_code)}` : "";
      hostStatus(event, status === "prepared" ? "done" : "warning", `fixture ${status} · paths=${count(event.payload.completed_count)}/${count(event.payload.attempted_count)} · bytes=${count(event.payload.bytes_written)} · verified=${count(event.payload.bytes_verified)}${reason}${cleanup}`);
      continue;
    }
    if (event.name === "fixture/cleanup" || event.name === "fixture/integrity") {
      const status = safeStatus(String(event.payload.status ?? "unknown"));
      const reason = typeof event.payload.reason_code === "string" ? ` · ${safeStatus(event.payload.reason_code)}` : "";
      hostStatus(event, status === "completed" || status === "passed" ? "done" : "warning", `fixture ${event.name.slice(8)} ${status}${reason}`);
      continue;
    }
    if (event.name === "evidence/decision") {
      const status = safeStatus(String(event.payload.status ?? "unknown"));
      const level = safeStatus(String(event.payload.evidence_level ?? "unknown"));
      const audience = safeStatus(String(event.payload.audience ?? "unknown"));
      hostStatus(event, status === "admissible" ? "done" : "warning", `evidence ${status} · level=${level} · audience=${audience}`);
      continue;
    }
    if (event.name === "evaluation/refused") {
      hostStatus(event, "warning", `evaluation refused · ${safeStatus(String(event.payload.reason_code ?? "unknown"))}`);
      continue;
    }
    if (event.name === "provider/input_refused") {
      const stage = safeStatus(String(event.payload.stage ?? "unknown"));
      const detail = typeof event.payload.detail_hint === "string" ? redactText(event.payload.detail_hint) : "input could not be retained";
      hostStatus(event, "warning", `model input refused · stage=${stage} · ${detail}`);
      continue;
    }
    // #221: what the version authority refused, what it could not resolve,
    // and the guarantee each decision was made under — never stronger than
    // `checked_native` (external writers are detected, not mediated).
    if (event.name === "workspace/mutation_refused" || event.name === "workspace/mutation_reconciled") {
      const path = typeof event.payload.path === "string"
        ? redactText(event.payload.path).replace(/[\u0000-\u001f\u007f]/gu, "?").slice(0, 120)
        : "(path withheld)";
      const scope = `${safeStatus(String(event.payload.guarantee ?? "unknown"))}/${safeStatus(String(event.payload.binding ?? "unknown"))}`;
      if (event.name === "workspace/mutation_refused") {
        hostStatus(event, "warning", `${safeStatus(String(event.payload.tool ?? "write"))} refused · ${safeStatus(String(event.payload.code ?? "unknown"))} · ${path} · untouched · ${scope}`);
      } else if (event.payload.outcome === "unresolved") {
        const live = typeof event.payload.live === "string" ? ` · live=${safeStatus(event.payload.live)}` : "";
        hostStatus(event, "warning", `mutation unresolved · ${path}${live} · not retried · ${scope}`);
      }
      continue;
    }
    if (event.name === "tool/output_redacted") {
      const count = numberField(event.payload.redacted_strings);
      hostStatus(event, "warning", `tool output redacted before model input · strings=${count ?? "unknown"}`);
      continue;
    }
    if (event.name === "model/turn_budget") {
      if (event.payload.decision === "defer") {
        cooperativeDeadline = false;
        hostStatus(
          event,
          "running",
          "generation slice elapsed · finishing active tool before validation",
        );
        continue;
      }
      cooperativeDeadline =
        event.payload.decision === "abort" && event.payload.policy === "continue";
      continue;
    }
    if (event.name === "compaction/start" && event.payload.reason !== "in_turn") {
      compaction = {
        ...(numberField(event.payload.estimated_tokens) !== undefined
          ? { before: numberField(event.payload.estimated_tokens) }
          : {}),
        ...(numberField(event.payload.budget_tokens) !== undefined
          ? { target: numberField(event.payload.budget_tokens) }
          : {}),
      };
      hostStatus(
        event,
        "running",
        `compacting context${tokenFact(compaction.before, " used")}${tokenFact(compaction.target, " target", true)}`,
      );
      continue;
    }
    if (event.name === "compaction/plan") {
      // The plan refines the following drop; start and completion are the
      // operator-facing lifecycle so a fast compaction does not flood STREAM.
      continue;
    }
    if (event.name === "compaction/drop" && event.payload.in_turn !== true) {
      compaction = {
        ...compaction,
        ...(numberField(event.payload.kept_tokens) !== undefined
          ? { after: numberField(event.payload.kept_tokens) }
          : {}),
        ...(numberField(event.payload.dropped_messages) !== undefined
          ? { dropped: numberField(event.payload.dropped_messages) }
          : {}),
      };
      hostStatus(
        event,
        "running",
        `context reduced${tokenTransition(compaction.before, compaction.after)}${messageCount(compaction.dropped)} · sealing checkpoint`,
      );
      continue;
    }
    if (event.name === "prompt/seal" && event.payload.reason === "compaction") {
      // Recovery may append a seal only to close an already-observed drop
      // after restoring the old transcript. `compaction/end recovered` clears
      // this state so that integrity close cannot be presented as a commit.
      if (compaction) {
        hostStatus(
          event,
          "done",
          `context compaction complete${tokenTransition(compaction.before, compaction.after)}${messageCount(compaction.dropped)}`,
        );
      }
      compaction = undefined;
      continue;
    }
    if (event.name === "compaction/end") {
      const status = typeof event.payload.status === "string" ? event.payload.status : "ended";
      if (status === "nothing_to_drop") {
        hostStatus(event, "skipped", "context compaction skipped · no older complete turns available");
      } else if (status === "recovered") {
        hostStatus(event, "warning", "interrupted context compaction recovered · previous transcript restored");
      } else {
        hostStatus(event, "info", `context compaction ended · status=${safeStatus(status)}`);
      }
      compaction = undefined;
      continue;
    }
    if (event.name === "context/slim" || event.name === "context/prune") {
      const before = numberField(event.payload.before_tokens);
      const after = numberField(event.payload.after_tokens);
      const dropped = numberField(event.payload.dropped_messages);
      const action = event.name === "context/slim" ? "slimmed" : "pruned";
      hostStatus(
        event,
        "info",
        `active-turn context ${action}${tokenTransition(before, after)}${messageCount(dropped)}`,
      );
      continue;
    }
    if (event.name === "work/run_result") {
      const label = event.payload.heung === true ? "HEUNG" : "work";
      const recordedStatus = typeof event.payload.status === "string" ? event.payload.status : "unknown";
      const acceptanceStatus = event.payload.accepted === false && recordedStatus === "done"
        ? event.payload.stop_reason === "acceptance_inconclusive"
          ? "acceptance_inconclusive"
          : "acceptance_rejected"
        : recordedStatus;
      const status = safeStatus(acceptanceStatus);
      const stop = typeof event.payload.stop_reason === "string"
        ? safeStatus(event.payload.stop_reason)
        : undefined;
      if (event.payload.outcome === "completed") {
        hostStatus(event, "done", `${label} work complete`);
      } else if (event.payload.outcome === "incomplete") {
        if (status === "acceptance_rejected" || status === "acceptance_inconclusive") {
          hostStatus(event, "skipped", `${label} acceptance stopped · status=${status}`);
        } else {
          hostStatus(
            event,
            "skipped",
            `${label} paused · status=${status}${stop ? ` · stop=${stop}` : ""} · remaining work is shown in WORK`,
          );
        }
      }
      continue;
    }
    if (event.name === "session/open") {
      // One session/open per TUI process (constitution 5 keeps it in the log,
      // so live and replay renumber identically). Turn numbers are for the
      // operator's orientation in the current run — after a 17-hour session
      // the divider read "turn 1147" on a freshly restarted board. EVENTS seq
      // remains the durable cross-run reference.
      run += 1;
      if (run > 1) {
        if (current && !current.frozen) {
          freeze(current, event);
        }
        current = undefined;
        turn = 0;
        hostStatus(event, "info", `TUI run ${run} started — turn numbers restart at 1`);
      }
      continue;
    }
    if (event.name === "agent/step" && event.payload.phase === "turn_start") {
      if (current && !current.frozen) {
        freeze(current, event);
      }
      current = open(event);
      continue;
    }
    if (event.name === "agent/step" && (event.payload.phase === "turn_end" || event.payload.phase === "end")) {
      if (current && !current.frozen) {
        freeze(current, event);
      }
      continue;
    }
    if (event.name === "user/message") {
      const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
      if (!text) {
        continue;
      }
      // The operator's message opens its own block: their half of the
      // conversation is as much the stream as the reply (field feedback).
      if (!current || current.frozen) {
        current = open(event);
      }
      current.lastSeq = event.seq;
      current.nodes.push({
        type: "user",
        id: `user-${event.seq}`,
        timestamp: ts(event),
        isStreaming: false,
        content: text,
      });
      continue;
    }
    if (!current || current.frozen) {
      if (
        event.name !== "assistant/message" &&
        event.name !== "tool/call" &&
        event.name !== "tool/result" &&
        event.name !== "chat/turn_failed"
      ) {
        continue;
      }
      current = open(event);
    }
    current.lastSeq = event.seq;
    const payload = event.payload;
    if (event.name === "chat/turn_failed") {
      const raw = typeof payload.reason === "string" ? payload.reason : "unknown failure";
      const reason = redactText(raw).replace(/\s+/g, " ").trim();
      current.nodes.push({
        type: "narrative",
        id: `turn-failed-${event.seq}`,
        timestamp: ts(event),
        isStreaming: false,
        markdown: `turn failed — ${reason}`,
      });
      continue;
    }
    if (event.name === "assistant/message") {
      const thinking = typeof payload.thinking === "string" ? payload.thinking.trim() : "";
      if (thinking) {
        current.nodes.push({
          type: "thought",
          id: `thought-${event.seq}`,
          timestamp: ts(event),
          isStreaming: true,
          content: thinking,
        });
      }
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const stop = typeof payload.stop === "string" ? payload.stop : "";
      const cooperativeAbort = stop === "aborted" && cooperativeDeadline;
      cooperativeDeadline = false;
      // toolUse / tool_calls: the next tool/call *is* the reply. Do not paint
      // "said nothing" over the thought + tool box.
      if (text) {
        current.nodes.push({
          type: "narrative",
          id: `say-${event.seq}`,
          timestamp: ts(event),
          isStreaming: true,
          markdown: text,
        });
      } else if (cooperativeAbort) {
        current.nodes.push({
          type: "narrative",
          id: `say-${event.seq}`,
          timestamp: ts(event),
          isStreaming: true,
          markdown: "generation slice ended; validating artifacts",
        });
      } else if (stop !== "toolUse" && stop !== "tool_calls") {
        current.nodes.push({
          type: "narrative",
          id: `say-${event.seq}`,
          timestamp: ts(event),
          isStreaming: true,
          markdown: emptyReplyLabel(payload),
        });
      }
      continue;
    }
    if (event.name === "tool/call") {
      const callId = typeof payload.id === "string" ? payload.id : `call-${event.seq}`;
      current.nodes.push({
        type: "tool_call",
        id: callId,
        callId,
        timestamp: ts(event),
        isStreaming: true,
        toolName: typeof payload.name === "string" ? payload.name : "tool",
        commandPreview: argPreview(payload),
        command: fullCommand(payload),
        diffLines: fileDiffLines(payload),
      });
      continue;
    }
    if (event.name === "ssh/wait_progress") {
      // A wait that shows nothing is indistinguishable from a dead one. The
      // probe already said how far along the job is; put that on screen, and
      // dim a repeating probe so a stall reads at a glance.
      const target = typeof payload.target === "string" ? payload.target : "remote";
      const detail = typeof payload.detail === "string" ? payload.detail : "";
      current.nodes.push({
        type: "tool_call",
        id: `wait-${event.seq}`,
        callId: `wait-${event.seq}`,
        timestamp: ts(event),
        isStreaming: false,
        toolName: `wait ${target}`,
        commandPreview: detail,
        command: "",
        tone: payload.changed === false ? "muted" : "lane",
      });
      continue;
    }
    if (event.name === "ssh/diff") {
      // A change made over ssh renders like a local edit: the harness cannot
      // otherwise say what moved on the other machine.
      const target = typeof payload.target === "string" ? payload.target : "remote";
      const files = Array.isArray(payload.files) ? payload.files : [];
      const stat = files.map((entry) => {
        const file = entry as { path?: unknown; added?: unknown; removed?: unknown; binary?: unknown };
        const path = typeof file.path === "string" ? file.path : "?";
        return file.binary === true
          ? `~ ${path} (binary)`
          : `~ ${path} +${Number(file.added) || 0} -${Number(file.removed) || 0}`;
      });
      const hunks = Array.isArray(payload.hunks)
        ? payload.hunks.filter((line): line is string => typeof line === "string")
        : [];
      const more = typeof payload.more_files === "number" && payload.more_files > 0
        ? [`~ …(+${payload.more_files} more files)`]
        : [];
      current.nodes.push({
        type: "tool_call",
        id: `sshdiff-${event.seq}`,
        callId: `sshdiff-${event.seq}`,
        timestamp: ts(event),
        isStreaming: false,
        toolName: `ssh diff ${target}`,
        commandPreview: "",
        command: "",
        diffLines: [...stat, ...more, ...hunks],
      });
      continue;
    }
    if (event.name === "tool/result") {
      const callId = typeof payload.id === "string" ? payload.id : "";
      const text = typeof payload.text === "string" ? payload.text : "";
      current.nodes.push({
        type: "tool_result",
        id: `result-${event.seq}`,
        timestamp: ts(event),
        isStreaming: false,
        callId,
        error: payload.error === true,
        output: text,
        durationMs: toolDurations.get(callId),
        truncated: typeof payload.blob === "string",
      });
    }
  }
  return blocks;
}

function emptyReplyLabel(payload: Record<string, unknown>): string {
  const stop = typeof payload.stop === "string" ? payload.stop : "";
  if (stop === "error") {
    const error = typeof payload.error === "string" ? redactText(payload.error).replace(/\s+/g, " ").trim() : "";
    if (error === "empty_completion") {
      return "turn failed — provider returned no content; retry, switch model, or allow failover";
    }
    return error ? `turn failed — ${error}` : "turn failed";
  }
  return stop ? `said nothing (stop=${stop})` : "said nothing";
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const scaled = value / 1_000;
  return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
}

function tokenFact(value: number | undefined, label: string, prefix = false): string {
  return value === undefined
    ? ""
    : prefix
      ? ` · ${label.trim()} ${formatTokens(value)}`
      : ` · ${formatTokens(value)}${label}`;
}

function tokenTransition(before: number | undefined, after: number | undefined): string {
  if (before === undefined && after === undefined) return "";
  if (before === undefined) return ` · ${formatTokens(after!)} retained`;
  if (after === undefined) return ` · from ${formatTokens(before)}`;
  return ` · ${formatTokens(before)}→${formatTokens(after)}`;
}

function messageCount(value: number | undefined): string {
  return value === undefined ? "" : ` · dropped ${value} message${value === 1 ? "" : "s"}`;
}

function safeStatus(value: string): string {
  return /^[a-z0-9_-]{1,32}$/i.test(value) ? value : "unknown";
}

function summarize(nodes: readonly StreamNode[], durationMs: number): TurnSummaryNode["stats"] {
  const stats = { reads: 0, writes: 0, edits: 0, commands: 0, durationMs: Math.max(0, durationMs) };
  for (const node of nodes) {
    if (node.type !== "tool_call") {
      continue;
    }
    if (node.toolName === "read" || node.toolName === "grep" || node.toolName === "glob" || node.toolName === "ls") {
      stats.reads += 1;
    } else if (node.toolName === "write") {
      stats.writes += 1;
    } else if (node.toolName === "edit") {
      stats.edits += 1;
    } else {
      stats.commands += 1;
    }
  }
  return stats;
}

export interface StreamLine {
  text: string;
  tone: Tone;
  /** Per-cell tones, for a line where one span differs from the rest. */
  cells?: Tone[];
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;

export function spinnerFrame(elapsedMs: number): string {
  // 100 ms per glyph matches the paint cadence, so the spinner advances
  // roughly one glyph per paint instead of beating against the sampler.
  return SPINNER[Math.floor(elapsedMs / 100) % SPINNER.length]!;
}

function fmtSecs(ms: number | undefined): string {
  if (typeof ms !== "number" || ms < 0) {
    return "";
  }
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtChars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

const THOUGHT_MAX_LINES = 10;

/** Tier 2: one node → policy-shaped lines. Frozen thoughts fold to a badge;
 * results carry exit badges and a bounded output tail. */
export function renderNode(node: StreamNode, width: number, frozen: boolean): StreamLine[] {
  const w = Math.max(8, width);
  if (node.type === "user") {
    // The operator's half: ❯ marks input the way the prompt does. Wrapping the
    // whole body as one string threw its newlines away, so a multi-line order
    // arrived on screen as "…덤프THIS IS THE IMPLEMENT TURN.Edit the product…"
    // — every rule run into the one before it. Wrap each source line on its
    // own, and keep blank lines so paragraphs stay apart.
    const lines: StreamLine[] = [];
    for (const source of node.content.split(/\r?\n/u)) {
      if (source.trim().length === 0) {
        lines.push({ text: "❯", tone: "user" as Tone });
        continue;
      }
      for (const line of wrapText(source, w - 4)) {
        lines.push({ text: `❯ ${line}`, tone: "user" as Tone });
      }
    }
    return lines.length > 0 ? lines : [{ text: "❯", tone: "user" as Tone }];
  }
  if (node.type === "host_status") {
    const presentation: Record<HostStatusNode["phase"], { glyph: string; tone: Tone }> = {
      running: { glyph: "⟳", tone: "spin" },
      done: { glyph: "✓", tone: "ok" },
      skipped: { glyph: "•", tone: "muted" },
      warning: { glyph: "!", tone: "ember" },
      info: { glyph: "↻", tone: "lane" },
    };
    const { glyph, tone } = presentation[node.phase];
    return wrapText(node.message, Math.max(4, w - 2)).map((line, index) => ({
      text: `${index === 0 ? glyph : "│"} ${line}`,
      tone,
    }));
  }
  if (node.type === "thought") {
    const wrapped = wrapText(node.content.replaceAll("\n", " "), w - 2);
    const body = wrapped.slice(-THOUGHT_MAX_LINES);
    const title = frozen || wrapped.length > THOUGHT_MAX_LINES
      ? `▶ thought (${fmtChars(node.content.length)} chars)`
      : "thinking:";
    return [
      { text: title, tone: "thought" },
      ...body.map((line) => ({ text: `│ ${line}`, tone: "thought" as Tone })),
    ];
  }
  if (node.type === "tool_call") {
    const head: StreamLine = {
      text: `⚡ ${node.toolName} ${node.commandPreview}`.trimEnd().slice(0, w),
      tone: node.tone ?? "lane",
    };
    // A remote diff is a standalone observation — it has no paired result to
    // hang its hunks on, so it paints them here.
    if ((node.diffLines?.length ?? 0) > 0) {
      return [
        head,
        ...(node.diffLines ?? []).map((row) => ({
          text: row.slice(0, w).padEnd(w),
          tone: diffRowTone(row) as Tone,
        })),
      ];
    }
    return [head];
  }
  if (node.type === "tool_result") {
    const badge = node.error ? "❌" : "✔";
    const secs = fmtSecs(node.durationMs);
    const head: StreamLine = {
      text: `  ${badge}${node.error ? " exit≠0" : ""}${secs ? ` ${secs}` : ""}${node.truncated ? " (truncated)" : ""}`,
      tone: node.error ? "bad" : "ok",
    };
    const rows = node.output
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const tail = rows.slice(-RESULT_TAIL_LINES).map((line) => ({
      text: `  ${line.slice(0, w - 2)}`,
      tone: (node.error ? "bad" : "muted") as Tone,
    }));
    // A green result's body is noise once the turn froze; failures keep it.
    if (frozen && !node.error) {
      return [head];
    }
    return [head, ...tail];
  }
  if (node.type === "narrative") {
    if (node.markdown.startsWith("said nothing")) {
      return [{ text: `dokkabi ❯ ${node.markdown}`, tone: "muted" }];
    }
    // The reply is the one place a model writes markup, and it wrote it for
    // a reason: the path, the regex, the command it wants looked at.
    const lines: StreamLine[] = [{ text: "dokkabi ❯", tone: "title" }];
    for (const line of renderMarkdown(node.markdown, w)) {
      // Never dim a finished reply: what the model said stays the most
      // important thing in the pane long after its turn closed.
      lines.push(line as StreamLine);
    }
    return lines;
  }
  // The turn boundary IS the summary: a rule carrying the same facts costs
  // one row where a summary line plus its blank neighbours cost three.
  const stats = node.stats;
  const bits = [
    stats.reads > 0 ? `read ${stats.reads}` : "",
    stats.writes > 0 ? `write ${stats.writes}` : "",
    stats.edits > 0 ? `edit ${stats.edits}` : "",
    stats.commands > 0 ? `ran ${stats.commands}` : "",
    fmtSecs(stats.durationMs),
  ].filter((bit) => bit.length > 0);
  const label = ` turn ${node.turnNumber}${bits.length > 0 ? ` · ${bits.join(" · ")} ` : " "}`;
  const rule = "─".repeat(Math.max(0, w - label.length - 2));
  return [{ text: `──${label}${rule}`, tone: "muted" }];
}

/** Frozen turns render once per (lastSeq, width, content): the repaint cost
 * of the pane is the active block only (issue #27 turn-block isolation). */
const frozenMemo = new Map<string, StreamLine[]>();

/**
 * What a block would draw, folded to one short token.
 *
 * (turn, lastSeq, width) is not unique across logs. Two sessions reach turn 3
 * at the same seq — the ordinary case for any fresh run — so the memo handed
 * the second session the first one's lines and the pane showed a turn that
 * never happened. Content decides the key, so a collision is now two blocks
 * that really do draw the same thing.
 *
 * Length plus both ends of each text, not the whole text: the memo exists to
 * keep a frozen block off the repaint path, and hashing every byte of every
 * turn on every frame would cost more than the render it saves.
 */
function blockFingerprint(nodes: readonly StreamNode[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const node of nodes) {
    mix(node.type);
    mix(node.id);
    const text =
      node.type === "thought"
        ? node.content
        : node.type === "user"
          ? node.content
          : node.type === "narrative"
            ? node.markdown
            : node.type === "host_status"
              ? `${node.phase}\u0000${node.message}`
            : node.type === "tool_call"
            ? `${node.toolName}\u0000${node.command ?? node.commandPreview}`
            : node.type === "tool_result"
              ? `${node.error ? "!" : ""}${node.output}`
              : `${node.turnNumber}\u0000${node.stats.commands}\u0000${node.stats.durationMs}`;
    mix(String(text.length));
    mix(text.slice(0, 32));
    mix(text.slice(-32));
  }
  return (hash >>> 0).toString(36);
}

function streamGroup(type: StreamNode["type"]): "thought" | "say" | "tool" | "status" | "summary" {
  if (type === "thought") {
    return "thought";
  }
  if (type === "narrative") {
    return "say";
  }
  if (type === "host_status") {
    return "status";
  }
  if (type === "turn_summary") {
    return "summary";
  }
  return "tool";
}

function renderNodes(nodes: readonly StreamNode[], width: number, frozen: boolean): StreamLine[] {
  const unused = new Set(
    nodes.flatMap((node, index) => (node.type === "tool_result" ? [index] : [])),
  );
  const lines: StreamLine[] = [];
  // Blocks announce themselves — `▶ thought`, `dokkabi ❯`, `● bash` — but a
  // thought box running straight into the reply under it reads as one wall of
  // text. One blank line between blocks is enough to part them. The turn rule
  // is already a break, so it takes none on either side: a rule with blank
  // neighbours costs three rows to say what one row said.
  let group: ReturnType<typeof streamGroup> | null = null;
  const push = (chunk: StreamLine[], next: ReturnType<typeof streamGroup>): void => {
    if (lines.length > 0 && next !== "summary" && group !== "summary") {
      lines.push({ text: "", tone: "muted" });
    }
    group = next;
    lines.push(...chunk);
  };
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    if (node.type === "tool_result") {
      continue;
    }
    if (node.type === "tool_call") {
      const pairAt = nodes.findIndex(
        (candidate, index) =>
          unused.has(index) && candidate.type === "tool_result" && candidate.callId === node.callId,
      );
      if (pairAt >= 0) {
        const result = nodes[pairAt] as Extract<StreamNode, { type: "tool_result" }>;
        unused.delete(pairAt);
        push(renderToolPair(node, result, width), "tool");
        continue;
      }
    }
    push(renderNode(node, width, frozen), streamGroup(node.type));
  }
  return lines;
}


/** Command lines a call may show before it is folded. */
const COMMAND_MAX_LINES = 6;
/** Output lines kept for a green call, and for a failing one. */
const OUTPUT_LINES_OK = 1;
const OUTPUT_LINES_ERR = 4;

/**
 * One tool call as one block.
 *
 * The header names the tool and carries the verdict right-aligned; the command
 * follows in full under `│`, and the output tail under `└`. The previous form
 * put a 48-character slice of the command on the header line and dropped the
 * output of anything that succeeded, so the pane could not answer either
 * "what did it run" or "what came back".
 */
function renderToolPair(
  call: Extract<StreamNode, { type: "tool_call" }>,
  result: Extract<StreamNode, { type: "tool_result" }>,
  width: number,
): StreamLine[] {
  const inner = Math.max(8, width);
  const badge = result.error ? "❌" : "✔";
  const secs = fmtSecs(result.durationMs);
  const verdict = `${badge}${result.error ? " exit≠0" : ""}${secs ? ` ${secs}` : ""}${
    result.truncated ? " (truncated)" : ""
  }`;
  const path = filePathFromPreview(call);
  const isFileChange = call.toolName === "edit"
    || call.toolName === "write"
    || call.toolName.startsWith("ssh diff ");
  const name = isFileChange && path ? `${call.toolName} ${path}` : call.toolName;
  const head = `● ${name}`;
  // Right-align the verdict so a column of calls reads as a column of results.
  const gap = Math.max(1, inner - visualLength(head) - visualLength(verdict));
  const lines: StreamLine[] = [
    { text: `${head}${" ".repeat(gap)}${verdict}`.slice(0, inner), tone: result.error ? "bad" : "ok" },
  ];

  if (isFileChange && (call.diffLines?.length ?? 0) > 0) {
    for (const row of call.diffLines ?? []) {
      lines.push({ text: row.slice(0, inner).padEnd(inner), tone: diffRowTone(row) as Tone });
    }
    return lines;
  }

  const command = (call.command && call.command.length > 0 ? call.command : call.commandPreview).trim();
  if (command.length > 0) {
    const rows = command.split("\n").flatMap((row) => wrapText(row, Math.max(4, inner - 2)));
    for (const row of rows.slice(0, COMMAND_MAX_LINES)) {
      lines.push({ text: `│ ${row}`, tone: "lane" });
    }
    if (rows.length > COMMAND_MAX_LINES) {
      lines.push({ text: `│ …(+${rows.length - COMMAND_MAX_LINES} lines)`, tone: "muted" });
    }
  }

  const rows = result.output
    .trim()
    .split("\n")
    .filter((row) => row.trim().length > 0);
  const keep = result.error ? OUTPUT_LINES_ERR : OUTPUT_LINES_OK;
  const tail = rows.slice(-keep);
  for (let i = 0; i < tail.length; i += 1) {
    const marker = i === 0 ? "└" : " ";
    lines.push({
      text: `${marker} ${tail[i]!}`.slice(0, inner),
      tone: result.error ? "bad" : "muted",
    });
  }
  return lines;
}

function visualLength(text: string): number {
  let width = 0;
  for (const glyph of text) {
    width += glyph.codePointAt(0)! > 0x2000 ? 1 : 1;
  }
  return width;
}


function filePathFromPreview(call: Extract<StreamNode, { type: "tool_call" }>): string | undefined {
  const match = /(?:path=)?([\w./-]+\.[\w]+)/.exec(call.commandPreview);
  return match?.[1];
}

function fileDiffLines(payload: Record<string, unknown>): string[] | undefined {
  const args = payload.args;
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const rec = args as Record<string, unknown>;
  const lines: string[] = [];
  const edits = rec.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits.slice(0, 4)) {
      if (!edit || typeof edit !== "object") {
        continue;
      }
      const oldText = (edit as { oldText?: unknown }).oldText;
      const newText = (edit as { newText?: unknown }).newText;
      if (typeof oldText === "string") {
        for (const row of oldText.split("\n").slice(0, 6)) {
          lines.push(`- ${row}`);
        }
      }
      if (typeof newText === "string") {
        for (const row of newText.split("\n").slice(0, 6)) {
          lines.push(`+ ${row}`);
        }
      }
    }
    return lines.length > 0 ? lines.slice(0, 16) : undefined;
  }
  if (typeof rec.content === "string" && rec.content.length > 0) {
    for (const row of rec.content.split("\n").slice(0, 8)) {
      lines.push(`+ ${row}`);
    }
    return lines;
  }
  return undefined;
}

export function renderTurnBlock(block: TurnBlock, width: number): StreamLine[] {
  const key = `${block.turn}:${block.lastSeq}:${width}:${blockFingerprint(block.nodes)}`;
  if (block.frozen) {
    const hit = frozenMemo.get(key);
    if (hit) {
      return hit;
    }
  }
  const lines = renderNodes(block.nodes, width, block.frozen);
  if (block.frozen) {
    if (frozenMemo.size > 512) {
      frozenMemo.clear();
    }
    frozenMemo.set(key, lines);
  }
  return lines;
}
