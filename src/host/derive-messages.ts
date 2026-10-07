import type { DerivedMessage, EventRecord } from "./schema.ts";

/**
 * Rebuild the model-visible transcript from the log.
 * Only `surface` events participate. Clock, host samples, and effects do not.
 */
export function deriveMessages(events: readonly EventRecord[]): DerivedMessage[] {
  const out: DerivedMessage[] = [];
  for (const event of events) {
    if (event.kind !== "surface") {
      continue;
    }
    const text = surfaceText(event);
    // #222 D2: a recorded model-input suffix is model-visible user input.
    if (event.name === "user/message" || event.name === "model_input/contribution") {
      out.push({ role: "user", text });
      continue;
    }
    if (event.name === "context/surface") {
      // #227: a host-context frame the model is shown — reference data with
      // host origin, never an operator order (docs/event-log.md). The row
      // references the frame's bytes by blob digest (§132 B2); the derived
      // message names that reference.
      const frame = typeof event.payload.frame_id === "string" ? event.payload.frame_id : "?";
      const blob = typeof event.payload.blob === "string" ? event.payload.blob : "missing";
      out.push({ role: "user", text: `[host context frame ${frame} sha256:${blob}]`, name: "context" });
      continue;
    }
    if (event.name === "assistant/message") {
      out.push({ role: "assistant", text });
      continue;
    }
    if (event.name === "tool/result") {
      const name = typeof event.payload.tool === "string" ? event.payload.tool : "tool";
      out.push({ role: "tool", text, name });
    }
  }
  return out;
}

export function deriveMessagesBytes(events: readonly EventRecord[]): string {
  return `${JSON.stringify(deriveMessages(events))}\n`;
}

function surfaceText(event: EventRecord): string {
  const text = event.payload.text;
  return typeof text === "string" ? text : "";
}
