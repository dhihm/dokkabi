import type { AgentTool } from "@earendil-works/pi-agent-core";

const OWNED_WAIT = Symbol("plugin-owned-bounded-wait");
const registered = new WeakSet<object>();
type WaitTool = AgentTool & { [OWNED_WAIT]?: (args: unknown) => number | undefined };

/** Host-only capability preserved by tool wrappers' object spread. The plugin
 * verifies current ownership, liveness and bounded waiting. */
export function withOwnedBoundedWait<T extends AgentTool>(tool: T, ownsWait: (args: unknown) => number | undefined): T {
  registered.add(ownsWait);
  return { ...tool, [OWNED_WAIT]: ownsWait };
}

export function ownedBoundedWaitMs(tool: AgentTool | undefined, args: unknown): number | undefined {
  const check = (tool as WaitTool | undefined)?.[OWNED_WAIT];
  if (typeof check !== "function" || !registered.has(check)) return undefined;
  const milliseconds = check(args);
  return typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds > 0
    ? milliseconds : undefined;
}
