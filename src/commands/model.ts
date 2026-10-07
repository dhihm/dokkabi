import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  resolveLlmSelection,
  writeConfig,
} from "../host/config.ts";
import { EventLog } from "../host/event-log.ts";
import { piAuthPath } from "../host/paths.ts";
import { createLlmFacade } from "../plugins/llm-routes.ts";
import { runModelsCommand } from "./models.ts";

interface ModelArguments {
  route?: string;
  model?: string;
}

function parseModelArguments(args: readonly string[]): ModelArguments {
  let route: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--route") {
      route = args[i + 1];
      if (!route) throw new Error("--route requires a name");
      i += 1;
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`unknown model flag ${arg}`);
    if (model !== undefined) throw new Error("model accepts one model id");
    model = arg;
  }
  return { route, model };
}

export async function runModelCommand(args: readonly string[]): Promise<void> {
  const parsed = parseModelArguments(args);
  const selection = resolveLlmSelection({ route: parsed.route });
  if (!parsed.model) {
    const config = readConfig();
    process.stdout.write(`route=${selection.route}\n`);
    process.stdout.write(`model=${selection.model ?? "(route default)"}\n`);
    process.stdout.write(`config_route=${config.route ?? "(none)"}\n`);
    process.stdout.write(`config_model=${config.model ?? "(none)"}\n`);
    process.stdout.write(`env_route=${process.env.DOKKABI_ROUTE ?? "(none)"}\n`);
    process.stdout.write(`env_model=${process.env.DOKKABI_MODEL ?? "(none)"}\n`);
    process.stdout.write("\n");
    await runModelsCommand([selection.route]);
    return;
  }

  const saved = await persistModelSelection(`${selection.route}/${parsed.model}`);
  process.stdout.write(`route=${saved.route}\nmodel=${saved.model}\n`);
}

/**
 * Validate and persist a route or route/model pair as the saved default —
 * the same write the CLI `dokkabi model` performs. The desktop console uses
 * this when no chat kernel owns the session, so `/model` still means
 * something in observer mode (it lands on the next session boot).
 */
export async function persistModelSelection(
  choice: string,
): Promise<{ route: string; model: string }> {
  const trimmed = choice.trim().replace(/^\/+/, "");
  const [routeName, ...rest] = trimmed.split("/");
  const model = rest.join("/").trim();
  if (!routeName) throw new Error("choice must name a route, or route/model");
  const temp = mkdtempSync(join(tmpdir(), "dokkabi-model-command-"));
  const previousRoute = process.env.DOKKABI_ROUTE;
  process.env.DOKKABI_ROUTE = routeName;
  try {
    const facade = createLlmFacade(EventLog.create(join(temp, "events.jsonl")), piAuthPath());
    const route = facade.routes.get(routeName);
    if (!route) throw new Error(`unknown llm route ${routeName}`);
    if (model.length > 0) {
      await route.resolveModel(model);
    }
    const finalModel = model.length > 0 ? model : route.defaultModelId() ?? "";
    writeConfig({ route: routeName, ...(finalModel ? { model: finalModel } : {}) });
    return { route: routeName, model: finalModel };
  } finally {
    if (previousRoute === undefined) delete process.env.DOKKABI_ROUTE;
    else process.env.DOKKABI_ROUTE = previousRoute;
    rmSync(temp, { recursive: true, force: true });
  }
}
