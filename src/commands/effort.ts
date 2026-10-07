import { resolveThinkingLevel, writeThinkingLevel } from "../host/thinking.ts";

export function runEffortCommand(args: readonly string[]): void {
  if (args.length > 1) throw new Error("usage: dokkabi effort [off|minimal|low|medium|high|xhigh|max]");
  const effort = args[0] === undefined ? resolveThinkingLevel() : writeThinkingLevel(args[0]);
  process.stdout.write(`effort=${effort}\n`);
}
