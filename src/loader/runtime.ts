import { createHash } from "node:crypto";
import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import { assertNoRuntimeMarkers, frozenPrefixHash } from "../host/prefix.ts";
import type { HostContextImpl } from "./context.ts";
import type { ResolvedPlugin } from "./manifest.ts";
import { PrepareUnavailable } from "./types.ts";
import type {
  BootPreparation,
  PreparedPluginVerdict,
  CapabilityClaim,
  HostContext,
  PluginActivation,
  PluginSkipKind,
  PluginDisposer,
  PluginFiberState,
  PluginModule,
  PluginRuntime as PluginRuntimeContract,
  SkillRegistry,
  ToolContributionRegistry,
} from "./types.ts";

export interface RuntimePluginEntry {
  readonly order: number;
  readonly resolved: ResolvedPlugin;
  readonly module: PluginModule;
}

interface Fiber {
  readonly entry: RuntimePluginEntry;
  readonly effects: PluginDisposer[];
  state: PluginFiberState;
  generation: number;
  disabled: boolean;
}

export interface RuntimeBootResult {
  readonly loaded: readonly string[];
  readonly skipped: readonly string[];
}

export class PluginLifecycleRuntime implements PluginRuntimeContract {
  private readonly fibers: Fiber[];
  private readonly byId: Map<string, Fiber>;
  /** Tool names each plugin registered into tool_contributions, for the boot
   * assertion that every contribution reached the exposed tools surface. */
  private readonly contributedToolNames = new Map<string, Set<string>>();
  private transaction: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: HostContextImpl,
    entries: readonly RuntimePluginEntry[],
  ) {
    this.fibers = entries.map((entry) => ({
      entry,
      effects: [],
      state: "pending",
      generation: 0,
      disabled: false,
    }));
    this.byId = new Map(this.fibers.map((fiber) => [fiber.entry.module.id, fiber]));
    this.validateClaims();
  }

  async boot(persist: boolean): Promise<RuntimeBootResult> {
    const skipped: string[] = [];
    try {
      await this.reconcile({ record: persist, skipped });
      if (persist) for (const fiber of this.fibers) {
        if (fiber.state === "pending") this.recordPending(fiber, "provider_unavailable_at_boot");
      }
      const hasSkillSurface = this.fibers.some((fiber) =>
        fiber.state === "active"
        && fiber.entry.resolved.kind === "package"
        && (fiber.entry.resolved.prompts.length > 0 || fiber.entry.resolved.skills.length > 0),
      );
      this.assertContributionsExposed();
      this.ctx.sealIfNeeded(hasSkillSurface ? "skill_set_changed" : "tools_changed");
      return {
        loaded: this.fibers.filter((fiber) => fiber.state === "active").map((fiber) => fiber.entry.module.id),
        skipped,
      };
    } catch (error) {
      await this.disposeAll(false);
      throw error;
    }
  }

  disable(id: string, reason = "operator"): Promise<void> {
    return this.enqueue(async () => {
      this.assertLiveMutation();
      const target = this.requireFiber(id);
      if (target.disabled && target.state === "disposed") return;
      this.recordTransition("disable", target, reason);
      await this.awaitIdleTurn(target);
      const beforeSurface = this.surfaceSnapshot();
      target.disabled = true;
      const closure = this.reverseDependencyClosure(target);
      const failures: Error[] = [];
      for (const fiber of closure) {
        const next: PluginFiberState = fiber === target ? "disposed" : "pending";
        try {
          await this.disposeFiber(fiber, next, true, fiber === target ? reason : "provider_unavailable");
        } catch (error) {
          failures.push(asError(error));
        }
      }
      await this.refreshOptionalConsumers(target, true);
      await this.refreshToolProviderIfNeeded(target, true);
      await this.reconcile({ record: true, skipped: [] });
      this.sealTransition(beforeSurface);
      if (failures.length > 0) throw failures[0];
    });
  }

  enable(id: string, reason = "operator"): Promise<void> {
    return this.enqueue(async () => {
      this.assertLiveMutation();
      const target = this.requireFiber(id);
      if (!target.disabled && target.state === "active") return;
      this.recordTransition("enable", target, reason);
      await this.awaitIdleTurn(target);
      const beforeSurface = this.surfaceSnapshot();
      target.disabled = false;
      if (target.state === "disposed" || target.state === "failed") target.state = "pending";
      await this.reconcile({ record: true, skipped: [] });
      await this.refreshOptionalConsumers(target, true);
      await this.refreshToolProviderIfNeeded(target, true);
      await this.reconcile({ record: true, skipped: [] });
      this.sealTransition(beforeSurface);
    });
  }

  /**
   * The boot's prepare phase (#230 round 5, B0): the reconcile loop a boot
   * runs — same dependency order, same `activate`, same `preflight` — in its
   * prepare mode, which stops before `register`. Every refusal a boot can make
   * is made here; `boot` (the commit phase) then registers. A plugin that
   * reaches for something only a committed boot has (a provider an earlier
   * plugin would have registered, a log append, an effect) makes the verdict
   * unknown (PrepareUnavailable), never a refusal. The runtime a prepare ran on
   * is never committed: a boot prepares on its own, fresh instance.
   */
  async prepare(): Promise<BootPreparation> {
    const plugins = new Map<string, PreparedPluginVerdict>();
    try {
      await this.reconcile({ record: false, skipped: [], mode: "prepare", verdicts: plugins });
    } catch (error) {
      if (error instanceof PrepareRefusal) return { status: "refused", stage: error.stage, pluginId: error.pluginId, plugins, cause: error.original };
      if (error instanceof PrepareUnavailable) return { status: "unknown", ...(error.pluginId ? { pluginId: error.pluginId } : {}), plugins };
      throw error;
    }
    // A plugin whose required provider never activated stays pending in a
    // committed boot too. When every such provider skipped itself, the
    // consumer is off for the same reason (its kind carries over).
    for (let changed = true; changed;) {
      changed = false;
      for (const fiber of this.fibers) {
        if (plugins.has(fiber.entry.module.id)) continue;
        const providers = this.claims(fiber)
          .filter((claim) => claim.role === "consumer" && claim.optional !== true)
          .map((claim) => this.providerFor(claim))
          .filter((provider): provider is Fiber => provider !== undefined && provider.state !== "active");
        const verdicts = providers.map((provider) => plugins.get(provider.entry.module.id));
        if (verdicts.length > 0 && verdicts.every((verdict) => verdict?.verdict === "skipped")) {
          const kinds = new Set(verdicts.map((verdict) => (verdict as { kind: string }).kind));
          plugins.set(fiber.entry.module.id, { verdict: "skipped", kind: kinds.size === 1 ? [...kinds][0] as never : "unclassified" });
          changed = true;
        }
      }
    }
    for (const fiber of this.fibers) {
      if (!plugins.has(fiber.entry.module.id)) plugins.set(fiber.entry.module.id, { verdict: "unknown" });
    }
    return { status: "admissible", plugins };
  }

  state(id: string): PluginFiberState {
    return this.requireFiber(id).state;
  }

  states(): Readonly<Record<string, PluginFiberState>> {
    return Object.fromEntries(this.fibers.map((fiber) => [fiber.entry.module.id, fiber.state]));
  }

  dispose(): Promise<void> {
    return this.enqueue(() => this.disposeAll(false));
  }

  /**
   * The one boot loop. `commit` (the default) activates, preflights and
   * registers each ready plugin, recording as asked. `prepare` runs the same
   * loop and stops each plugin after `preflight`: nothing is registered or
   * recorded, the context refuses every mutation, and each verdict is kept.
   */
  private async reconcile(input: {
    record: boolean;
    skipped: string[];
    mode?: "prepare" | "commit";
    verdicts?: Map<string, PreparedPluginVerdict>;
  }): Promise<void> {
    const preparing = input.mode === "prepare";
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const fiber of this.fibers) {
        if (fiber.state !== "pending" || fiber.disabled || !this.dependenciesReady(fiber)) continue;
        const id = fiber.entry.module.id;
        const probe = preparing ? prepareContext(this.scoped(fiber), (key, route) => this.providedByActive(key, route)) : undefined;
        const scoped = probe?.ctx ?? this.scoped(fiber);
        let activation: PluginActivation;
        try {
          activation = await fiber.entry.module.activate?.(scoped) ?? { active: true };
          assertActivation(id, activation);
        } catch (error) {
          if (probe) {
            if (error instanceof PrepareUnavailable || probe.touched()) {
              input.verdicts?.set(id, { verdict: "unknown" });
              throw new PrepareUnavailable("activation needs a committed boot", id);
            }
            input.verdicts?.set(id, { verdict: "refused", stage: "activation" });
            throw new PrepareRefusal("activation", id, error);
          }
          const failures = await this.rollback(fiber);
          fiber.state = "failed";
          if (input.record) this.recordFailure(fiber, "activation_failed");
          throw failures[0] ?? error;
        }
        if (!activation.active) {
          if (probe) {
            input.verdicts?.set(id, probe.touched() ? { verdict: "unknown" } : { verdict: "skipped", kind: activation.kind ?? "unclassified" });
            fiber.state = "disposed";
            progressed = true;
            continue;
          }
          const failures = await this.rollback(fiber);
          if (failures.length > 0) {
            fiber.state = "failed";
            if (input.record) this.recordFailure(fiber, "activation_dispose_failed");
            throw failures[0];
          }
          fiber.state = "disposed";
          input.skipped.push(id);
          if (input.record) this.recordSkip(fiber, activation.reason, activation.kind);
          progressed = true;
          continue;
        }
        if (probe) {
          try {
            await fiber.entry.module.preflight?.(scoped);
          } catch (error) {
            if (error instanceof PrepareUnavailable || probe.touched()) {
              input.verdicts?.set(id, { verdict: "unknown" });
              throw new PrepareUnavailable("preflight needs a committed boot", id);
            }
            input.verdicts?.set(id, { verdict: "refused", stage: "preflight" });
            throw new PrepareRefusal("preflight", id, error);
          }
          // Prepared, not registered: consumers see it as ready to judge.
          fiber.state = "active";
          input.verdicts?.set(id, { verdict: "active" });
          progressed = true;
          continue;
        }
        await this.activateFiber(fiber, input.record);
        progressed = true;
      }
    }
  }

  /** Whether an active plugin provides (or defines) this capability: in the
   * prepare phase, what a committed boot would have registered by now. */
  private providedByActive(key: string, route?: string): boolean {
    return this.fibers.some((candidate) => candidate.state === "active"
      && this.claims(candidate).some((claim) => (claim.role === "provider" || claim.role === "definition")
        && claim.key === key && (route === undefined || claim.route === route)));
  }

  private async activateFiber(fiber: Fiber, record: boolean): Promise<void> {
    fiber.state = "loading";
    fiber.generation += 1;
    const scoped = this.scoped(fiber);
    let stage: "preflight" | "register" = "preflight";
    try {
      this.applyPackageAssets(fiber, scoped);
      const before = this.registeredToolNames();
      // The refusals registration would make, in the one place both a boot
      // and its prepare phase checks them (#230 round 3, D1').
      await fiber.entry.module.preflight?.(scoped);
      stage = "register";
      try {
        await fiber.entry.module.register(scoped);
      } catch (error) {
        // Register may not refuse (#230 round 4, D1''): a boot-time refusal
        // belongs in preflight, where the prepare phase sees it. A throw
        // here is reported as the contract violation it is.
        throw new RegisterContractViolation(fiber.entry.module.id, error);
      }
      fiber.state = "active";
      if (record) this.recordLoad(fiber);
      this.attributeNewToolNames(fiber, before);
      // A contribution registered while a tools provider is already active
      // must reach the model regardless of manifest order: recycle the
      // provider so reconcile re-registers it over the now-richer registry.
      if (this.registeredToolNames().length > before.length) {
        await this.refreshToolProviderIfNeeded(fiber, record);
      }
    } catch (error) {
      await this.rollback(fiber);
      fiber.state = "failed";
      if (record) {
        this.recordFailure(fiber, error instanceof RegisterContractViolation
          ? "register_contract_violation"
          : stage === "preflight" ? "preflight_failed" : "register_failed");
      }
      throw error;
    }
  }

  private async disposeFiber(
    fiber: Fiber,
    next: PluginFiberState,
    record: boolean,
    reason: string,
  ): Promise<void> {
    if (fiber.state !== "active" && fiber.state !== "failed" && fiber.state !== "loading") {
      const previous = fiber.state;
      fiber.state = next;
      if (record && previous !== next) {
        this.recordUnload(fiber, reason, next);
        if (next === "pending") this.recordPending(fiber, reason);
      }
      return;
    }
    fiber.state = "unloading";
    const failures = await this.rollback(fiber);
    fiber.state = failures.length > 0 ? "failed" : next;
    if (record) this.recordUnload(fiber, reason, next);
    if (record && next === "pending") this.recordPending(fiber, reason);
    if (failures.length > 0) {
      this.recordFailure(fiber, "dispose_failed");
      throw failures[0];
    }
  }

  private async rollback(fiber: Fiber): Promise<Error[]> {
    const failures: Error[] = [];
    while (fiber.effects.length > 0) {
      const dispose = fiber.effects.pop()!;
      try {
        await dispose();
      } catch (error) {
        failures.push(asError(error));
      }
    }
    return failures;
  }

  private async disposeAll(record: boolean): Promise<void> {
    for (const fiber of [...this.fibers].reverse()) {
      if (fiber.state === "pending" && fiber.effects.length === 0) {
        fiber.state = "disposed";
        if (record) this.recordUnload(fiber, "runtime_dispose", "disposed");
        continue;
      }
      if (fiber.state !== "active" && fiber.effects.length === 0) continue;
      try {
        await this.disposeFiber(fiber, "disposed", record, "runtime_dispose");
      } catch {
        // Continue releasing independent fibers; callers still see FAILED state.
      }
    }
  }

  private scoped(fiber: Fiber): HostContext {
    return this.ctx.scoped(
      fiber.entry.module.id,
      this.claims(fiber),
      (disposer) => fiber.effects.push(disposer),
    );
  }

  private applyPackageAssets(fiber: Fiber, scoped: HostContext): void {
    const resolved = fiber.entry.resolved;
    if (resolved.kind !== "package") return;
    const contribution = packagePrompt(resolved);
    if (contribution.length > 0) {
      assertNoRuntimeMarkers(contribution);
      fiber.effects.push(this.ctx.registerPromptContribution(resolved.id, fiber.entry.order, contribution));
    }
    if (resolved.skills.length > 0) {
      const registry = scoped.inject<SkillRegistry>("skills");
      for (const skill of resolved.skills) {
        fiber.effects.push(registry.register({
          id: skill.id,
          pluginId: resolved.id,
          description: skill.description,
          body: skill.body,
          digest: skill.digest,
        }));
      }
    }
  }

  private dependenciesReady(fiber: Fiber): boolean {
    return this.claims(fiber)
      .filter((claim) => claim.role === "consumer" && claim.optional !== true)
      .every((claim) => this.providerFor(claim)?.state === "active");
  }

  private providerFor(claim: CapabilityClaim): Fiber | undefined {
    return this.fibers.find((candidate) => this.claims(candidate).some((provided) =>
      provided.role === "provider"
      && provided.key === claim.key
      && provided.route === claim.route,
    ));
  }

  private reverseDependencyClosure(provider: Fiber): Fiber[] {
    const ordered: Fiber[] = [];
    const seen = new Set<Fiber>();
    const visit = (fiber: Fiber) => {
      if (seen.has(fiber)) return;
      seen.add(fiber);
      for (const candidate of this.fibers) {
        if (candidate.state !== "active") continue;
        const depends = this.claims(candidate).some((claim) =>
          claim.role === "consumer"
          && claim.optional !== true
          && this.providerFor(claim) === fiber,
        );
        if (depends) visit(candidate);
      }
      ordered.push(fiber);
    };
    visit(provider);
    return ordered;
  }

  private async refreshToolProviderIfNeeded(changed: Fiber, record: boolean): Promise<void> {
    const contributed = this.claims(changed).some((claim) =>
      claim.role === "consumer" && claim.key === "tool_contributions",
    );
    if (!contributed) return;
    for (const fiber of this.fibers) {
      if (fiber === changed || fiber.state !== "active") continue;
      if (!this.claims(fiber).some((claim) => claim.role === "provider" && claim.key === "tools")) continue;
      await this.disposeFiber(fiber, "pending", record, "contributions_changed");
    }
  }

  private registeredToolNames(): string[] {
    const registry = this.ctx.tryGet<ToolContributionRegistry<{ name: string }>>("tool_contributions");
    return registry ? registry.list().map((tool) => tool.name) : [];
  }

  private attributeNewToolNames(fiber: Fiber, before: readonly string[]): void {
    const added = this.registeredToolNames().filter((name) => !before.includes(name));
    if (added.length === 0) return;
    const owned = this.contributedToolNames.get(fiber.entry.module.id) ?? new Set<string>();
    for (const name of added) owned.add(name);
    this.contributedToolNames.set(fiber.entry.module.id, owned);
  }

  /** Boot fails loudly when a registered contribution never reached the
   * exposed tools surface; manifest order must not silently drop a tool.
   * The obligation belongs only to a tools provider that also consumes the
   * contribution registry — a provider without that claim exposes its own
   * fixed surface by design (e.g. the verifier's review tools). With no such
   * fiber the assertion is vacuous. */
  private assertContributionsExposed(): void {
    for (const fiber of this.fibers) {
      if (fiber.state !== "active") continue;
      const claims = this.claims(fiber);
      const providesTools = claims.some((claim) =>
        claim.role === "provider" && claim.key === "tools",
      );
      const consumesContributions = claims.some((claim) =>
        claim.role === "consumer" && claim.key === "tool_contributions",
      );
      if (!providesTools || !consumesContributions) continue;
      // At most one active provider exists per tools route, so the current
      // tools value is exactly the surface this fiber exposes.
      const tools = this.ctx.tryGet<readonly { name: string }[]>("tools");
      if (!tools) continue;
      const exposed = new Set(tools.map((tool) => tool.name));
      for (const [pluginId, names] of this.contributedToolNames) {
        for (const name of names) {
          if (!exposed.has(name)) {
            throw new Error(`tool_contribution_not_exposed: ${pluginId}/${name}`);
          }
        }
      }
    }
  }

  private async refreshOptionalConsumers(changed: Fiber, record: boolean): Promise<void> {
    for (const fiber of [...this.fibers].reverse()) {
      if (fiber === changed || fiber.state !== "active") continue;
      const bindsChangedProvider = this.claims(fiber).some((claim) =>
        claim.role === "consumer"
        && claim.optional === true
        && this.providerFor(claim) === changed,
      );
      if (bindsChangedProvider) {
        await this.disposeFiber(fiber, "pending", record, "optional_provider_changed");
      }
    }
  }

  private claims(fiber: Fiber): readonly CapabilityClaim[] {
    const declared = fiber.entry.module.claims;
    const packageSkills = fiber.entry.resolved.kind === "package"
      && fiber.entry.resolved.skills.length > 0;
    if (!packageSkills || declared.some((claim) => claim.key === "skills" && claim.role === "consumer")) {
      return declared;
    }
    // Package skill installation is a loader-owned consumer even when an
    // older provider module predates explicit skill claims.
    return [...declared, { key: "skills", role: "consumer", modelFacing: true }];
  }

  private validateClaims(): void {
    const definitions = new Map<string, string>();
    const providers = new Map<string, string>();
    for (const fiber of this.fibers) {
      for (const claim of this.claims(fiber)) {
        if (!claim.key || (claim.optional === true && claim.role !== "consumer")) {
          throw new Error(`invalid capability claim in plugin ${fiber.entry.module.id}`);
        }
        const slot = `${claim.key}\0${claim.route ?? ""}`;
        if (claim.role === "definition") {
          const existing = definitions.get(slot);
          if (existing) throw new Error(`duplicate definition claim ${claim.key} from ${fiber.entry.module.id}; already owned by ${existing}`);
          definitions.set(slot, fiber.entry.module.id);
        }
        if (claim.role === "provider") {
          const existing = providers.get(slot);
          if (existing) throw new Error(`duplicate provider claim ${claim.key} from ${fiber.entry.module.id}; already owned by ${existing}`);
          providers.set(slot, fiber.entry.module.id);
        }
      }
    }
    const visiting = new Set<Fiber>();
    const visited = new Set<Fiber>();
    const walk = (fiber: Fiber) => {
      if (visiting.has(fiber)) throw new Error(`plugin dependency cycle at ${fiber.entry.module.id}`);
      if (visited.has(fiber)) return;
      visiting.add(fiber);
      for (const claim of this.claims(fiber)) {
        if (claim.role !== "consumer" || claim.optional === true) continue;
        const provider = this.providerFor(claim);
        if (provider) walk(provider);
      }
      visiting.delete(fiber);
      visited.add(fiber);
    };
    for (const fiber of this.fibers) walk(fiber);
  }

  private recordTransition(action: "disable" | "enable", fiber: Fiber, reason: string): void {
    this.ctx.log.append({
      kind: "effect",
      name: "plugin/transition",
      payload: {
        action,
        id: fiber.entry.module.id,
        digest: fiber.entry.resolved.digest,
        from_state: fiber.state,
        active_plugin_set_digest: this.activeSetDigest(),
        reason_code: safeReason(reason),
      },
    });
  }

  private recordLoad(fiber: Fiber): void {
    const resolved = fiber.entry.resolved;
    const blob = this.ctx.log.isReadOnly
      ? undefined
      : BlobStore.forSession(this.ctx.log.path).put(resolved.snapshot);
    this.ctx.log.append({
      kind: "observe",
      name: "plugin/load",
      payload: {
        id: resolved.id,
        digest: resolved.digest,
        generation: fiber.generation,
        kind: resolved.kind,
        active_plugin_set_digest: this.activeSetDigest(),
        ...(blob ? { blob, blob_bytes: resolved.snapshot.length } : {}),
        ...(resolved.kind === "package" ? { package_digest: resolved.digest } : {}),
        assets: resolved.assets.map((asset) => asset.id),
        prompts: resolved.prompts.map((asset) => asset.id),
        skills: resolved.skills.map((asset) => asset.id),
      },
      observe: { plugin: { action: "load", id: resolved.id, digest: resolved.digest } },
    });
  }

  private recordUnload(fiber: Fiber, reason: string, next: PluginFiberState): void {
    this.ctx.log.append({
      kind: "observe",
      name: "plugin/unload",
      payload: {
        id: fiber.entry.module.id,
        digest: fiber.entry.resolved.digest,
        generation: fiber.generation,
        next_state: next,
        reason_code: safeReason(reason),
        active_plugin_set_digest: this.activeSetDigest(),
      },
      observe: { plugin: { action: "unload", id: fiber.entry.module.id, digest: fiber.entry.resolved.digest } },
    });
  }

  private recordSkip(fiber: Fiber, reason: string, kind?: PluginSkipKind): void {
    this.ctx.log.append({
      kind: "observe",
      name: "plugin/skip",
      payload: {
        id: fiber.entry.module.id,
        digest: fiber.entry.resolved.digest,
        generation: fiber.generation,
        reason: safeReason(reason),
        reason_code: safeReason(reason),
        skip_class: kind ?? "unclassified",
        active_plugin_set_digest: this.activeSetDigest(),
      },
    });
  }

  private recordPending(fiber: Fiber, reason: string): void {
    this.ctx.log.append({
      kind: "observe",
      name: "plugin/pending",
      payload: {
        id: fiber.entry.module.id,
        digest: fiber.entry.resolved.digest,
        generation: fiber.generation,
        reason_code: safeReason(reason),
        active_plugin_set_digest: this.activeSetDigest(),
      },
    });
  }

  private recordFailure(fiber: Fiber, reason: string): void {
    if (this.ctx.log.isReadOnly) return;
    this.ctx.log.append({
      kind: "observe",
      name: "plugin/transition_failed",
      payload: {
        id: fiber.entry.module.id,
        digest: fiber.entry.resolved.digest,
        generation: fiber.generation,
        reason_code: safeReason(reason),
        active_plugin_set_digest: this.activeSetDigest(),
      },
    });
  }

  private activeSetDigest(): string {
    const set = this.fibers
      .filter((fiber) => fiber.state === "active")
      .map((fiber) => ({ id: fiber.entry.module.id, digest: fiber.entry.resolved.digest }));
    return createHash("sha256").update(canonicalJson(set)).digest("hex");
  }

  private surfaceSnapshot(): { hash: string; prompt: string } {
    return {
      hash: frozenPrefixHash({ systemPrompt: this.ctx.systemPrompt, toolSchemas: this.ctx.toolSchemas }),
      prompt: this.ctx.systemPrompt,
    };
  }

  private sealTransition(beforeSurface: { hash: string; prompt: string }): void {
    const after = this.surfaceSnapshot();
    const changed = beforeSurface.hash !== after.hash;
    if (!changed) {
      // A remove/re-add transaction may dirty the projection transiently even
      // when its final bytes match the existing seal.
      this.ctx.sealIfNeeded("tools_changed");
      return;
    }
    this.ctx.sealIfNeeded(beforeSurface.prompt === after.prompt ? "tools_changed" : "skill_set_changed");
    this.ctx.loop?.invalidateSurface();
  }

  private assertLiveMutation(): void {
    if (this.ctx.log.isReadOnly) throw new Error("plugin lifecycle mutation is unavailable in replay");
  }

  private async awaitIdleTurn(fiber: Fiber): Promise<void> {
    if (!this.modelTurnBusy()) return;
    this.ctx.log.append({
      kind: "observe",
      name: "plugin/deferred",
      payload: {
        id: fiber.entry.module.id,
        digest: fiber.entry.resolved.digest,
        generation: fiber.generation,
        reason_code: "model_turn_active",
        active_plugin_set_digest: this.activeSetDigest(),
      },
    });
    while (this.modelTurnBusy()) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  private modelTurnBusy(): boolean {
    for (let index = this.ctx.log.events.length - 1; index >= 0; index -= 1) {
      const event = this.ctx.log.events[index];
      if (event?.name !== "agent/status") continue;
      const status = event.payload.status;
      return status === "running" || status === "waiting_tool" || status === "compacting";
    }
    return false;
  }

  private requireFiber(id: string): Fiber {
    const fiber = this.byId.get(id);
    if (!fiber) throw new Error(`unknown plugin ${id}`);
    return fiber;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.transaction.then(operation, operation);
    this.transaction = next.catch(() => {});
    return next;
  }
}

