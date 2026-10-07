import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HostContext } from "../../src/loader/types.ts";
import type { EventLog } from "../../src/host/event-log.ts";
import { BlobStore } from "../../src/host/blob-store.ts";
import type { ResultProjection } from "../../src/tools/model-result.ts";
import { deliverToolResult } from "../../src/host/result-source.ts";
import { redactText } from "../../src/host/redact.ts";

interface Request {
  op: "checks" | "run" | "jobs" | "job_log" | "source";
  owner: string; repo: string;
  number?: number; run_id?: number; job_id?: number; source_ref?: number; offset?: number;
}
type Runner = (argv: string[]) => Promise<string>;
const defaultRunner: Runner = async argv => {
  const r = Bun.spawnSync(argv, { cwd: "/", stdout: "pipe", stderr: "pipe", timeout: 45_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new Error(`GitHub CI read failed: ${redactText(r.stderr.toString()).slice(0, 300)}`);
  return r.stdout.toString();
};
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;

/** Full redacted source is immutable; continuation never refetches a log. */
export async function githubCiRead(log: EventLog, p: Request, runner: Runner = defaultRunner, invocationId?: string) {
  try {
    if (!/^[A-Za-z0-9_.-]+$/.test(p.owner) || !/^[A-Za-z0-9_.-]+$/.test(p.repo) || [p.owner,p.repo].some(v => v === "." || v === "..")) throw new Error("Invalid repository names");
    const target = `${p.owner}/${p.repo}`;
    let sourceRef: number, body: string, sourceBlob: string;
    if (p.op === "source") {
      const row = log.events.find(e => e.seq === p.source_ref);
      if (!positive(p.source_ref) || !row || row.name !== "github_ci/result" || row.payload.repo !== target || typeof row.payload.source_blob !== "string") throw new Error("Source must reference this repository's observed CI result");
      sourceRef = row.seq; sourceBlob = row.payload.source_blob; body = BlobStore.forSession(log.path).get(sourceBlob);
    } else {
      let argv: string[];
      const prefix = `repos/${target}/actions`;
      switch (p.op) {
        case "checks":
          if (!positive(p.number)) throw new Error("checks requires positive PR number");
          argv = ["gh","pr","view",String(p.number),"--repo",target,"--json","headRefOid,statusCheckRollup"]; break;
        case "run":
          if (!positive(p.run_id)) throw new Error("run requires positive run_id");
          argv = ["gh","api",`${prefix}/runs/${p.run_id}`]; break;
        case "jobs":
          if (!positive(p.run_id)) throw new Error("jobs requires positive run_id");
          argv = ["gh","api",`${prefix}/runs/${p.run_id}/jobs?per_page=100`,"--paginate","--slurp"]; break;
        case "job_log":
          if (!positive(p.job_id)) throw new Error("job_log requires positive job_id");
          argv = ["gh","api",`${prefix}/jobs/${p.job_id}/logs`]; break;
        default: throw new Error("Unsupported read-only CI operation");
      }
      log.append({ kind: "effect", name: "github_ci/read", payload: { repo: target, op: p.op, ...(p.number ? { number:p.number } : {}), ...(p.run_id ? { run_id:p.run_id } : {}), ...(p.job_id ? { job_id:p.job_id } : {}) } });
      body = redactText(await runner(argv));
      const source_blob = BlobStore.forSession(log.path).put(body);
      sourceBlob = source_blob;
      sourceRef = log.append({ kind: "observe", name: "github_ci/result", payload: { repo:target, op:p.op, status:"completed", source_blob, bytes:Buffer.byteLength(body), ...(p.run_id ? { run_id:p.run_id } : {}), ...(p.job_id ? { job_id:p.job_id } : {}) } }).seq;
    }
    // Register through the generic host delivery boundary; an arbitrary blob
    // digest is not reader authority. This also supports older retained CI rows.
    const retained = deliverToolResult({ log, invocationId: invocationId ?? `github-ci-${sourceRef}`,
      tool: "github_ci", result: { content: [{ type: "text", text: body }] },
      redactedStrings: 0, readerAuthorised: true, forceSource: true });
    const projection = (retained as { details?: { result_source?: ResultProjection } }).details?.result_source;
    if (projection?.source.source.kind !== "blob") throw new Error("Could not retain a readable CI source");
    sourceBlob = projection.source.source.digest;
    const bytes = Buffer.from(body), offset = p.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) throw new Error("offset must be a valid UTF-8 byte boundary within the source");
    let end = Math.min(bytes.length, offset + 4000);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const text = bytes.subarray(offset,end).toString();
    log.append({ kind:"observe", name:"github_ci/window", payload:{ repo:target, source_ref:sourceRef, offset, end, total:bytes.length } });
    return { error:false, source_ref:sourceRef, source_blob:sourceBlob, text, next_offset:end < bytes.length ? end : null, bytes:bytes.length };
  } catch (e) {
    const reason = redactText(e instanceof Error ? e.message : "GitHub CI unavailable");
    log.append({ kind:"observe", name:"github_ci/refused", payload:{ op:p.op, reason } });
    return { error:true, source_ref:0, text:reason, next_offset:null, bytes:0 };
  }
}
const Parameters = Type.Object({
  op:Type.Union(["checks","run","jobs","job_log","source"].map(v=>Type.Literal(v))),
  owner:Type.String(),repo:Type.String(),number:Type.Optional(Type.Integer({minimum:1})),
  run_id:Type.Optional(Type.Integer({minimum:1})),job_id:Type.Optional(Type.Integer({minimum:1})),
  source_ref:Type.Optional(Type.Integer({minimum:1})),offset:Type.Optional(Type.Integer({minimum:0})),
},{additionalProperties:false});
export function createGithubCiTool(ctx:HostContext):AgentTool<typeof Parameters> {
 return { name:"github_ci",label:"GitHub CI inspection",parameters:Parameters,
 description:"Authenticated read-only GitHub Actions access: checks(number) returns PR head and check URLs; run(run_id) reads run revision/status; jobs(run_id) pages job IDs/steps; job_log(job_id) reads logs. Full redacted output is preserved. For targeted evidence in large logs, filter the FULL retained redacted source using probe_log(path=blob:source_blob, script=...). Read relevant failures/assertions and surrounding context; do not scan unrelated log bytes solely because next_offset exists. For complete recovery follow next_offset using source(source_ref,offset) with the SAME owner/repo without refetching. Never treats API HTTP success as CI success. No rerun/cancel/write operations. Load github.ci_repair for operator-authorized CI fixes.",
 async execute(_id,p) {const result=await githubCiRead(ctx.log,p,defaultRunner,_id);return {content:[{type:"text",text:JSON.stringify(result)}],details:{error:result.error}};}};
}
