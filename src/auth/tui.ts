import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { redactText } from "../host/redact.ts";
import type { AuthAccountStatus } from "./service.ts";

export interface TuiAuthCandidate {
  value: string;
  summary: string;
}

export interface TuiAuthView {
  prompt?: string;
  secret?: boolean;
  candidates?: readonly TuiAuthCandidate[];
  message?: string;
  /** Exact provider authorization URL. It remains memory-only but must not be
   * passed through generic query-parameter redaction or it becomes unusable. */
  authorizationUrl?: string;
}

export interface TuiAuthSessionOptions {
  onView: (view: TuiAuthView | undefined) => void;
  openUrl: (url: string) => boolean;
  signal?: AbortSignal;
}

/** Render provider-owned auth chrome while preserving only the exact URL
 * carried by the typed auth_url event. All free-form provider text retains
 * the ordinary operator-facing secret redaction policy. */
export function tuiAuthViewMessage(view: TuiAuthView): string | undefined {
  const message = view.message ? redactText(view.message) : undefined;
  const url = view.authorizationUrl ? `Sign-in URL: ${view.authorizationUrl}` : undefined;
  return [message, url].filter((value): value is string => value !== undefined).join(" ") || undefined;
}

export function authPickerCandidates(accounts: readonly AuthAccountStatus[]): TuiAuthCandidate[] {
  const candidates: TuiAuthCandidate[] = [];
  for (const account of accounts) {
    const state = account.connected
      ? `connected${account.credentialType ? ` via ${account.credentialType}` : ""}`
      : "not connected";
    const methods = account.methods
      .map((method) => `${method.label}${method.subscription ? " subscription" : ""}`)
      .join(" / ");
    candidates.push({
      value: account.route,
      summary: `${state} · ${methods} · ${account.modelCount} models`,
    });
    if (account.methods.length > 1) {
      for (const method of account.methods) {
        candidates.push({
          value: `${account.route}@${method.type}`,
          summary: `${method.label}${method.subscription ? " subscription" : ""} · ${state}`,
        });
      }
    }
  }
  return candidates;
}

export function parseAuthPickerChoice(choice: string): { route: string; method?: AuthType } {
  const [route = "", suffix, ...extra] = choice.trim().split("@");
  if (!route || extra.length > 0 || (suffix !== undefined && suffix !== "oauth" && suffix !== "api_key")) {
    throw new Error("choose a listed provider account or login method");
  }
  return { route, method: suffix as AuthType | undefined };
}

interface PendingPrompt {
  prompt: AuthPrompt;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  abort?: () => void;
}

/**
 * Memory-only bridge from Pi provider authentication to the live board.
 * Submitted values are resolved directly to the provider promise and are
 * never returned as notices, history entries, or EventLog payloads.
 */
export class TuiAuthSession implements AuthInteraction {
  readonly signal?: AbortSignal;
  private pending?: PendingPrompt;

  constructor(private readonly options: TuiAuthSessionOptions) {
    this.signal = options.signal;
  }

  // Pi normalizes provider interactions with `{ ...interaction, signal }`.
  // Keep protocol callbacks as own enumerable fields: prototype methods
  // disappear during that spread and break device-code providers at runtime.
  readonly prompt = (prompt: AuthPrompt): Promise<string> => {
    this.signal?.throwIfAborted();
    prompt.signal?.throwIfAborted();
    if (this.pending) return Promise.reject(new Error("authentication prompt already active"));
    return new Promise<string>((resolve, reject) => {
      const abort = () => this.cancel("authentication cancelled");
      const signal = prompt.signal ?? this.signal;
      signal?.addEventListener("abort", abort, { once: true });
      this.pending = { prompt, resolve, reject, abort: signal ? abort : undefined };
      this.options.onView(promptView(prompt));
    });
  };

  readonly notify = (event: AuthEvent): void => {
    this.options.onView({
      ...(this.pending ? promptView(this.pending.prompt) : {}),
      message: authEventMessage(event, this.options.openUrl),
      authorizationUrl: event.type === "auth_url" ? event.url : undefined,
    });
  };

  submit(value: string): void {
    const pending = this.pending;
    if (!pending) throw new Error("no authentication prompt is waiting");
    let answer = value.trim();
    if (pending.prompt.type === "select") {
      const numeric = Number(answer);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= pending.prompt.options.length) {
        answer = pending.prompt.options[numeric - 1]!.id;
      }
      if (!pending.prompt.options.some((option) => option.id === answer)) {
        throw new Error("invalid authentication selection");
      }
    }
    this.clearPending();
    pending.resolve(answer);
  }

  cancel(message = "authentication cancelled"): void {
    const pending = this.pending;
    this.clearPending();
    pending?.reject(new Error(message));
  }

  private clearPending(): void {
    const pending = this.pending;
    const signal = pending?.prompt.signal ?? this.signal;
    if (pending?.abort) signal?.removeEventListener("abort", pending.abort);
    this.pending = undefined;
    this.options.onView(undefined);
  }
}

function promptView(prompt: AuthPrompt): TuiAuthView {
  return {
    prompt: prompt.message,
    secret: prompt.type === "secret",
    candidates: prompt.type === "select"
      ? prompt.options.map((option) => ({
        value: option.id,
        summary: option.description ? `${option.label} — ${option.description}` : option.label,
      }))
      : undefined,
  };
}

function authEventMessage(event: AuthEvent, openUrl: (url: string) => boolean): string {
  if (event.type === "auth_url") {
    const opened = openUrl(event.url);
    const instruction = event.instructions ? ` ${event.instructions}` : "";
    return opened
      ? `Provider sign-in page opened.${instruction}`
      : `Open the provider sign-in page.${instruction}`;
  }
  if (event.type === "device_code") {
    return `Open ${event.verificationUri} and enter device code ${event.userCode}`;
  }
  if (event.type === "progress") return event.message;
  const links = (event.links ?? []).map((link) => `${link.label ?? "More information"}: ${link.url}`).join(" ");
  return links ? `${event.message} ${links}` : event.message;
}
