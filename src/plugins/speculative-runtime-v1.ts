import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventLog } from "../host/event-log.ts";
import type { HostContext } from "../loader/types.ts";
import { createReadOnlySpeculation, type ReadOnlySpeculation } from "../speculative/prefetch.ts";
import { createSpeculativeReadBudget, type SpeculativeReadBudget } from "../speculative/prefetch-budget.ts";
import { resolveSpeculativeMode, SPECULATIVE_MODE_ENV, type SpeculativeMode } from "../speculative/mode.ts";
import { optionalSpeculativeRules } from "../speculative/rules-file.ts";
import { SpeculationServiceError, type SpeculationService } from "../speculative/service.ts";

const sessionReadBudgets = new WeakMap<EventLog, SpeculativeReadBudget>();

export function createLegacySpeculationService(ctx: HostContext): SpeculationService {
  const readBudget = sessionReadBudgets.get(ctx.log) ?? createSpeculativeReadBudget();
  sessionReadBudgets.set(ctx.log, readBudget);
  let runtime: ReadOnlySpeculation | undefined;
  let read: AgentTool | undefined;
  let mode: SpeculativeMode | undefined;
  let revision = 0;
  let disposed = false;
  const invalidate = (): void => {
    runtime?.dispose();
    runtime = undefined;
    read = undefined;
    mode = undefined;
  };
  return {
    project(input) {
      if (disposed) throw new SpeculationServiceError();
      if (ctx.log.isReadOnly) return { revision, tools: input.projected };
      const nextMode = resolveSpeculativeMode({ env: process.env[SPECULATIVE_MODE_ENV] }).mode;
      const nextRead = input.projected.find((tool) => tool.name === "read");
      if (!runtime || read !== nextRead || mode !== nextMode) {
        invalidate();
        const loadedRules = nextMode === "off" ? undefined : optionalSpeculativeRules();
        ctx.log.append({
          kind: "observe",
          name: "speculation/config",
          payload: { mode: nextMode, ...(loadedRules ? { rules_digest: loadedRules.digest } : {}) },
        });
        runtime = createReadOnlySpeculation({
          mode: nextMode,
          workspaceRoot: ctx.workspaceRoot,
          tools: input.projected,
          readBudget,
          ...(loadedRules ? { rules: loadedRules.rules } : {}),
          onEvent: (event) => ctx.log.append({
            kind: "observe",
            name: `speculation/${event.outcome}`,
            payload: {
              tool: "read",
              key_digest: event.keyDigest,
              ...(event.outcome === "resolved" ? { outcome: event.resolution } : {}),
            },
          }),
        });
        read = nextRead;
        mode = nextMode;
        revision += 1;
      }
      return { revision, tools: runtime.project(input.projected) };
    },
    observeToolResult(result) { runtime?.observe(result); },
    observeAgentEvent() {},
    async idle() { await runtime?.idle(); },
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
    },
  };
}
