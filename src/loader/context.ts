import type { EventLog } from "../host/event-log.ts";
import {
  frozenPrefixHash,
  lastPromptSeal,
  toolSchemaHash,
  toolSchemaSnapshot,
} from "../host/prefix.ts";
import type {
  CapabilityClaim,
  HostContext,
  LlmFacade,
  LoopFacade,
  PluginDisposer,
} from "./types.ts";
import { canonicalWorkspaceRoot } from "../host/sandbox-docker.ts";

const ROOT_OWNER = "@host";

interface OwnedValue {
  readonly owner: string;
  readonly value: unknown;
}

interface PromptContribution {
  readonly order: number;
  readonly text: string;
}

function address(key: string, route?: string): string {
  return `${key}\0${route ?? ""}`;
}

export class HostContextImpl implements HostContext {
  readonly log: EventLog;
  readonly sessionId: string;
  readonly workspaceRoot: string;

  private baseSystemPrompt: string;
  private projectedSystemPrompt: string;
  private projectedToolSchemas: unknown[] = [];
  private readonly definitions = new Map<string, OwnedValue>();
  private readonly providers = new Map<string, OwnedValue>();
  private readonly promptContributions = new Map<string, PromptContribution>();
  private readonly rootEffects: PluginDisposer[] = [];
  private sealGeneration = 0;
  private surfaceDirty = false;

  constructor(input: {
    log: EventLog;
    sessionId: string;
    workspaceRoot: string;
    systemPrompt: string;
  }) {
    this.log = input.log;
    this.sessionId = input.sessionId;
    this.workspaceRoot = canonicalWorkspaceRoot(input.workspaceRoot);
    this.baseSystemPrompt = input.systemPrompt;
    this.projectedSystemPrompt = input.systemPrompt;
  }

  get systemPrompt(): string {
    return this.projectedSystemPrompt;
  }

  set systemPrompt(value: string) {
    this.baseSystemPrompt = value;
    this.rebuildSystemPrompt();
  }

  get toolSchemas(): unknown[] {
    return this.projectedToolSchemas;
  }

  set toolSchemas(value: unknown[]) {
    this.projectedToolSchemas = value;
  }

  get llm(): LlmFacade | undefined {
    return this.tryGet<LlmFacade>("llm");
  }

  /** Root-host compatibility for isolated loop tests. Plugin fibers receive
   * a getter-only projection and must install the declared provider instead. */
  set llm(value: LlmFacade | undefined) {
    if (!value) throw new Error("root llm compatibility assignment requires a provider");
    this.provide("llm", value);
  }

  get loop(): LoopFacade | undefined {
    return this.tryGet<LoopFacade>("loop");
  }

  effect(setup: () => void | PluginDisposer): void {
    const disposer = setup();
    if (typeof disposer === "function") this.rootEffects.push(disposer);
  }

  define(key: string, definition: unknown): void {
    this.rootEffects.push(this.installDefinition(ROOT_OWNER, key, definition));
  }

  provide(key: string, provider: unknown, route?: string): void {
    this.rootEffects.push(this.installProvider(ROOT_OWNER, key, provider, route));
  }

  inject<T>(key: string, route?: string): T {
    return this.getAddress<T>(key, route);
  }

  get<T>(key: string): T {
    return this.getAddress<T>(key);
  }

  tryGet<T>(key: string): T | undefined {
    try {
      return this.get<T>(key);
    } catch {
      return undefined;
    }
  }

  scoped(
    owner: string,
    claims: readonly CapabilityClaim[],
    addEffect: (disposer: PluginDisposer) => void,
  ): HostContext {
    return new FiberContext(this, owner, claims, addEffect);
  }

  installDefinition(owner: string, key: string, definition: unknown): PluginDisposer {
    const existing = this.definitions.get(key);
    if (existing) throw new Error(`definition already registered: ${key}`);
    const entry = { owner, value: definition };
    this.definitions.set(key, entry);
    return () => {
      if (this.definitions.get(key) === entry) this.definitions.delete(key);
    };
  }

  installProvider(owner: string, key: string, provider: unknown, route?: string): PluginDisposer {
    const slot = address(key, route);
    const existing = this.providers.get(slot);
    if (existing) {
      const label = route ? `${key}.${route}` : key;
      throw new Error(route
        ? `duplicate named route provider for ${label}`
        : `duplicate active provider for ${label}`);
    }
    const entry = { owner, value: provider };
    this.providers.set(slot, entry);
    if (key === "tools" && route === undefined) this.syncToolSchemas(provider);
    return () => {
      if (this.providers.get(slot) !== entry) return;
      this.providers.delete(slot);
      if (key === "tools" && route === undefined) this.syncToolSchemas(undefined);
    };
  }

  registerPromptContribution(owner: string, order: number, text: string): PluginDisposer {
    if (this.promptContributions.has(owner)) {
      throw new Error(`prompt contribution already registered by ${owner}`);
    }
    const contribution = { order, text };
    this.promptContributions.set(owner, contribution);
    this.rebuildSystemPrompt();
    return () => {
      if (this.promptContributions.get(owner) !== contribution) return;
      this.promptContributions.delete(owner);
      this.rebuildSystemPrompt();
    };
  }

  markModelFacingChange(): void {
    this.surfaceDirty = true;
  }

