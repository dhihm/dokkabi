import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PiAuthStore } from "../plugins/pi-auth-store.ts";
import { stageChildResearchPolicy } from "../eval/experiment/child-policy.ts";

export interface SwarmChildPrivateHome {
  readonly home: string;
  readonly dokkabiHome: string;
}

export interface SwarmChildRouteAuthority {
  readonly piAuthPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SwarmChildMemoryBinding {
  readonly repositoryDigest: string;
  readonly viewDigest: string;
  readonly blobDigest: string;
}

export interface SwarmChildCapabilityBinding {
  readonly pluginManifestDigest: string;
  readonly toolSchemaDigest: string;
}

export interface SwarmChildEnvironmentInput {
  readonly route: string;
  /** Explicit model id for this child (freeswarm assigns a specific free
   * model per role). Absent means the route's default model, as before. The
   * parent's ambient DOKKABI_MODEL never crosses; only this explicit value
   * sets the child's DOKKABI_MODEL. */
  readonly model?: string;
  readonly privateHome: SwarmChildPrivateHome;
  readonly runtimeEnv: Readonly<Record<string, string | undefined>>;
  readonly routeAuthority?: SwarmChildRouteAuthority;
  readonly worldEnv?: Readonly<Record<string, string | undefined>>;
  readonly memoryBinding: SwarmChildMemoryBinding;
  readonly capabilityBinding: SwarmChildCapabilityBinding;
  readonly parentSessionId: string;
  readonly parentOpenSeq: number;
  readonly role: string;
  readonly dispatchDigest: string;
}

export interface StageSwarmChildRouteAuthorityInput {
  readonly route: string;
  readonly providerId: string;
  readonly privateHome: SwarmChildPrivateHome;
  readonly runtimeEnv: Readonly<Record<string, string | undefined>>;
  readonly parentAuthPath: string;
}

const HEX = /^[a-f0-9]{64}$/u;

const RUNTIME_ENV_KEYS = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "DOKKABI_EFFORT",
]);

const WORLD_ENV_KEYS = new Set([
  // A Docker connection is an explicitly sealed world authority. HOME is
  // accepted from the existing provider shape but is overwritten below.
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_API_VERSION",
  "DOKKABI_SANDBOX_NET",
  "DOKKABI_DOCKER_CONTAINER",
  "DOKKABI_DOCKER_IMAGE",
  "DOKKABI_DOCKER_NETWORK_STATE",
  "DOKKABI_SWE_CONTAINER",
  "DOKKABI_SWE_IMAGE",
]);

const ROUTE_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  codex: [],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
  antigravity: ["GEMINI_API_KEY"],
  kimi: ["KIMI_API_KEY"],
  glm: ["ZAI_API_KEY", "ZAI_CODING_CN_API_KEY"],
  minimax: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],
  grok: ["XAI_API_KEY"],
  nim: ["NVIDIA_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  replay: [],
  vllm: [
    "DOKKABI_VLLM_BASE_URL",
    "VLLM_BASE_URL",
    "VLLM_API_KEY",
    "VLLM_CONTEXT_WINDOW",
    "VLLM_MAX_TOKENS",
  ],
  "kraken-gpu1": [
    "DOKKABI_KRAKEN_GPU1_BASE_URL",
    "KRAKEN_GPU1_BASE_URL",
    "DOKKABI_KRAKEN_GPU1_API_KEY",
    "KRAKEN_GPU1_API_KEY",
    "KRAKEN_CONTEXT_WINDOW",
    "KRAKEN_MAX_TOKENS",
  ],
  "kraken-gpu2": [
    "DOKKABI_KRAKEN_GPU2_BASE_URL",
    "KRAKEN_GPU2_BASE_URL",
    "DOKKABI_KRAKEN_GPU2_API_KEY",
    "KRAKEN_GPU2_API_KEY",
    "KRAKEN_CONTEXT_WINDOW",
    "KRAKEN_MAX_TOKENS",
  ],
  "kraken-gpu3": [
    "DOKKABI_KRAKEN_GPU3_BASE_URL",
    "KRAKEN_GPU3_BASE_URL",
    "DOKKABI_KRAKEN_GPU3_API_KEY",
    "KRAKEN_GPU3_API_KEY",
    "KRAKEN_CONTEXT_WINDOW",
    "KRAKEN_MAX_TOKENS",
  ],
  "kraken-gpu4": [
    "DOKKABI_KRAKEN_GPU4_BASE_URL",
    "KRAKEN_GPU4_BASE_URL",
    "DOKKABI_KRAKEN_GPU4_API_KEY",
    "KRAKEN_GPU4_API_KEY",
    "KRAKEN_CONTEXT_WINDOW",
    "KRAKEN_MAX_TOKENS",
  ],
};

