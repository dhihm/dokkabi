import type { UiAction } from "./keymap.ts";

/** A large-carry model switch waiting on the operator's landing choice.
 * Returned by selectLiveModel instead of a notice string, so the board can
 * open a modal instead of a footer line an operator could read as an error. */
export interface HandoffConfirmation {
  kind: "handoff_confirmation";
  /** The route/model exactly as the operator chose it, for re-dispatch. */
  choice: string;
  route: string;
  model: string;
  afterMessages: number;
  afterTokens: number;
  contextWindow: number;
  /** Carried share of the destination's advertised window, whole percent. */
  percent: number;
}

export function isHandoffConfirmation(value: unknown): value is HandoffConfirmation {
  return typeof value === "object" && value !== null
    && (value as { kind?: unknown }).kind === "handoff_confirmation";
}

export interface HandoffPromptRoute {
  captured: boolean;
  action?: UiAction;
  dismiss?: boolean;
}

/** The TUI calls this before the ordinary editor/keymap while the MODEL
 * HANDOFF overlay is open. Unrecognised keys stay captured by the dialog;
 * SSH permission requests are routed earlier and keep precedence. */
export function routeHandoffPromptInput(
  prompt: HandoffConfirmation | undefined,
  key: string,
): HandoffPromptRoute {
  if (!prompt) return { captured: false };
  if (key === "\x03") return { captured: true, action: { type: "quit" } };
  if (key === "1") return { captured: true, action: { type: "route", text: `${prompt.choice} carry` } };
  if (key === "2") return { captured: true, action: { type: "route", text: `${prompt.choice} slim` } };
  if (key === "3" || key === "\x1b") return { captured: true, dismiss: true };
  return { captured: true };
}
