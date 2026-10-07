import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { basename } from "node:path";
import type { HostContext } from "../../src/loader/types.ts";
import { createWorkspaceTools, disposeWorkspaceTools } from "../../src/plugins/workspace-tools.ts";

/** Probe the same interpreter used for tests; never collect tests or install packages. */
export const REVIEW_PREFLIGHT_SCRIPT = `
import sys, json, importlib.util
result = {"review_next_action": "Before executing local tests or probes used to resolve review hypotheses, register their fixed trigger/path/oracle/scope as review_assessment gap cases. Then execute the relevant checks once and use conclude with actual result refs. Early exploratory checks do not retroactively prove a later hypothesis; do not rerun a broad passing suite merely to repair paperwork. Prefer the smallest relevant assertion. Static and authenticated author evidence remain alternatives when appropriate.",
          "python": {"executable": sys.executable, "version": sys.version.split()[0]},
          "pytest": {"available": importlib.util.find_spec("pytest") is not None,
                     "forked": importlib.util.find_spec("pytest_forked") is not None},
          "torch": {"available": False, "cuda_available": False,
                    "cuda_graph_pool": {"available": False}}}
try:
    import torch
    result["torch"].update(available=True, version=torch.__version__,
                           cuda_available=bool(torch.cuda.is_available()))
    try:
        torch.cuda.graph_pool_handle()
        result["torch"]["cuda_graph_pool"]["available"] = True
    except Exception as error:
        result["torch"]["cuda_graph_pool"]["reason"] = type(error).__name__ + ": " + str(error)
except ImportError as error:
    result["torch"]["import_error"] = str(error)
print(json.dumps(result))
`;
const Parameters = Type.Object({ python: Type.Optional(Type.String({ maxLength: 1024 })) }, { additionalProperties: false });
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";

export function createReviewPreflightTool(ctx: HostContext): AgentTool<typeof Parameters> {
  return {
    name: "review_preflight",
    label: "review environment preflight",
    description: "Inspect the selected test Python's version, pytest/forked availability and torch CUDA/graph-pool support before review tests. Register gap hypotheses before local evidence execution; preflight does not plan coverage for you. Runs once through read-only fenced workspace execution; does not collect tests, install packages or claim GPU validation. python defaults to python3; use the exact venv interpreter for subsequent tests.",
    parameters: Parameters,
    async execute(id, params) {
      const python = params.python ?? "python3";
      if (python.includes("\0") || !/^python(?:\d+(?:\.\d+)?)?$/.test(basename(python))) {
        return { content: [{ type: "text", text: "Preflight requires a Python executable path, without command flags." }], details: { error: true } };
      }
      const local = createWorkspaceTools(ctx.workspaceRoot, { log: ctx.log, reviewOnly: true });
      try {
        const bash = local.find(tool => tool.name === "bash");
        if (!bash) throw new Error("Review preflight requires fenced workspace execution");
        return await bash.execute(id, { command: `${quote(python)} -c ${quote(REVIEW_PREFLIGHT_SCRIPT)}`, timeout: 30 });
      } finally { disposeWorkspaceTools(local); }
    },
  };
}