  sealIfNeeded(reason: "compaction" | "tools_changed" | "skill_set_changed", force = false): void {
    const hash = frozenPrefixHash({
      systemPrompt: this.systemPrompt,
      toolSchemas: this.toolSchemas,
    });
    const last = lastPromptSeal(this.log.events);
    const lastHash = typeof last?.payload.prefix_hash === "string" ? last.payload.prefix_hash : undefined;
    const lastGeneration =
      typeof last?.payload.prompt_generation === "number" ? last.payload.prompt_generation : undefined;

    // `force` is for a caller that knows something the prefix hash does not.
    // A tool profile can change while the prefix stays put — a narrow scope
    // and the full set can seal to the same prefix — and the projection reads
    // the profile, so it needs the seal even when the hash agrees.
    if (!force && reason !== "compaction" && lastHash === hash) {
      this.surfaceDirty = false;
      this.sealGeneration = Math.max(this.sealGeneration, (lastGeneration ?? -1) + 1);
      return;
    }

    this.log.append({
      kind: "observe",
      name: "prompt/seal",
      payload: {
        reason,
        prefix_hash: hash,
        tool_schema_hash: toolSchemaHash(this.toolSchemas),
        prompt_generation: this.sealGeneration,
      },
    });
    this.sealGeneration += 1;
    this.surfaceDirty = false;
  }

  requireSealedBeforeModel(): void {
    if (this.surfaceDirty) {
      throw new Error("model-facing surface changed without prompt/seal");
    }
  }

  private getAddress<T>(key: string, route?: string): T {
    const provider = this.providers.get(address(key, route));
    if (provider) return provider.value as T;
    if (route === undefined) {
      const definition = this.definitions.get(key);
      if (definition) return definition.value as T;
    }
    throw new Error(`missing ctx.${route ? `${key}.${route}` : key}`);
  }

  private rebuildSystemPrompt(): void {
    const additions = [...this.promptContributions.values()]
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.text.trim())
      .filter(Boolean);
    const next = additions.length === 0
      ? this.baseSystemPrompt
      : `${this.baseSystemPrompt.trimEnd()}\n\n${additions.join("\n\n")}\n`;
    if (next !== this.projectedSystemPrompt) {
      this.projectedSystemPrompt = next;
      this.markModelFacingChange();
    }
  }

  private syncToolSchemas(provider: unknown): void {
    const tools = Array.isArray(provider) ? provider : [];
    const next = toolSchemaSnapshot(tools.filter(
      (value): value is { name: string; description?: string } =>
        typeof value === "object" && value !== null && "name" in value && typeof value.name === "string",
    ));
    const before = JSON.stringify(this.projectedToolSchemas);
    const after = JSON.stringify(next);
    this.projectedToolSchemas = next;
    if (before !== after) this.markModelFacingChange();
  }
}

class FiberContext implements HostContext {
  constructor(
    private readonly host: HostContextImpl,
    private readonly owner: string,
    private readonly claims: readonly CapabilityClaim[],
    private readonly addEffect: (disposer: PluginDisposer) => void,
  ) {}

  get log(): EventLog { return this.host.log; }
  get sessionId(): string { return this.host.sessionId; }
  get workspaceRoot(): string { return this.host.workspaceRoot; }
  get systemPrompt(): string { return this.host.systemPrompt; }
  set systemPrompt(value: string) { this.host.systemPrompt = value; }
  get toolSchemas(): unknown[] { return this.host.toolSchemas; }
  set toolSchemas(value: unknown[]) { this.host.toolSchemas = value; }
  get llm(): LlmFacade | undefined { return this.host.llm; }
  get loop(): LoopFacade | undefined { return this.host.loop; }

  effect(setup: () => void | PluginDisposer): void {
    const disposer = setup();
    if (typeof disposer === "function") this.addEffect(disposer);
  }

  define(key: string, definition: unknown): void {
    this.assertClaim(key, "definition");
    this.addEffect(this.host.installDefinition(this.owner, key, definition));
  }

  provide(key: string, provider: unknown, route?: string): void {
    this.assertClaim(key, "provider", route);
    this.addEffect(this.host.installProvider(this.owner, key, provider, route));
  }

  inject<T>(key: string, route?: string): T {
    this.assertClaim(key, "consumer", route);
    return this.host.inject<T>(key, route);
  }

  get<T>(key: string): T {
    return this.host.get<T>(key);
  }

  tryGet<T>(key: string): T | undefined {
    return this.host.tryGet<T>(key);
  }

  markModelFacingChange(): void { this.host.markModelFacingChange(); }
  sealIfNeeded(reason: "compaction" | "tools_changed" | "skill_set_changed", force = false): void {
    this.host.sealIfNeeded(reason, force);
  }
  requireSealedBeforeModel(): void { this.host.requireSealedBeforeModel(); }

  private assertClaim(key: string, role: CapabilityClaim["role"], route?: string): void {
    const declared = this.claims.some((claim) =>
      claim.key === key
      && claim.role === role
      && (claim.route === route || (role === "consumer" && claim.route === undefined)),
    );
    if (!declared) {
      throw new Error(`plugin ${this.owner} used undeclared ${role} claim ${route ? `${key}.${route}` : key}`);
    }
  }
}
