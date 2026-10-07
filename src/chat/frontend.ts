import { operatorInboxPath, popOperatorMessage, pushOperatorMessage, takeOperatorInbox } from "../work/inbox.ts";
import { isOperatorAbort } from "./turn-failure.ts";

/**
 * Frontend Seam for the interactive CLI (#37, T1).
 *
 * The TUI never reads kernel memory and never appends to the EventLog. A
 * note typed into the always-open prompt crosses this seam as text only —
 * no scroll, focus, or zoom state travels with it (constitution 1).
 *
 * Where a note goes follows the existing transport contract:
 * - idle kernel: the note opens a prompt turn. Staged inbox notes from a
 *   previous busy turn are folded above it, and the two-phase drain from
 *   `work/inbox.ts` commits only when the turn actually ran (the model saw
 *   the folded text) and rolls back when it did not.
 * - busy kernel: the note stages into the operator inbox, exactly like the
 *   attach-mode board, and the running loop drains it at its next turn.
 * - empty note: nothing happens anywhere.
 */

/** The durable user/message row a turn's text actually occupies. Supplied by
 * the starter when the model-facing record was verified in another process
 * (an owned work child); ordinary same-process turns record it themselves
 * before their accepted callback runs. */
export interface ChatFrontendMessageRef {
  readonly seq: number;
  readonly hash: string;
}

export interface ChatFrontendHooks {
  /** Session directory whose operator inbox backs the busy path. */
  sessionDir: string;
  /** Opens one model turn with the folded prompt text. The accepted callback
   * receives the verified durable row reference when the turn's input was
   * recorded by an owned work child; ordinary turns call it with no argument
   * right after their own appendUserMessage. */
  startTurn(text: string, onAccepted: (message?: ChatFrontendMessageRef) => void): Promise<void> | void;
  /**
   * A turn that threw. The TUI owns the alt-screen, so the seam reports the
   * failure here instead of writing to stderr mid-frame; the rolled-back
   * notes are already waiting in the inbox for the next attempt.
   */
  onError(error: unknown): void;
  /** Stop the in-flight kernel or work child. Optional on attach boards. */
  abortTurn?: () => void;
  /**
   * Optional turn lifecycle hooks (R2 desktop workbench). All are plain
   * observers over the existing submit path: the inbox, acceptance and
   * rollback semantics below are unchanged. A hook that throws before the
   * turn starts refuses the turn the same way a throwing startTurn does;
   * settlement observers that throw are reported through onError after the
   * turn's own outcome is settled.
   */
  onTurnStart?(turn: ChatFrontendTurn): void;
  /** Fires once, after the model-facing record of this turn is durable. */
  onTurnAccepted?(turn: ChatFrontendTurn): void;
  /** Fires once when the turn ends, after its own durable record. */
  onTurnSettled?(turn: ChatFrontendTurn & { outcome: ChatFrontendTurnOutcome; error?: unknown }): void;
}

export interface ChatFrontendTurn {
  /** The folded text the turn actually opened with. */
  readonly text: string;
  /** Correlation id supplied by an R2 workbench submit, if any. */
  readonly commandId?: string;
  /** The verified durable user/message row this turn's text occupies, when
   * the starter supplied it (owned work children). Never inferred here. */
  readonly message?: ChatFrontendMessageRef;
}

export type ChatFrontendTurnOutcome = "success" | "failure" | "operator_abort";

export type NoteDelivery = "prompt" | "inbox" | "ignored";

export interface ChatFrontend {
  /** Routes one submitted note. Synchronous: called from the key handler. */
  submitNote(text: string, options?: { commandId?: string }): NoteDelivery;
  /** True while a turn this frontend opened is still running. */
  busy(): boolean;
  /** Abort the running turn if any. */
  abortTurn(): boolean;
  /** Close admission before host disposal. Pending notes survive reconnect. */
  stop(): void;
  /** Pop the newest queued note. Does not start a turn. */
  popQueuedNote(): string | undefined;
}