export function swarmChildEnvironment(input: SwarmChildEnvironmentInput): Readonly<Record<string, string>> {
  const privateHome = validatePrivateHome(input.privateHome);
  const memory = validateMemoryBinding(input.memoryBinding);
  const capability = validateCapabilityBinding(input.capabilityBinding);
  const runtime = selectRuntimeEnvironment(input.runtimeEnv);
  const route = selectRouteAuthority(input.route, input.routeAuthority);
  if (route.piAuthPath && !pathWithin(privateHome.home, route.piAuthPath)) {
    throw new Error("swarm child Pi auth must be staged beneath the private HOME");
  }
  const world = selectWorldEnvironment(input.worldEnv);
  requireDigest(input.dispatchDigest, "swarm dispatch digest");
  if (!Number.isSafeInteger(input.parentOpenSeq) || input.parentOpenSeq < 1) {
    throw new Error("swarm parent event seq must be a positive integer");
  }

  const selected: Record<string, string> = {
    ...runtime,
    ...route.env,
    ...world,
    ...stageChildResearchPolicy(privateHome.home, input.runtimeEnv),
    // These assignments come after world authority deliberately: Docker's
    // host-side HOME may select its config, but it is never the child's HOME.
    HOME: privateHome.home,
    DOKKABI_HOME: privateHome.dokkabiHome,
    // General XDG state is always private. Docker-specific configuration may
    // cross only through the explicit DOCKER_CONFIG world authority.
    XDG_CONFIG_HOME: join(privateHome.home, ".config"),
    XDG_CACHE_HOME: join(privateHome.home, ".cache"),
    XDG_DATA_HOME: join(privateHome.home, ".local", "share"),
    XDG_STATE_HOME: join(privateHome.home, ".local", "state"),
    DOKKABI_ROUTE: requireSafeValue(input.route, "swarm route"),
    ...(input.model ? { DOKKABI_MODEL: requireSafeValue(input.model, "swarm model") } : {}),
    // This is a fixed child policy, not inherited parent preference. It keeps
    // live Wiki/GitHub/MAEK fetch tools out of the child; the staged memory
    // view below is its only external knowledge input.
    DOKKABI_EXTERNAL_KNOWLEDGE: "deny",
    ...(route.piAuthPath ? { DOKKABI_PI_AUTH: route.piAuthPath } : {}),
    DOKKABI_PARENT_SESSION: requireSafeValue(input.parentSessionId, "swarm parent session"),
    DOKKABI_PARENT_EVENT_SEQ: String(input.parentOpenSeq),
    DOKKABI_SWARM_ROLE: requireSafeValue(input.role, "swarm role"),
    DOKKABI_SWARM_ROUTE: requireSafeValue(input.route, "swarm route"),
    DOKKABI_SWARM_DISPATCH_DIGEST: input.dispatchDigest,
    DOKKABI_SWARM_REPOSITORY_DIGEST: memory.repositoryDigest,
    DOKKABI_SWARM_MEMORY_VIEW_DIGEST: memory.viewDigest,
    DOKKABI_SWARM_MEMORY_BLOB_DIGEST: memory.blobDigest,
    DOKKABI_SWARM_PLUGIN_MANIFEST_DIGEST: capability.pluginManifestDigest,
    DOKKABI_SWARM_TOOL_SCHEMA_DIGEST: capability.toolSchemaDigest,
  };
  return Object.freeze(selected);
}

