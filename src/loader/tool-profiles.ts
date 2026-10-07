export const TOOL_PROFILE_NAMES = [
  "docs",
  "inspect",
  "kernel_work",
  "remote",
  "last_word",
  "verify",
  "default",
] as const;

export type ToolProfileName = (typeof TOOL_PROFILE_NAMES)[number];

export interface ToolScope {
  readonly todo: string;
  readonly profile: ToolProfileName;
}

const PROFILE_TOOLS = {
  docs: ["read", "write", "edit", "glob", "grep"],
  inspect: ["read", "ls", "glob", "grep", "probe_log", "maek"],
  kernel_work: ["bash", "read", "write", "edit", "git_diff"],
  remote: ["ssh", "read", "write", "bash"],
  /** The ledger driver's final boundary (D33): the one tool that ends the
   * session honestly. Never a todo's declared profile — but the same closed
   * projection if a plan ever names it. */
  last_word: ["finish"],
  /** The verifier session's surface (D39): a session that did not build the
   * tree in front of it, writes its own scripts and fixtures, runs them
   * (booting a server in the background included), records each check as a
   * ledger case — through `check` (D48), which runs it and records it in one
   * call — states a rule over many inputs through `property` (D58), and
   * reports each defect through `defect`. It rules on the checks
   * a fix session disputed through `ruling` (D54). Everything an
   * ordinary session has for that work and nothing else — no external
   * knowledge, no evidence index, no git views, no operator question: it is
   * unattended, it works from the tree it was handed, and its durable record
   * is the rows it appends, not a note it would have to re-read itself. */
  verify: [
    "bash", "bash_poll", "bash_wait", "bash_kill", "bash_probe",
    "read", "write", "edit", "ls", "glob", "grep",
    "check", "property", "plan", "defect", "ruling", "finish",
  ],
  default: [],
} as const satisfies Readonly<Record<ToolProfileName, readonly string[]>>;

export function isToolProfileName(value: unknown): value is ToolProfileName {
  return typeof value === "string"
    && (TOOL_PROFILE_NAMES as readonly string[]).includes(value);
}

export function toolProfileToolNames(profile: ToolProfileName): string[] {
  return [...PROFILE_TOOLS[profile]];
}

export function projectTools<T extends { readonly name: string }>(
  tools: readonly T[],
  profile: ToolProfileName,
): T[] {
  if (profile === "default") return [...tools];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return PROFILE_TOOLS[profile]
    .map((name) => byName.get(name))
    .filter((tool): tool is T => tool !== undefined);
}

export function toolScopeForTodo(todo: {
  readonly id: string;
  readonly profile?: ToolProfileName;
}): ToolScope {
  return { todo: todo.id, profile: todo.profile ?? "default" };
}
