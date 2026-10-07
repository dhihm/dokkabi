import { fileURLToPath } from "node:url";
import type { PluginModule } from "../loader/types.ts";
import {
  readRemoteCredentialConfig,
  remoteCredentialLocale,
} from "../remote/credential-config.ts";
import { createLocalRemoteRunController } from "../remote/local-run-controller.ts";
import { resolveRemoteLocale } from "../remote/locale.ts";
import { createRemoteHost } from "../remote/service.ts";
import { createRemoteStatusRegistry } from "../remote/status.ts";
import type { RemoteStatusRegistry } from "../remote/types.ts";

export const plugin: PluginModule = {
  id: "remote-runtime",
  claims: [
    { key: "remote", role: "definition" },
    { key: "remote", role: "provider" },
    { key: "remote_status", role: "consumer", optional: true },
  ],
  register(ctx) {
    const configured = readRemoteCredentialConfig();
    const locale = configured.active
      ? remoteCredentialLocale(configured.config)
      : resolveRemoteLocale();
    const controller = createLocalRemoteRunController({
      cliPath: fileURLToPath(new URL("../cli.ts", import.meta.url)),
      locale,
      workspaceRoot: ctx.workspaceRoot,
    });
    const status = ctx.tryGet<RemoteStatusRegistry>("remote_status") ?? createRemoteStatusRegistry();
    const remote = createRemoteHost({ controller, locale, log: ctx.log, status });
    ctx.define("remote", { ingress: "durable", modelFacing: false });
    ctx.provide("remote", remote);
    ctx.effect(() => () => remote.stop());
  },
};
