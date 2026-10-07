import type { CaseRunner } from "./case-runners.ts";

/**
 * Declarative case-runner spec: pure DATA describing how one test runner is
 * invoked and how its commands name a test file. The engine below does the
 * matching once, generically — specs never carry regexes, so runner knowledge
 * stays flat, reviewable, and JSON-serializable (a model or an operator can
 * register a spec as a plugin without writing code).
 */
export interface RunnerInvocation {
  /** Accepted argv[0] basenames after normalization (paths and ${VAR:-default} resolved). */
  programs: string[];
  /** Tokens that must follow the program exactly, e.g. ["-m", "pytest"] or ["test"]. */
  subcommand?: string[];
}

export interface RunnerTestFileRule {
  /** A token naming the test file must end with one of these (".py", "_test.go", …). */
  extensions: string[];
  /** Accepted test directory segments; filename selectors below are alternatives. */
  dir_segments?: string[];
  /** Conventional test basenames accepted outside a dedicated test directory. */
  basename_prefixes?: string[];
  basename_suffixes?: string[];
  /** Module-runner options that take no value, such as unittest -v. */
  switches?: string[];
  /** Basenames that never count as test files ("conftest.py", "__init__.py"). */
  exclude_basenames?: string[];
  /**
   * For runners that take a test NAME instead of a path (cargo test --test
   * dag_quality): the token after `flag` fills `{name}` in `template`.
   */
  flag_map?: { flag: string; template: string };
  /**
   * Map a dotted module token (tests.test_foo) to a file path
   * (tests/test_foo.py). Used by stdlib unittest `-m` invocations.
   */
  module_paths?: boolean;
}

export interface RunnerSpec {
  id: string;
  /** Command shape shown to the model in prompts and refusals. */
  example?: string;
  /** A command matches the runner when ONE invocation matches its tokens. */
  invocations: RunnerInvocation[];
  test_file: RunnerTestFileRule;
  /** Reference to a host-enrolled evaluator; this declaration grants no authority. */
  measurement_evaluator?: string;
}

/** Whitespace tokens with surrounding quotes stripped. */
export function tokenizeRunnerCommand(command: string): string[] {
  const tokens = command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => token.length > 0);
  const firstProgram = tokens.findIndex(
    (token) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token),
  );
  return firstProgram < 0 ? [] : tokens.slice(firstProgram);
}

/**
 * Canonical program name: `${VAR:-default}` resolves to its default and a
 * path (venv interpreters, absolute tool paths) resolves to its basename.
 * This normalization is WHY specs stay small — every indirection the old
 * head regexes enumerated is handled once here.
 */
function normalizeProgram(token: string): string {
  const expanded = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]+)\}$/.exec(token)?.[1] ?? token;
  return expanded.split("/").pop() ?? expanded;
}

function invocationMatches(invocation: RunnerInvocation, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  if (!invocation.programs.includes(normalizeProgram(tokens[0]!))) {
    return false;
  }
  const subcommand = invocation.subcommand ?? [];
  return subcommand.every((word, index) => tokens[1 + index] === word);
}

function acceptedTestPath(path: string, rule: RunnerTestFileRule): boolean {
  if (!rule.extensions.some(extension => path.endsWith(extension))) return false;
  const parts = path.split("/"), name = parts.at(-1)!;
  if (rule.exclude_basenames?.includes(name)) return false;
  const directories = rule.dir_segments ?? [], prefixes = rule.basename_prefixes ?? [], suffixes = rule.basename_suffixes ?? [];
  return !(directories.length || prefixes.length || suffixes.length)
    || directories.some(segment => parts.slice(0, -1).includes(segment))
    || prefixes.some(prefix => name.startsWith(prefix)) || suffixes.some(suffix => name.endsWith(suffix));
}

function modulePathFromToken(token: string, rule: RunnerTestFileRule): string | undefined {
  if (!rule.module_paths || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(token)
    || rule.extensions.some(extension => token.endsWith(extension))) return undefined;
  const ext = rule.extensions[0];
  if (!ext) return undefined;
  const classShape = /^[A-Z]\w*$/u;
  let parts = token.split(".");
  while (parts.length > 1) {
    const last = parts.at(-1)!, previous = parts.at(-2)!;
    if ((/^test_/u.test(last) && classShape.test(previous)) || classShape.test(last)) parts = parts.slice(0, -1);
    else break;
  }
  const path = `${parts.join("/")}${ext}`;
  return acceptedTestPath(path, rule) ? path : undefined;
}

