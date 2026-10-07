import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingBudgets } from "@earendil-works/pi-ai";
import {
  appendEvidenceReview,
  evidenceWarning,
  reviewEvidence,
} from "../host/evidence.ts";
import type { EventLog } from "../host/event-log.ts";
import { redactText } from "../host/redact.ts";
import { MODEL_RETRY_BACKOFF_MS } from "../host/model-failover.ts";
import type { ToolBudgetFinalizerCall } from "../loader/types.ts";
import type { ToolScope } from "../loader/tool-profiles.ts";

export interface VoiceLoop {
  prompt(
    text: string,
    options?: {
      modelId?: string;
      onAssistant?: (text: string) => void;
      thinkingLevel?: ThinkingLevel;
      thinkingBudgets?: ThinkingBudgets;
      providerRole?: string;
      maxOutputTokens?: number;
      timeoutMs?: number;
      timeoutPolicy?: "fail" | "continue";
      maxToolCalls?: number;
      toolBudgetFinalizers?: readonly string[];
      toolBudgetFinalizerCalls?: readonly ToolBudgetFinalizerCall[];
      toolScope?: ToolScope;
    },
  ): Promise<void>;
}

const TRANSIENT_STREAM_ERROR = /websocket|1006|fetch failed|econnreset|etimedout|econnrefused|socket hang up|network|timed? ?out|timeout|stream ended without (?:a )?stop reason|429|rate.?limit|too many requests|internal server error|bad gateway|service unavailable|upstream error|overloaded|502|503|504/i;
const RATE_LIMIT_ERROR = /429|rate.?limit|too many requests/i;
const SERVER_ERROR = /internal server error|bad gateway|service unavailable|upstream error|overloaded|502|503|504/i;
/** OpenRouter can open a successful SSE response, then inject a provider 502
 * into that stream. Its normalized client error may retain only this message,
 * with neither the numeric status nor provider_unavailable metadata. */
const STREAMED_PROVIDER_OUTAGE = /json error injected into sse stream|provider[_ -]?unavailable|network connection lost/i;

function isTransientStreamError(message: string): boolean {
  return TRANSIENT_STREAM_ERROR.test(message) || STREAMED_PROVIDER_OUTAGE.test(message);
}

function isTransientServerError(message: string): boolean {
  return SERVER_ERROR.test(message) || STREAMED_PROVIDER_OUTAGE.test(message);
}

export const RATE_LIMIT_BACKOFF_MS = MODEL_RETRY_BACKOFF_MS;

export const backoffBetween = async (ms: readonly number[]): Promise<void> => {
  for (const delay of ms) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};

export interface TransientRetryOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (info: { readonly attempt: number; readonly delayMs: number; readonly reason: string }) => void;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  retries = 1,
  options: TransientRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => backoffBetween([ms]));
  const maxAttempts = 1 + Math.max(retries, RATE_LIMIT_BACKOFF_MS.length);
  let last: unknown;
  let transportFailures = 0;
  let rateFailures = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isTransientStreamError(message)) {
        throw error;
      }
      if (RATE_LIMIT_ERROR.test(message) || isTransientServerError(message)) {
        if (rateFailures >= RATE_LIMIT_BACKOFF_MS.length) {
          throw error;
        }
        const delayMs = RATE_LIMIT_BACKOFF_MS[rateFailures];
        if (delayMs === undefined) {
          throw error;
        }
        rateFailures += 1;
        options.onRetry?.({ attempt: rateFailures, delayMs, reason: redactText(message) });
        await sleep(delayMs);
        continue;
      }
      transportFailures += 1;
      if (transportFailures > retries) {
        throw error;
      }
      options.onRetry?.({ attempt: transportFailures, delayMs: 0, reason: redactText(message) });
    }
  }
  throw last;
}

export function reportEvidence(input: {
  readonly log: EventLog;
  readonly text: string;
  readonly stage: string;
  readonly print: (text: string) => void;
}): void {
  const review = reviewEvidence({ text: input.text, events: input.log.events });
  appendEvidenceReview(input.log, review, input.stage);
  const warning = evidenceWarning(review);
  if (warning) {
    input.print(warning);
  }
}

export async function streamFinalChunk(
  loop: VoiceLoop,
  text: string,
  options: {
    readonly modelId?: string;
    readonly print?: (text: string) => void;
    readonly thinkingLevel?: ThinkingLevel;
    readonly thinkingBudgets?: ThinkingBudgets;
    readonly providerRole?: string;
    readonly maxOutputTokens?: number;
    readonly timeoutMs?: number;
    readonly timeoutPolicy?: "fail" | "continue";
    readonly maxToolCalls?: number;
    readonly toolBudgetFinalizers?: readonly string[];
  } = {},
): Promise<string> {
  let pending: string | undefined;
  await loop.prompt(text, {
    modelId: options.modelId,
    thinkingLevel: options.thinkingLevel,
    thinkingBudgets: options.thinkingBudgets,
    providerRole: options.providerRole,
    maxOutputTokens: options.maxOutputTokens,
    timeoutMs: options.timeoutMs,
    timeoutPolicy: options.timeoutPolicy,
    maxToolCalls: options.maxToolCalls,
    toolBudgetFinalizers: options.toolBudgetFinalizers,
    onAssistant: (chunk) => {
      if (pending !== undefined) {
        options.print?.(pending);
      }
      pending = chunk;
    },
  });
  return pending ?? "";
}