function packagePrompt(plugin: ResolvedPlugin): string {
  if (plugin.prompts.length === 0 && plugin.skills.length === 0) return "";
  return [
    `<dokkabi-plugin id="${plugin.id}">`,
    ...plugin.prompts.flatMap((prompt) => [
      `<prompt id="${prompt.id}">`,
      prompt.body.trim(),
      "</prompt>",
    ]),
    ...(plugin.skills.length > 0
      ? [
          "<skills tool=\"skill\">",
          ...plugin.skills.map((skill) => `${skill.id}: ${skill.description}`),
          "</skills>",
        ]
      : []),
    "</dokkabi-plugin>",
  ].join("\n");
}

function assertActivation(id: string, activation: PluginActivation): void {
  if (!activation.active && activation.reason.trim().length === 0) {
    throw new Error(`plugin ${id} returned an empty inactive reason`);
  }
  if (!activation.active && activation.kind !== undefined
    && !["not_configured", "invalid_configuration", "unavailable"].includes(activation.kind)) {
    throw new Error(`plugin ${id} returned an unknown skip kind`);
  }
}

function safeReason(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 63) || "unspecified";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** A plugin's `register` threw: a refusal outside `preflight`. The message
 * keeps the plugin's own words after the violation. */
export class RegisterContractViolation extends Error {
  readonly name = "RegisterContractViolation";
  constructor(readonly pluginId: string, readonly original: unknown) {
    super(`plugin ${pluginId} refused in register, which may not refuse (a refusal belongs in preflight): ${original instanceof Error ? original.message : String(original)}`);
  }
}

