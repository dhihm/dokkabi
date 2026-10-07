import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import { gitDiff, gitLog, gitStatus } from "../host/git-view.ts";
import type { SandboxPolicy } from "../host/sandbox.ts";
import { textToolResult } from "../tools/model-result.ts";

export function createWorkspaceGitTool(
  workspaceRoot: string,
  kind: "status" | "diff" | "log",
  policy?: SandboxPolicy,
): AgentTool {
  const descriptions = {
    status: "git status --porcelain of the workspace repository.",
    diff: "git diff of the workspace repository. staged=true shows the index; path narrows to one file.",
    log: "git log --oneline, newest first. limit defaults to 10; path narrows to one file.",
  } as const;
  const parameters = {
    status: { type: "object", properties: {}, additionalProperties: false },
    diff: {
      type: "object",
      properties: {
        staged: { type: "boolean" },
        path: { type: "string" },
      },
      additionalProperties: false,
    },
    log: {
      type: "object",
      properties: {
        limit: { type: "number" },
        path: { type: "string" },
      },
      additionalProperties: false,
    },
  } as const;
  return {
    name: `git_${kind}`,
    label: `git ${kind}`,
    description: descriptions[kind],
    parameters: parameters[kind] as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = params as { staged?: boolean; path?: string; limit?: number };
      const result = kind === "status"
        ? gitStatus({ root: workspaceRoot, ...(policy ? { policy } : {}) })
        : kind === "diff"
          ? gitDiff({
              root: workspaceRoot,
              ...(p.staged !== undefined ? { staged: p.staged } : {}),
              ...(p.path ? { path: p.path } : {}),
              ...(policy ? { policy } : {}),
            })
          : gitLog({
              root: workspaceRoot,
              ...(p.limit !== undefined ? { limit: p.limit } : {}),
              ...(p.path ? { path: p.path } : {}),
            });
      return textToolResult(result.text.length > 0 ? result.text : "(empty)", !result.ok);
    },
  };
}
