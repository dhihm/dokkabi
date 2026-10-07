import type { AuthType } from "@earendil-works/pi-ai";
import { DokkabiAuth, type AuthAccountStatus } from "./service.ts";
import { createTerminalAuthInteraction } from "./terminal.ts";

interface LoginArguments {
  route?: string;
  method?: AuthType;
  json: boolean;
  browser: boolean;
}

/**
 * Ask the provider whether the credential it just took actually works.
 *
 * Injected rather than imported so this file keeps out of the loader. Absent —
 * in a test, or a caller that has no route to probe — login behaves as before.
 */
export type CredentialVerifier = (route: string) => Promise<{ ok: boolean; detail?: string }>;

export async function runLoginCommand(
  args: readonly string[],
  verify?: CredentialVerifier,
): Promise<void> {
  const parsed = parseLoginArguments(args);
  const auth = new DokkabiAuth();
  if (!parsed.route) {
    const accounts = await auth.list();
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ accounts }, null, 2)}\n`);
    } else {
      printAccounts(accounts);
    }
    return;
  }

  const interaction = createTerminalAuthInteraction({
    openUrl: parsed.browser ? undefined : () => false,
  });
  const account = await auth.login(parsed.route, parsed.method, interaction);
  const via = account.credentialType ?? account.defaultMethod;
  if (!verify) {
    process.stdout.write(`[connected] ${account.route} via ${via}\n`);
    return;
  }
  // Stored is not connected. What was stored once was the harness's own
  // refusal text, and both this line and `dokkabi status` called it connected
  // while the route could not answer a single request.
  process.stdout.write(`[stored]    ${account.route} via ${via} — asking the provider…\n`);
  const checked = await verify(account.route);
  if (checked.ok) {
    process.stdout.write(`[connected] ${account.route} via ${via} — the provider answered\n`);
    return;
  }
  process.stdout.write(
    `[refused]   ${account.route} via ${via} — the credential was stored but the provider `
    + `rejected it: ${checked.detail ?? "no detail"}\n`
    + `Run \`dokkabi login ${account.route} ${parsed.method === "oauth" ? "--oauth" : "--api-key"}\` `
    + `again and paste ONLY the credential.\n`,
  );
  process.exitCode = 1;
}

export async function runLogoutCommand(args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0]?.startsWith("-")) throw new Error("usage: dokkabi logout ROUTE");
  const account = await new DokkabiAuth().logout(args[0]!);
  process.stdout.write(account.connected
    ? `[connected] ${account.route} (official environment credential is still available)\n`
    : `[missing]   ${account.route}\n`);
}

function parseLoginArguments(args: readonly string[]): LoginArguments {
  const parsed: LoginArguments = { json: false, browser: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--no-browser") {
      parsed.browser = false;
      continue;
    }
    if (arg === "--oauth" || arg === "--api-key") {
      if (parsed.method) throw new Error("choose one authentication method");
      parsed.method = arg === "--oauth" ? "oauth" : "api_key";
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        throw new Error("credential values are never accepted as arguments");
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error("unknown login flag");
    if (parsed.route) throw new Error("credential values are never accepted as arguments");
    parsed.route = arg;
  }
  if (!parsed.route && parsed.method) throw new Error("a login route is required");
  if (parsed.route && parsed.json) throw new Error("--json is available only for the connection roster");
  return parsed;
}

function printAccounts(accounts: readonly AuthAccountStatus[]): void {
  process.stdout.write("Authentication\n");
  for (const account of accounts) {
    const state = account.connected ? "[connected]" : "[missing]  ";
    const source = account.connected ? ` via ${account.credentialType ?? account.defaultMethod}` : "";
    const methods = account.methods.map((method) => `${method.type}${method.subscription ? " subscription" : ""}`).join("/");
    process.stdout.write(
      `${state} ${account.route.padEnd(12)} ${account.providerName.padEnd(18)} ${methods.padEnd(30)} models=${account.modelCount}${source}\n`,
    );
  }
  process.stdout.write("\nSign in: dokkabi login <route> [--oauth|--api-key]\n");
  process.stdout.write("Models:  dokkabi models [route] [--search TEXT]\n");
}