/** Select only ambient variables owned by the chosen route. Stored provider
 * credentials cross through stageSwarmChildRouteAuthority, never as a parent
 * filesystem path in the child environment. */
export function swarmChildRouteAuthorityFromEnvironment(
  route: string,
  env: Readonly<Record<string, string | undefined>>,
): SwarmChildRouteAuthority | undefined {
  const selected: Record<string, string> = {};
  for (const key of ROUTE_ENV_KEYS[route] ?? []) {
    const value = env[key];
    if (value !== undefined && value.length > 0) selected[key] = value;
  }
  return Object.keys(selected).length === 0 ? undefined : { env: selected };
}

/** Copy at most the selected provider's Pi credential into a fresh child-only
 * store. Provider refreshes therefore cannot mutate the parent store, and no
 * parent credential path or sibling-provider credential enters child env. */
export async function stageSwarmChildRouteAuthority(
  input: StageSwarmChildRouteAuthorityInput,
): Promise<SwarmChildRouteAuthority | undefined> {
  const privateHome = validatePrivateHome(input.privateHome);
  const providerId = requireSafeValue(input.providerId, "swarm provider id");
  const ambient = swarmChildRouteAuthorityFromEnvironment(input.route, input.runtimeEnv);
  const parentAuthPath = requireAbsolutePath(input.parentAuthPath, "parent Pi auth path");
  const childAuthPath = join(privateHome.home, ".pi", "agent", "auth.json");
  if (parentAuthPath === childAuthPath) {
    throw new Error("swarm child Pi auth store must be distinct from the parent store");
  }

  const credential = await new PiAuthStore(parentAuthPath).read(providerId);
  let stagedAuthPath: string | undefined;
  if (credential !== undefined) {
    const childStore = new PiAuthStore(childAuthPath);
    if ((await childStore.list()).length !== 0) {
      throw new Error("swarm child Pi auth store must start empty");
    }
    await childStore.modify(providerId, async () => credential);
    const staged = await childStore.list();
    if (staged.length !== 1 || staged[0]?.providerId !== providerId) {
      throw new Error("swarm child Pi auth store did not preserve provider isolation");
    }
    stagedAuthPath = childAuthPath;
  }

  if (!ambient && !stagedAuthPath) return undefined;
  return {
    ...(stagedAuthPath ? { piAuthPath: stagedAuthPath } : {}),
    ...(ambient?.env ? { env: ambient.env } : {}),
  };
}

/** Allocate distinct private process and Dokkabi homes beneath a host-owned
 * swarm root. Exact 0700 modes are reasserted before the request is built. */
export function createSwarmChildPrivateHome(
  root: string,
  childSession: string,
): SwarmChildPrivateHome {
  const segment = childSession.replace(/[^a-zA-Z0-9._-]/gu, "_");
  if (!segment || segment !== childSession) throw new Error("swarm child session cannot name a private home");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const canonicalRoot = realpathSync(root);
  const container = join(canonicalRoot, "private", segment);
  mkdirSync(container, { recursive: true, mode: 0o700 });
  chmodSync(container, 0o700);
  const containerRelative = relative(canonicalRoot, realpathSync(container));
  if (lstatSync(container).isSymbolicLink() || !containerRelative ||
    containerRelative.startsWith("..") || isAbsolute(containerRelative)) {
    throw new Error("swarm child private home escaped its host root");
  }
  const home = join(container, "home");
  const dokkabiHome = join(container, "dokkabi");
  for (const path of [home, dokkabiHome]) {
    mkdirSync(path, { recursive: false, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return validatePrivateHome({ home, dokkabiHome });
}

export function swarmChildEventLogPath(home: SwarmChildPrivateHome, childSession: string): string {
  const validated = validatePrivateHome(home);
  const segment = childSession.replace(/[^a-zA-Z0-9._-]/gu, "_");
  if (!segment || segment !== childSession) throw new Error("invalid swarm child session for EventLog path");
  return join(validated.dokkabiHome, "sessions", segment, "events.jsonl");
}

function selectRuntimeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!RUNTIME_ENV_KEYS.has(key) && !/^LC_[A-Z0-9_]+$/u.test(key)) continue;
    if (value === undefined || value.length === 0) continue;
    selected[key] = requireSafeValue(value, `runtime environment ${key}`);
  }
  return selected;
}

