import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createModels, type CredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { registerZenProvider } from "./zen-gateway.ts";

export type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export function createHostedModels(input: {
  credentials?: CredentialStore;
  env?: AuthEnvironment;
} = {}): MutableModels {
  const env = input.env ?? process.env;
  const models = createModels({
    credentials: input.credentials,
    authContext: {
      env: async (name) => env[name],
      fileExists: async (path) => {
        const home = env.HOME?.trim() || (input.env ? "" : homedir());
        if (path.startsWith("~/") && !home) return false;
        return existsSync(path.startsWith("~/") ? `${home}/${path.slice(2)}` : path);
      },
    },
  });
  models.setProvider(openaiCodexProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(googleProvider());
  models.setProvider(kimiCodingProvider());
  models.setProvider(zaiProvider());
  models.setProvider(minimaxProvider());
  models.setProvider(xaiProvider());
  models.setProvider(nvidiaProvider());
  models.setProvider(openrouterProvider());
  registerZenProvider(models);
  return models;
}
