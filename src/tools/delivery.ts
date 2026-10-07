/**
 * THE PROJECTION STEP (#221 M1'): the one place a tool result becomes model
 * input as the result of a call the model made. The loop reports each such
 * result here with exactly the text the model is given (after redaction and
 * every appended line); a capability that must know what the model SAW — the
 * workspace version authority's read receipts — listens here, never at the
 * tool object (a prefetch, a probe or a host-side read runs the same tool
 * and is shown to no one). Tool-agnostic: the loop names no tool.
 */

export interface DeliveredToolResult {
  /** The session's event log object: listeners match their own session. */
  readonly session: object | undefined;
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  /** The text parts the model is given, joined. */
  readonly text: string;
  readonly hasImage: boolean;
  readonly isError: boolean;
}

type Listener = (delivery: DeliveredToolResult) => void;

const LISTENERS = new Set<Listener>();

export function onToolResultDelivered(listener: Listener): () => void {
  LISTENERS.add(listener);
  return () => LISTENERS.delete(listener);
}

/** Called by the loop at the projection step; a listener's failure is its own. */
export function toolResultDelivered(delivery: DeliveredToolResult): void {
  for (const listener of [...LISTENERS]) {
    try {
      listener(delivery);
    } catch {
      // A listener can neither change nor withhold what the model is given.
    }
  }
}

/** The text parts of a tool result, joined, and whether it carries an image. */
export function deliveredContent(content: readonly unknown[] | undefined): { readonly text: string; readonly hasImage: boolean } {
  let text = "";
  let hasImage = false;
  for (const part of content ?? []) {
    if (typeof part !== "object" || part === null) continue;
    const type = Reflect.get(part, "type");
    if (type === "text" && typeof Reflect.get(part, "text") === "string") text += Reflect.get(part, "text") as string;
    if (type === "image") hasImage = true;
  }
  return { text, hasImage };
}