export function createChatFrontend(hooks: ChatFrontendHooks): ChatFrontend {
  let busy = false;
  let stopped = false;

  const inboxPath = operatorInboxPath(hooks.sessionDir);
  // Diagnostic observers cannot undo durable settlement or prevent its pump.
  // Acceptance and settlement observers retain their authoritative failure path.
  const reportError = (error: unknown): void => {
    try { hooks.onError(error); } catch { /* The turn's recorded outcome remains authoritative. */ }
  };

  const openTurn = (taken: ReturnType<typeof takeOperatorInbox>, fresh?: string, commandId?: string): void => {
    const parts = fresh === undefined ? taken.notes : [...taken.notes, fresh];
    if (parts.length === 0) {
      taken.commit();
      return;
    }
    const folded = parts.join("\n\n");
    let accepted = false;
    // The once-only acceptance boundary. The starter calls it after the
    // model-facing user/message record is durable (appendUserMessage, or the
    // parent-verified durable row of an owned work child, passed as the
    // message reference) and before route readiness, so an observer throwing
    // here refuses the model request instead of being swallowed. A turn that
    // later fails or aborts keeps this acceptance: the model-facing input WAS
    // recorded.
    const acknowledge = (message?: ChatFrontendMessageRef) => {
      if (accepted) return;
      accepted = true;
      taken.commit();
      try {
        hooks.onTurnAccepted?.({ text: folded, commandId, ...(message ? { message } : {}) });
      } catch (error) {
        stopped = true;
        throw error;
      }
    };
    busy = true;
    // Settlement is emitted only after its durable record. A settlement
    // observer that throws leaves the outcome visibly uncertain: the error is
    // reported through onError and no follow-on queued turn is pumped as if
    // the log were healthy.
    let settledDurably = false;
    const settleTurn = (outcome: ChatFrontendTurnOutcome, error?: unknown): void => {
      if (!hooks.onTurnSettled) {
        settledDurably = true;
        return;
      }
      try {
        hooks.onTurnSettled({ text: folded, commandId, outcome, ...(error !== undefined ? { error } : {}) });
        settledDurably = true;
      } catch (recordError) {
        stopped = true;
        reportError(recordError);
      }
    };
    // A synchronous throw from startTurn — or from the turn-start observer,
    // which runs before any model request — must take the same rejection
    // path as an async one: the turn never starts, the notes roll back and
    // the failure settles visibly.
    let outcome: Promise<void>;
    try {
      hooks.onTurnStart?.({ text: folded, commandId });
      outcome = Promise.resolve(hooks.startTurn(folded, acknowledge));
    } catch (error) {
      outcome = Promise.reject(error);
    }
    void outcome.then(
      () => {
        // Small test and adapter seams may not acknowledge explicitly. A
        // successfully resolved turn is necessarily accepted; an acceptance
        // observer throwing on this fallback path settles as failure.
        try {
          acknowledge();
        } catch (error) {
          settleTurn("failure", error);
          busy = false;
          if (!isOperatorAbort(error)) reportError(error);
          return;
        }
        settleTurn("success");
        busy = false;
        // Only a durably settled turn may pump the next queued one. A failed
        // settlement write leaves the log unhealthy; starting another turn
        // on top of it would present an unrecorded request as success.
        if (settledDurably) queueMicrotask(pumpPending);
      },
      (error: unknown) => {
        if (!accepted) {
          taken.rollback();
          if (fresh !== undefined && !isOperatorAbort(error)) {
            pushOperatorMessage(inboxPath, fresh);
          }
        }
        settleTurn(isOperatorAbort(error) ? "operator_abort" : "failure", error);
        busy = false;
        if (!isOperatorAbort(error)) reportError(error);
        if (accepted && settledDurably) queueMicrotask(pumpPending);
      },
    );
  };

  const pumpPending = (): void => {
    if (busy || stopped) return;
    const taken = takeOperatorInbox(inboxPath);
    if (taken.notes.length === 0) {
      taken.commit();
      return;
    }
    openTurn(taken);
  };

  const frontend: ChatFrontend = {
    busy: () => busy,
    stop() { stopped = true; },
    abortTurn() {
      if (!busy) return false;
      hooks.abortTurn?.();
      return true;
    },
    popQueuedNote() {
      return popOperatorMessage(inboxPath);
    },
    submitNote(text: string, options?: { commandId?: string }): NoteDelivery {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return "ignored";
      }
      if (busy || stopped) {
        pushOperatorMessage(inboxPath, trimmed);
        return "inbox";
      }
      openTurn(takeOperatorInbox(inboxPath), trimmed, options?.commandId);
      return "prompt";
    },
  };

  // A stopped frontend may leave a durable inbox behind. Resume it without
  // requiring the operator to submit an unrelated extra note.
  queueMicrotask(pumpPending);
  return frontend;
}
