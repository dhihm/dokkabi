import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeModelInputText } from "../host/model-input.ts";

/**
 * Operator input into a RUNNING work loop (dashboard = TUI, wave 2).
 *
 * The EventLog has one writer: the loop. The dashboard therefore never
 * appends events — it appends lines to this inbox file, and the loop drains
 * the inbox at its next implement turn, folding the notes into the prompt it
 * already seals as user/message. What the model saw stays reconstructible
 * from the log alone (constitution 1); the inbox is transport, not record.
 */

/**
 * A note that is safe to put on the EventLog.
 *
 * The log refuses any payload that looks like a secret, and the check is
 * shape-based: "add Bearer authentication to the endpoint" matches the Bearer
 * pattern. Appending that raw threw, which killed the entire work loop — and
 * the inbox had already been consumed, so the note was gone for good. Masking
 * the matched span keeps the run alive, keeps the rest of the sentence, and
 * keeps what the model saw identical to what the log records (constitution 1).
 */
export function safeNoteText(text: string): string {
  return safeModelInputText(text).text;
}

export interface PendingNoteState {
  queued: number;
  inFlight: number;
}

/** Separate notes still queued from a batch already owned by a turn. */
export function pendingNoteState(sessionDir: string): PendingNoteState {
  const path = operatorInboxPath(sessionDir);
  return { queued: countLines(path), inFlight: countLines(`${path}.draining`) };
}

/** Compatibility total: every transport copy not yet committed. */
export function pendingNoteCount(sessionDir: string): number {
  const state = pendingNoteState(sessionDir);
  return state.queued + state.inFlight;
}

function countLines(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

export function operatorInboxPath(sessionDir: string): string {
  return join(sessionDir, "operator-inbox.jsonl");
}

/**
 * Remove the newest queued note and return its text. In-flight `.draining`
 * batches stay with the turn that already owns them.
 */
export function popOperatorMessage(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    rmSync(path, { force: true });
    return undefined;
  }
  const last = lines.pop()!;
  let note: string | undefined;
  try {
    const parsed = JSON.parse(last) as { text?: unknown };
    if (typeof parsed.text === "string" && parsed.text.length > 0) {
      note = parsed.text;
    }
  } catch {
    // A torn last line is dropped; remaining notes stay queued.
  }
  try {
    if (lines.length === 0) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    }
  } catch {
    return note;
  }
  return note;
}

/** Called by the dashboard process. Appends are atomic enough per line. */
export function pushOperatorMessage(path: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  // The note becomes an event payload and can carry anything the operator
  // typed, so it gets the session log's own permissions.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), text: trimmed })}\n`, { mode: 0o600 });
}

export interface TakenInbox {
  notes: string[];
  /** The turn delivered them: drop the staged file. */
  commit(): void;
  /** The turn failed before the model saw them: put them back. */
  rollback(): void;
}

/**
 * Two-phase drain.
 *
 * `drainOperatorInbox` deleted the notes before the model call, so a failure
 * between the two destroyed them with no way to re-deliver. Taking the inbox
 * stages it instead: the caller commits once the turn actually reached the
 * model, or rolls back and the notes wait for the next turn.
 */
export function takeOperatorInbox(path: string): TakenInbox {
  recoverStaged(path);
  if (!existsSync(path)) {
    return { notes: [], commit: () => {}, rollback: () => {} };
  }
  const taken = `${path}.draining`;
  try {
    renameSync(path, taken);
  } catch {
    return { notes: [], commit: () => {}, rollback: () => {} };
  }
  return {
    notes: parseNotes(taken),
    commit: () => rmSync(taken, { force: true }),
    rollback: () => {
      try {
        if (existsSync(path)) {
          // Notes arrived while this turn ran: keep both, oldest first.
          appendFileSync(path, readFileSync(taken, "utf8"), { mode: 0o600 });
          rmSync(taken, { force: true });
          return;
        }
        renameSync(taken, path);
      } catch {
        // Nothing else to try; the staged file stays for a human to find.
      }
    },
  };
}

/**
 * Put back a staging file left by a run that died between take and commit.
 *
 * Without this the note is stranded: nothing reads `.draining` again, the
 * board reports an empty queue, and the operator's instruction is lost with
 * no trace on screen. Recovered notes go in front of newer ones so the
 * ordering the operator wrote them in survives.
 */
function recoverStaged(path: string): void {
  const staged = `${path}.draining`;
  if (!existsSync(staged)) {
    return;
  }
  try {
    if (!existsSync(path)) {
      renameSync(staged, path);
      return;
    }
    const older = readFileSync(staged, "utf8");
    const newer = readFileSync(path, "utf8");
    writeFileSync(path, older.endsWith("\n") || older === "" ? older + newer : `${older}\n${newer}`, { mode: 0o600 });
    rmSync(staged, { force: true });
  } catch {
    // Leave the staged file for a human rather than losing it.
  }
}

/** Notes waiting in the inbox, including any stranded by a killed run. */
function parseNotes(path: string): string[] {
  const out: string[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { text?: unknown };
      if (typeof parsed.text === "string" && parsed.text.length > 0) {
        out.push(parsed.text);
      }
    } catch {
      // A torn write loses one line, never the drain.
    }
  }
  return out;
}

/**
 * Called by the work loop (single consumer). Rename-then-read: a message
 * appended after the rename lands in a fresh inbox and survives for the
 * next drain instead of being lost mid-read.
 */
export function drainOperatorInbox(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const taken = `${path}.draining`;
  try {
    renameSync(path, taken);
  } catch {
    return [];
  }
  try {
    const lines = readFileSync(taken, "utf8").split("\n");
    const out: string[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { text?: unknown };
        if (typeof parsed.text === "string" && parsed.text.length > 0) {
          out.push(parsed.text);
        }
      } catch {
        // A torn write loses one line, never the drain.
      }
    }
    return out;
  } finally {
    rmSync(taken, { force: true });
  }
}

/**
 * Fold operator notes into whatever prompt is about to be sent.
 *
 * The drain used to live inside the implement hook alone, so a note written
 * during decompose, a replan or acceptance waited for an implement turn that
 * might never come. Every model turn folds them now, which is what makes the
 * queue on the board bounded rather than open-ended.
 */
export function withOperatorNotes(notes: readonly string[], prompt: string): string {
  return `${operatorNotePreamble(notes)}${prompt}`;
}

/** The prompt prefix carrying drained notes into the next model turn. */
export function operatorNotePreamble(notes: readonly string[]): string {
  if (notes.length === 0) {
    return "";
  }
  const rows = notes.map((note) => `- ${note}`).join("\n");
  return `Operator note (mid-run, follow before continuing):\n${rows}\n\n`;
}