/** A refusal the prepare phase made: the boot's own, at this stage. */
export class PrepareRefusal extends Error {
  readonly name = "PrepareRefusal";
  constructor(readonly stage: "activation" | "preflight", readonly pluginId: string, readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
  }
}

/**
 * A plugin's context in the prepare phase: reads pass through (a provider
 * that is not registered yet reads as absent, and is noted when a committed
 * boot would have had it), every mutation — an effect, a definition, a
 * provider, a seal — is refused as PrepareUnavailable.
 */
function prepareContext(
  inner: HostContext,
  registeredInBoot: (key: string, route?: string) => boolean,
): { ctx: HostContext; touched: () => boolean } {
  let touched = false;
  const unavailable = (what: string) => () => {
    touched = true;
    throw new PrepareUnavailable(`the prepare phase cannot ${what}`);
  };
  const ctx = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "effect") return unavailable("install an effect");
      if (property === "define") return unavailable("define a capability");
      if (property === "provide") return unavailable("provide a capability");
      if (property === "markModelFacingChange" || property === "sealIfNeeded") return unavailable("change the model surface");
      if (property === "get" || property === "inject") {
        return <T>(key: string, route?: string): T => {
          try {
            return (target[property] as (key: string, route?: string) => T).call(target, key, route);
          } catch (error) {
            // Missing in a real boot too: the throw is the boot's own.
            if (!registeredInBoot(key, route)) throw error;
            touched = true;
            throw new PrepareUnavailable(`the prepare phase has no ${key}`);
          }
        };
      }
      if (property === "tryGet") {
        return <T>(key: string): T | undefined => {
          const value = target.tryGet<T>(key);
          if (value === undefined && registeredInBoot(key)) touched = true;
          return value;
        };
      }
      if (property === "llm" || property === "loop") {
        const value = Reflect.get(target, property, receiver);
        if (value === undefined && registeredInBoot(property)) touched = true;
        return value;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { ctx, touched: () => touched };
}
