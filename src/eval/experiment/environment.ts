import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const VARIABLES = new Set(["LANG", "LC_ALL", "TZ", "NO_COLOR", "DOKKABI_EFFORT", "DOKKABI_TEMPERATURE",
  "DOKKABI_EXPERIMENT_MANIFEST", "DOKKABI_EXPERIMENT_REQUEST", "DOKKABI_EVAL_ABLATE", "DOKKABI_RESEARCH_POLICY", "DOKKABI_RESEARCH_POLICY_SHA256",
  "DOKKABI_SWE_PYTHON", "DOKKABI_SWE_CONTAINER", "DOKKABI_SWE_IMAGE", "DOKKABI_DOCKER_NETWORK_STATE",
  "DOKKABI_VLLM_BASE_URL", "VLLM_BASE_URL", "VLLM_CONTEXT_WINDOW", "VLLM_MAX_TOKENS",
  "DOKKABI_STREAM_IDLE_MS", "DOKKABI_STREAM_FIRST_DELTA_MS"]);
const CREDENTIALS = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "VLLM_API_KEY", "NVIDIA_API_KEY",
  "XAI_API_KEY", "GEMINI_API_KEY", "KIMI_API_KEY", "ZAI_API_KEY", "MINIMAX_API_KEY"]);
export function researchHash(body: string | Buffer): string { return createHash("sha256").update(body).digest("hex"); }
export function researchPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || /[\0\r\n]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("research path must be canonical and relative");
  return join(root, path);
}
export function researchContains(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function directory(path: string): string {
  if (!isAbsolute(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("research directory must be a real absolute directory");
  return realpathSync(path);
}
export interface ResearchEnvironmentInput {
  home: string; dokkabiHome: string; workspace: string; temp: string; runtime: string; route: string; model: string;
  variables?: Readonly<Record<string, string>>; credentials?: Readonly<Record<string, string>>;
}
export function researchEnvironment(input: ResearchEnvironmentInput): Readonly<Record<string, string>> {
  const home = directory(input.home), state = directory(input.dokkabiHome), workspace = directory(input.workspace), temp = directory(input.temp);
  const dirs = [home, state, workspace, temp];
  if (dirs.some((path, i) => dirs.some((other, j) => i !== j && researchContains(path, other)))) throw new Error("research directories must be disjoint");
  const runtime = realpathSync(input.runtime);
  const selected: Record<string, string> = {};
  for (const [values, allowed] of [[input.variables ?? {}, VARIABLES], [input.credentials ?? {}, CREDENTIALS]] as const) {
    for (const [key, value] of Object.entries(values)) {
      if (!allowed.has(key) || typeof value !== "string" || !value || /[\0\r\n]/u.test(value)) throw new Error(`research environment key refused: ${key}`);
      selected[key] = value;
    }
  }
  for (const value of [input.route, input.model]) if (!value || /[\0\r\n]/u.test(value)) throw new Error("research route/model required");
  return Object.freeze({
    PATH: `${dirname(runtime)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C.UTF-8", TZ: "UTC", NO_COLOR: "1", ...selected,
    HOME: home, DOKKABI_HOME: state, TMPDIR: temp, TMP: temp, TEMP: temp,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), BUN_INSTALL_CACHE_DIR: join(home, ".bun/cache"),
    npm_config_cache: join(home, ".npm"), PIP_CACHE_DIR: join(home, ".cache/pip"), PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", NPM_CONFIG_USERCONFIG: "/dev/null",
    DOKKABI_PI_AUTH: join(home, ".pi/agent/auth.json"), DOKKABI_ROUTE: input.route, DOKKABI_MODEL: input.model,
    DOKKABI_EXTERNAL_KNOWLEDGE: "deny", DOKKABI_SANDBOX: "on", DOKKABI_SANDBOX_TOOLCHAIN: "deny",
  });
}

/** Every launch-critical byte is a regular, bounded file. Reject all symlink
 * components, including ancestor aliases beneath the declared input root. */
export function researchRead(root: string, path: string): Buffer {
  const canonical = directory(root), target = researchPath(canonical, path);
  let current = canonical;
  for (const part of path.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error("research input symlink refused"); }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("research input must be a bounded regular file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function durableResearchFile(path: string, body: string | Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export interface ResearchFile { path: string; sha256: string; executable?: boolean }
export interface ResearchAttemptHome {
  root: string; home: string; dokkabiHome: string; workspace: string; temp: string;
  inputs: ResearchFile[]; environment: Readonly<Record<string, string>>;
}
export function prepareResearchHome(input: { root: string; sourceRoot: string; files: readonly ResearchFile[];
  runtime: string; route: string; model: string; variables?: Record<string, string>; credentials?: Record<string, string> }): ResearchAttemptHome {
  const parent = directory(input.root), source = directory(input.sourceRoot);
  if (researchContains(source, parent)) throw new Error("research output cannot be inside candidate source");
  const root = mkdtempSync(join(parent, "attempt-"));
  const home = join(root, "home"), dokkabiHome = join(root, "state"), workspace = join(root, "workspace"), temp = join(root, "tmp");
  for (const path of [home, dokkabiHome, workspace, temp]) mkdirSync(path, { mode: 0o700 });
  const paths = new Set<string>();
  for (const file of input.files) {
    if (paths.has(file.path)) throw new Error("duplicate research input"); paths.add(file.path);
    const body = researchRead(source, file.path);
    if (researchHash(body) !== file.sha256) throw new Error("research input digest mismatch");
    const target = researchPath(workspace, file.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    durableResearchFile(target, body);
    if (file.executable) chmodSync(target, 0o700);
  }
  const environment = researchEnvironment({ ...input, home, dokkabiHome, workspace, temp });
  const recorded = Object.fromEntries(Object.entries(environment).filter(([key]) => !CREDENTIALS.has(key)));
  durableResearchFile(join(root, "inputs.json"), JSON.stringify({ schema_version: 1, cache_policy: "cold-private", memory_policy: "empty-private",
    files: input.files, environment: recorded, credential_keys: Object.keys(input.credentials ?? {}).sort(), runtime_sha256: researchHash(readFileSync(input.runtime)),
  }) + "\n");
  return { root, home, dokkabiHome, workspace, temp, environment, inputs: structuredClone([...input.files]) };
}
