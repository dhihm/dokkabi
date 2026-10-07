import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceBashReuseRegistration } from "./workspace-bash-reuse.ts";

type Terminal = AgentTool["execute"];

const registered = new WeakSet<AgentTool>();
const revoked = new WeakSet<AgentTool>();
const aliasRegistrars = new WeakMap<AgentTool, WorkspaceBashReuseRegistration["registerAlias"]>();

export function registerWorkspaceBashResultTool(
  tool: AgentTool,
  registerAlias?: WorkspaceBashReuseRegistration["registerAlias"],
): () => void {
  registered.add(tool);
  if (registerAlias) aliasRegistrars.set(tool, registerAlias);
  return () => revoked.add(tool);
}

export interface WorkspaceBashResultAuthority {
  project(surface: AgentTool, terminal: Terminal): AgentTool | undefined;
}

export function createWorkspaceBashResultAuthority(
  available: readonly AgentTool[],
  projected: readonly AgentTool[],
): WorkspaceBashResultAuthority | undefined {
  const bash = available.filter((tool) => tool.name === "bash" && registered.has(tool) && !revoked.has(tool));
  const bound = bash[0];
  if (bash.length !== 1 || !bound || !projected.includes(bound)) return undefined;
  return Object.freeze<WorkspaceBashResultAuthority>({
    project(surface, terminal) {
      if (surface !== bound || revoked.has(bound)) return undefined;
      const alias: AgentTool = { ...surface, execute: (id, args, signal, update) => revoked.has(bound)
        ? surface.execute(id, args, signal, update)
        : terminal(id, args, signal, update) };
      aliasRegistrars.get(bound)?.(alias);
      return alias;
    },
  });
}