function selectRouteAuthority(
  route: string,
  authority?: SwarmChildRouteAuthority,
): { readonly piAuthPath?: string; readonly env: Readonly<Record<string, string>> } {
  if (!authority) return { env: {} };
  requireAllowedKeys(authority, ["env", "piAuthPath"], "swarm route authority");
  const allowed = new Set(ROUTE_ENV_KEYS[route] ?? []);
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(authority.env ?? {})) {
    if (!allowed.has(key)) {
      throw new Error(`route authority ${key} is not allowed for selected route ${route}`);
    }
    if (value === undefined || value.length === 0) continue;
    selected[key] = requireSafeValue(value, `route authority ${key}`);
  }
  const piAuthPath = authority.piAuthPath === undefined
    ? undefined
    : requireAbsolutePath(authority.piAuthPath, "Pi auth path");
  return { ...(piAuthPath ? { piAuthPath } : {}), env: selected };
}

function selectWorldEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!WORLD_ENV_KEYS.has(key)) {
      throw new Error(`swarm world environment ${key} is not allowed`);
    }
    if (value === undefined) continue;
    selected[key] = requireSafeValue(value, `swarm world environment ${key}`, true);
  }
  return selected;
}

function validatePrivateHome(value: SwarmChildPrivateHome): SwarmChildPrivateHome {
  requireExactKeys(value, ["dokkabiHome", "home"], "swarm child private home");
  const home = requirePrivateDirectory(value.home, "child HOME");
  const dokkabiHome = requirePrivateDirectory(value.dokkabiHome, "child DOKKABI_HOME");
  if (home === dokkabiHome) throw new Error("child HOME and DOKKABI_HOME must be distinct private directories");
  return { home, dokkabiHome };
}

function requirePrivateDirectory(value: string, label: string): string {
  const path = requireAbsolutePath(value, label);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} must be a host-created private directory`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a host-created directory`);
  if ((stat.mode & 0o700) !== 0o700 || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must be mode 0700`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current host user`);
  }
  return path;
}

function validateMemoryBinding(value: SwarmChildMemoryBinding): SwarmChildMemoryBinding {
  requireExactKeys(value, ["blobDigest", "repositoryDigest", "viewDigest"], "swarm memory binding");
  requireDigest(value.repositoryDigest, "swarm repository digest");
  requireDigest(value.viewDigest, "swarm memory view digest");
  requireDigest(value.blobDigest, "swarm memory blob digest");
  return value;
}

function validateCapabilityBinding(value: SwarmChildCapabilityBinding): SwarmChildCapabilityBinding {
  requireExactKeys(value, ["pluginManifestDigest", "toolSchemaDigest"], "swarm child capability binding");
  requireDigest(value.pluginManifestDigest, "swarm plugin manifest digest");
  requireDigest(value.toolSchemaDigest, "swarm child tool schema digest");
  return value;
}

function requireDigest(value: string, label: string): void {
  if (!HEX.test(value)) throw new Error(`${label} must be a 64-character lowercase hex digest`);
}

function requireAbsolutePath(value: string, label: string): string {
  const safe = requireSafeValue(value, label);
  if (!isAbsolute(safe)) throw new Error(`${label} must be absolute`);
  return resolve(safe);
}

function requireSafeValue(value: string, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function requireAllowedKeys(value: object, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new Error(`${label} has unknown fields`);
  }
}

function pathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