function ruleTestFile(rule: RunnerTestFileRule, tokens: string[]): string | undefined {
  if (rule.flag_map) {
    const index = tokens.indexOf(rule.flag_map.flag), name = index >= 0 ? tokens[index + 1] : undefined;
    if (name && !name.startsWith("-")) return rule.flag_map.template.replaceAll("{name}", name);
  }
  let positional = tokens.slice(1);
  if (rule.module_paths) {
    // Filter values cannot become test files, even when they look like paths.
    // Declared zero-argument switches leave the next positional module intact.
    positional = [];
    let skipValue = false;
    for (const token of tokens.slice(1)) {
      if (skipValue) { skipValue = false; continue; }
      if (token.startsWith("-")) { skipValue = !token.includes("=") && !rule.switches?.includes(token); continue; }
      positional.push(token);
    }
  }
  for (const token of positional) {
    const path = (token.split("::")[0] ?? "").replace(/^\.\//, "");
    if (acceptedTestPath(path, rule)) return path;
    const module = modulePathFromToken(token, rule);
    if (module) return module;
  }
  return undefined;
}

/** Compile a spec into the runtime CaseRunner shape the registry stores. */
export function compileRunnerSpec(spec: RunnerSpec): CaseRunner {
  spec = freezeRunnerData(structuredClone(spec));
  return {
    definition: spec,
    id: spec.id,
    example: spec.example,
    ...(spec.measurement_evaluator === undefined ? {} : { measurementEvaluator: spec.measurement_evaluator }),
    matches: (command) => {
      const tokens = tokenizeRunnerCommand(command);
      return spec.invocations.some((invocation) => invocationMatches(invocation, tokens));
    },
    testFile: (command) => {
      const tokens = tokenizeRunnerCommand(command);
      if (!spec.invocations.some((invocation) => invocationMatches(invocation, tokens))) {
        return undefined;
      }
      return ruleTestFile(spec.test_file, tokens);
    },
  };
}

/**
 * Gate for specs arriving as data (work/runners/*.json, catalog files, a
 * model-written spec). Concrete reasons, never a crash — a refused spec is
 * feedback the model can act on.
 */
export function validateRunnerSpec(value: unknown): { spec?: RunnerSpec; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["runner spec must be a JSON object"] };
  }
  const raw = value as Record<string, unknown>;
  const isStringArray = (input: unknown): input is string[] =>
    Array.isArray(input) && input.length > 0 && input.every((item) => typeof item === "string" && item.trim().length > 0);

  if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) {
    errors.push("runner spec needs id: lowercase slug like go-test");
  }
  if (raw.example !== undefined && (typeof raw.example !== "string" || !raw.example.trim())) {
    errors.push("runner spec example must be a non-empty string when present");
  }
  if (raw.measurement_evaluator !== undefined
    && (typeof raw.measurement_evaluator !== "string" || !/^[a-z0-9][a-z0-9._-]*$/u.test(raw.measurement_evaluator))) {
    errors.push("runner measurement_evaluator must name a host-enrolled evaluator");
  }
  const invocations: RunnerInvocation[] = [];
  if (!Array.isArray(raw.invocations) || raw.invocations.length === 0) {
    errors.push("runner spec needs invocations: a non-empty array of { programs, subcommand? }");
  } else {
    for (const [index, entry] of raw.invocations.entries()) {
      const invocation = entry as Record<string, unknown>;
      if (!isStringArray(invocation?.programs)) {
        errors.push(`invocations[${index}].programs must be a non-empty string array`);
        continue;
      }
      if (invocation.subcommand !== undefined && !isStringArray(invocation.subcommand)) {
        errors.push(`invocations[${index}].subcommand must be a non-empty string array when present`);
        continue;
      }
      invocations.push({
        programs: invocation.programs as string[],
        subcommand: invocation.subcommand as string[] | undefined,
      });
    }
  }
  const testFileRaw = raw.test_file as Record<string, unknown> | undefined;
  if (typeof testFileRaw !== "object" || testFileRaw === null || !isStringArray(testFileRaw.extensions)) {
    errors.push('runner spec needs test_file.extensions: e.g. [".py"] or ["_test.go"]');
  } else {
    if (testFileRaw.dir_segments !== undefined && !isStringArray(testFileRaw.dir_segments)) {
      errors.push("test_file.dir_segments must be a non-empty string array when present");
    }
    for (const field of ["basename_prefixes", "basename_suffixes", "switches"] as const) {
      if (testFileRaw[field] !== undefined && !isStringArray(testFileRaw[field])) errors.push(`test_file.${field} must be a non-empty string array when present`);
    }
    if (testFileRaw.module_paths !== undefined && typeof testFileRaw.module_paths !== "boolean") errors.push("test_file.module_paths must be a boolean when present");
    if (testFileRaw.exclude_basenames !== undefined && !isStringArray(testFileRaw.exclude_basenames)) {
      errors.push("test_file.exclude_basenames must be a non-empty string array when present");
    }
    if (testFileRaw.flag_map !== undefined) {
      const flagMap = testFileRaw.flag_map as Record<string, unknown>;
      if (
        typeof flagMap !== "object" || flagMap === null ||
        typeof flagMap.flag !== "string" || !flagMap.flag.trim() ||
        typeof flagMap.template !== "string" || !flagMap.template.includes("{name}")
      ) {
        errors.push('test_file.flag_map needs { "flag": "--test", "template": "tests/{name}.rs" }');
      }
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  const spec: RunnerSpec = {
    id: raw.id as string,
    example: raw.example as string | undefined,
    ...(raw.measurement_evaluator === undefined ? {} : { measurement_evaluator: raw.measurement_evaluator as string }),
    invocations,
    test_file: {
      extensions: (testFileRaw!.extensions as string[]),
      dir_segments: testFileRaw!.dir_segments as string[] | undefined,
      basename_prefixes: testFileRaw!.basename_prefixes as string[] | undefined,
      basename_suffixes: testFileRaw!.basename_suffixes as string[] | undefined,
      switches: testFileRaw!.switches as string[] | undefined,
      module_paths: testFileRaw!.module_paths as boolean | undefined,
      exclude_basenames: testFileRaw!.exclude_basenames as string[] | undefined,
      flag_map: testFileRaw!.flag_map as RunnerTestFileRule["flag_map"],
    },
  };
  if (spec.example !== undefined && !compileRunnerSpec(spec).matches(spec.example)) {
    return {
      errors: [
        "runner spec example must match an invocation: programs are alternative executable basenames, and subcommand is the ordered tokens after the executable",
      ],
    };
  }
  return { errors: [], spec };
}

/** Runner closures and their recorded declarations share immutable values. */
function freezeRunnerData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeRunnerData(item);
    Object.freeze(value);
  }
  return value;
}
