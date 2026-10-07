import type { AuthCheck, AuthInteraction, AuthType, MutableModels } from "@earendil-works/pi-ai";
import { piAuthPath } from "../host/paths.ts";
import { redactText } from "../host/redact.ts";
import { BUILTIN_ROUTE_SPECS } from "../plugins/llm-route-catalog.ts";
import { createHostedModels, type AuthEnvironment } from "../plugins/hosted-models.ts";
import { routeModelCatalog, normalizeModelRoute } from "../plugins/model-catalog.ts";
import { PiAuthStore } from "../plugins/pi-auth-store.ts";

export interface AuthMethodSummary {
  type: AuthType;
  label: string;
  subscription: boolean;
  transport: "provider";
}

export interface AuthAccountStatus {
  route: string;
  providerId: string;
  providerName: string;
  methods: readonly AuthMethodSummary[];
  defaultMethod: AuthType;
  connected: boolean;
  credentialType?: AuthType;
  source?: string;
  modelCount: number;
  defaultModel?: string;
}

export interface DokkabiAuthOptions {
  authFile?: string;
  env?: AuthEnvironment;
}

export class DokkabiAuth {
  private readonly store: PiAuthStore;
  private readonly models: MutableModels;

  constructor(options: DokkabiAuthOptions = {}) {
    this.store = new PiAuthStore(options.authFile ?? piAuthPath());
    this.models = createHostedModels({ credentials: this.store, env: options.env });
  }

  async list(): Promise<AuthAccountStatus[]> {
    const stored = new Map((await this.store.list()).map((info) => [info.providerId, info]));
    const accounts: AuthAccountStatus[] = [];
    for (const spec of BUILTIN_ROUTE_SPECS) {
      const provider = this.models.getProvider(spec.providerId);
      if (!provider) continue;
      const methods: AuthMethodSummary[] = [];
      if (provider.auth.oauth) {
        methods.push({
          type: "oauth",
          label: provider.auth.oauth.name,
          subscription: provider.auth.oauth.isSubscription === true,
          transport: "provider",
        });
      }
      if (provider.auth.apiKey?.login) {
        methods.push({
          type: "api_key",
          label: provider.auth.apiKey.name,
          subscription: false,
          transport: "provider",
        });
      }
      if (methods.length === 0) continue;

      const storedInfo = stored.get(spec.providerId);
      const ambient = storedInfo ? undefined : await this.safeCheckAuth(spec.providerId);
      const catalog = routeModelCatalog(this.models, spec);
      accounts.push({
        route: spec.name,
        providerId: spec.providerId,
        providerName: provider.name,
        methods,
        defaultMethod: methods[0]!.type,
        connected: storedInfo !== undefined || ambient !== undefined,
        credentialType: storedInfo?.type ?? ambient?.type,
        source: storedInfo ? "credential store" : ambient?.source,
        modelCount: catalog.total,
        defaultModel: catalog.defaultModel,
      });
    }
    return accounts;
  }

  async login(route: string, type: AuthType | undefined, interaction: AuthInteraction): Promise<AuthAccountStatus> {
    const account = await this.requireAccount(route);
    const selected = type ?? account.defaultMethod;
    if (!account.methods.some((method) => method.type === selected)) {
      throw new Error("the selected provider does not support that login method");
    }
    try {
      await this.models.login(account.providerId, selected, interaction);
    } catch (error) {
      throw safeAuthError(error, "provider login failed");
    }
    return this.requireAccount(account.route);
  }

  async logout(route: string): Promise<AuthAccountStatus> {
    const account = await this.requireAccount(route);
    try {
      await this.models.logout(account.providerId);
    } catch (error) {
      throw safeAuthError(error, "provider logout failed");
    }
    return this.requireAccount(account.route);
  }

  private async requireAccount(route: string): Promise<AuthAccountStatus> {
    const normalized = normalizeModelRoute(route);
    const account = (await this.list()).find((candidate) => candidate.route === normalized);
    if (!account) throw new Error("unknown authentication route");
    return account;
  }

  private async safeCheckAuth(providerId: string): Promise<AuthCheck | undefined> {
    try {
      const checked = await this.models.checkAuth(providerId);
      return checked;
    } catch (error) {
      throw safeAuthError(error, "authentication status check failed");
    }
  }
}

function safeAuthError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactText(message).replace(/(?:auth|credential)(?:entication)?\s+(?:file|path)\s*[:=]\s*\S+/gi, "credential store");
  return new Error(redacted && !/\[redacted\]/.test(redacted) ? redacted : fallback);
}
