import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { containsSecretValue, redactText } from "../../src/host/redact.ts";

const paths = Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 128 });
const object = (fields: Parameters<typeof Type.Object>[0]) => Type.Object(fields, { additionalProperties: false });
export const GitParameters = Type.Union([
  object({ op: Type.Literal("status") }),
  object({ op: Type.Literal("diff"), staged: Type.Optional(Type.Boolean()) }),
  object({ op: Type.Literal("log"), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
  object({ op: Type.Literal("branch_create"), name: Type.String() }),
  object({ op: Type.Literal("branch_switch"), name: Type.String() }),
  object({ op: Type.Literal("stage"), paths }),
  object({ op: Type.Literal("commit"), paths, message: Type.String({ minLength: 1, maxLength: 4000 }) }),
  object({ op: Type.Literal("push") }),
  object({ op: Type.Literal("fetch_revision"), revision: Type.String({ pattern: "^[a-f0-9]{40}$" }) }),
]);
export type Push = (signal?: AbortSignal) => Promise<{ text: string; error: boolean }>;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const result = (text: string, error = false) => ({ content: [{ type: "text" as const, text }], details: { error } });
const fields: Record<string, string[]> = {
  status: [], diff: ["staged"], log: ["limit"], branch_create: ["name"], branch_switch: ["name"], stage: ["paths"], commit: ["paths", "message"], push: [], fetch_revision: ["revision"],
};
function validate(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git needs structured arguments");
  const p = value as Record<string, unknown>, keys = typeof p.op === "string" ? fields[p.op] : undefined;
  if (!keys || Object.keys(p).some(k => k !== "op" && !keys.includes(k))) throw new Error("Unsupported Git operation or fields");
  if (containsSecretValue(p)) throw new Error("Git arguments contain a credential pattern");
  if (p.op === "stage" || p.op === "commit") {
    if (!Array.isArray(p.paths) || p.paths.length < 1 || p.paths.length > 128 || p.paths.some(path =>
      typeof path !== "string" || !path || path.length > 4096 || /[\x00-\x1f\x7f\\]/.test(path) || path.startsWith("/") || path.startsWith(":") || path.split("/").some(s => !s || s === "." || s === ".." || s.toLowerCase() === ".git"))) throw new Error("Git paths must be explicit relative workspace files");
    if (new Set(p.paths).size !== p.paths.length) throw new Error("Git paths must be unique");
  }
  if (p.op === "commit" && (typeof p.message !== "string" || !p.message.trim() || p.message.length > 4000 || p.message.includes("\0"))) throw new Error("Git commit needs a nonempty message");
  if (p.op === "branch_create" || p.op === "branch_switch") {
    if (typeof p.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(p.name) || /\.\.|\/\/|\.lock(?:\/|$)|\/$/.test(p.name)) throw new Error("Git needs a safe branch name");
  }
  if (p.staged !== undefined && typeof p.staged !== "boolean") throw new Error("Git staged must be boolean");
  if (p.limit !== undefined && (!Number.isInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 100)) throw new Error("Git log limit must be 1 to 100");
}

/** One model-facing Git workflow; local effects reuse the fenced bash tool,
 * and push reuses host-owned authentication and approval without exposing it. */
export function createGitTool(bash: AgentTool, push?: Push, fetchRevision?: (revision:string)=>{text:string;error:boolean}): AgentTool<typeof GitParameters> {
  return {
    name: "git", label: "Git workspace workflow",
    description: "Structured current-workspace Git status, diff, log, branch_create (creates and switches), branch_switch, stage explicit files, commit exactly the specified staged paths, push, and fetch_revision(full commit SHA). Fetch reads only the workspace GitHub origin into the object store, leaving HEAD and refs unchanged; useful for exact author-revision comparison. Push uses the host permission-mode policy (bypass supports public/private origins and any checked-out branch); no remote/ref/token/force arguments. Hooks are disabled: run validation explicitly before committing. No arbitrary Git commands or workspace paths.",
    parameters: GitParameters,
    async execute(id, params, signal) {
      try { validate(params); } catch (error) { return result((error as Error).message, true); }
      const p = params as Record<string, unknown>;
      if (p.op === "fetch_revision") {
        if (typeof p.revision !== "string" || !/^[a-f0-9]{40}$/.test(p.revision)) return result("fetch_revision needs a full commit SHA", true);
        if (!fetchRevision) return result("Exact GitHub revision fetch is unavailable", true);
        const r=fetchRevision(p.revision);return result(r.text,r.error);
      }
      if (p.op === "push") {
        if (!push) return result("Authorized GitHub push is unavailable in this session", true);
        try { const r = await push(signal); return result(r.text, r.error); }
        catch (error) { return result(redactText((error as Error).message), true); }
      }
      const prefix = "git --literal-pathspecs -c core.hooksPath=/dev/null";
      let command: string;
      switch (p.op) {
        case "status": command = `${prefix} status --short --branch`; break;
        case "diff": command = `${prefix} diff ${p.staged ? "--cached " : ""}--no-ext-diff --no-textconv --`; break;
        case "log": command = `${prefix} log --oneline --decorate -n ${p.limit ?? 10}`; break;
        case "branch_create": command = `${prefix} check-ref-format --branch ${quote(String(p.name))} && ${prefix} switch -c ${quote(String(p.name))}`; break;
        case "branch_switch": command = `${prefix} switch -- ${quote(String(p.name))}`; break;
        case "stage": {
          const selected = p.paths as string[];
          const checks = selected.map(path => `if [ -d ${quote(path)} ]; then printf '%s\\n' 'Git stage needs files, not directories' >&2; exit 1; fi`).join("\n");
          command = `${checks}\n${prefix} add -A -- ${selected.map(quote).join(" ")}`; break;
        }
        case "commit": {
          const selected = [...p.paths as string[]].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(quote).join(" ");
          command = `actual=$(${prefix} diff --cached --name-only --no-renames -z | ${prefix} hash-object --stdin) || exit 1\nexpected=$(printf '%s\\000' ${selected} | ${prefix} hash-object --stdin) || exit 1\nif [ "$actual" != "$expected" ]; then printf '%s\\n' 'Git commit refused: staged paths differ from the explicit selection' >&2; exit 1; fi\n${prefix} diff --cached --quiet && { printf '%s\\n' 'Git commit refused: no staged changes' >&2; exit 1; }\n${prefix} commit -m ${quote(String(p.message))} && ${prefix} rev-parse HEAD`; break;
        }
        default: return result("Unsupported Git operation", true);
      }
      try {
        const outcome = await bash.execute(id, { command, timeout: 60 }, signal);
        const details = outcome.details as Record<string, unknown>;
        return { ...outcome, details: { ...details, error: details?.error === true || (details?.state !== undefined && details.state !== "completed") } };
      } catch (error) { return result(redactText((error as Error).message), true); }
    },
  };
}
