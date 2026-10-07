import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  captureSourceSnapshot,
  resultMatchesSnapshot,
  type FileFingerprint,
} from "./prefetch-file.ts";
import { boundedResultClone } from "./prefetch-result.ts";

export interface PrefetchedRead {
  readonly fingerprint: FileFingerprint;
  readonly result: AgentToolResult<unknown>;
}

export interface PrefetchAttempt {
  readonly active: Promise<void>;
  readonly result: Promise<PrefetchedRead | undefined>;
}

export function startPrefetch(input: {
  readonly sourceRead: AgentTool;
  readonly root: string;
  readonly path: string;
  readonly controller: AbortController;
  readonly timeoutMs: number;
  readonly maxSourceBytes: number;
}): PrefetchAttempt {
  const operation = Promise.resolve()
    .then(async () => {
      const snapshot = captureSourceSnapshot(input.root, input.path, input.maxSourceBytes);
      if (!snapshot || input.controller.signal.aborted) return undefined;
      const result = await input.sourceRead.execute(
        "speculative-prefetch",
        { path: input.path },
        input.controller.signal,
      );
      const cloned = boundedResultClone(result, input.maxSourceBytes);
      if (
        input.controller.signal.aborted || !cloned || resultHasError(cloned)
        || !resultMatchesSnapshot(snapshot, cloned)
      ) {
        return undefined;
      }
      return { fingerprint: snapshot.fingerprint, result: cloned };
    })
    .then((value) => value, () => undefined);
  return {
    active: operation.then(() => undefined),
    result: settleBeforeAbort(operation, input.controller, input.timeoutMs),
  };
}

async function settleBeforeAbort(
  operation: Promise<PrefetchedRead | undefined>,
  controller: AbortController,
  timeoutMs: number,
): Promise<PrefetchedRead | undefined> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    if (controller.signal.aborted) resolve(undefined);
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

function resultHasError(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return typeof details === "object" && details !== null
    && (details as Record<string, unknown>).error === true;
}
