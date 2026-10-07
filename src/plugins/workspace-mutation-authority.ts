import type { AgentTool } from "@earendil-works/pi-agent-core";

export type WorkspaceMutationTerminal = AgentTool["execute"];

type Projector = (surface: AgentTool, terminal: WorkspaceMutationTerminal) => AgentTool;

const projectors = new WeakMap<AgentTool, Projector>();
const revoked = new WeakSet<AgentTool>();

export function registerWorkspaceMutationProjector(tool: AgentTool, projector: Projector): () => void {
  projectors.set(tool, projector);
  return () => revoked.add(tool);
}

export function transferWorkspaceMutationProjector(source: AgentTool, target: AgentTool): void {
  const projector = projectors.get(source);
  if (projector && !revoked.has(source)) projectors.set(target, projector);
}

export function revokeWorkspaceMutationProjector(tool: AgentTool): void {
  revoked.add(tool);
}

export interface WorkspaceMutationAuthority {
  project(surface: AgentTool, terminal: WorkspaceMutationTerminal): AgentTool | undefined;
}

export function createWorkspaceMutationAuthority(
  available: readonly AgentTool[],
  projected: readonly AgentTool[],
): WorkspaceMutationAuthority | undefined {
  const capabilities = new Map<string, { readonly tool: AgentTool; readonly projector: Projector }>();
  for (const tool of available) {
    const projector = projectors.get(tool);
    if (!projector || revoked.has(tool)) continue;
    if (capabilities.has(tool.name)) return undefined;
    capabilities.set(tool.name, { tool, projector });
  }
  const projectedTools = new Set(projected);
  if (capabilities.size === 0) return undefined;
  return {
    project(surface, terminal) {
      const capability = capabilities.get(surface.name);
      if (!capability || surface !== capability.tool || !projectedTools.has(surface)
        || revoked.has(capability.tool)) return undefined;
      return capability.projector(surface, terminal);
    },
  };
}
