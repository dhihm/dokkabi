import { renderPrompt } from "../../work/prompt-slots.ts";

export function frameBugfixOrder(input: {
  title: string;
  body: string;
}): string {
  return renderPrompt("swe/order.md", {
    title: input.title.trim(),
    body: input.body.trim().slice(0, 12_000),
  }).trimEnd();
}
