import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventLog } from "../../host/event-log.ts";
import { inputDigest, projectProviderInputs } from "../../host/provider-input.ts";
import type { EventRecord } from "../../host/schema.ts";
import type { ProviderRequestIdentity } from "../../host/provider-request-guard.ts";
import { systemPromptHash, toolSchemaHash } from "../../host/prefix.ts";
import { registerProviderRequestGuard } from "../../host/provider-request-guard.ts";
import { containsSecretValue } from "../../host/redact.ts";
import { experimentId, sha256Schema } from "./schema.ts";

const jsonObject = z.record(z.string(), z.unknown());
export const researchPolicySchema = z.strictObject({
  schema_version: z.literal(1), id: experimentId, scheduled_key: sha256Schema, attempt_id: experimentId,
  system_prompt_sha256: sha256Schema, tools_sha256: sha256Schema,
  requests: z.array(z.strictObject({ route: experimentId, role: experimentId,
    model: jsonObject, options: jsonObject,
    surface: z.strictObject({ system_prompt_sha256: sha256Schema, tools_sha256: sha256Schema }).optional() })).min(1).max(1000),
});
export type ResearchPolicy = z.infer<typeof researchPolicySchema>;

export function researchRequestRefusal(policy: ResearchPolicy, request: ProviderRequestIdentity): string | null {
  const { context, route, role, model, options } = request;
  const digest = inputDigest({ route, role, model, options });
  const matches = policy.requests.filter(({ surface: _surface, ...tuple }) => inputDigest(tuple) === digest);
  if (!matches.length) return "provider_request_drift";
  const surfaces = matches.map(row => row.surface ?? policy);
  if (!surfaces.some(row => row.system_prompt_sha256 === systemPromptHash(context.systemPrompt))) return "system_prompt_drift";
  if (!surfaces.some(row => row.system_prompt_sha256 === systemPromptHash(context.systemPrompt)
    && row.tools_sha256 === toolSchemaHash(context.tools))) return "tool_schema_drift";
  return null;
}

/** Pure replay qualification over retained policy and structured requests. */
export function auditResearchRequests(events: readonly EventRecord[], bodies: ReadonlyMap<string, unknown>): void {
  const bindings = events.filter(row => row.name === "research/bind");
  const declarations = events.filter(row => row.name === "provider/policy" && row.payload.id === "research");
  if (!bindings.length && !declarations.length) return;
  const policy = researchPolicySchema.parse(bindings[0]?.payload.policy), digest = inputDigest(policy);
  if (!declarations.length || bindings.some(row => row.payload.digest !== digest || inputDigest(row.payload.policy) !== digest)) throw new Error("research replay policy binding mismatch");
  const inputs = projectProviderInputs(events, bodies);
  const deviation = events.find(row => row.name === "research/deviation");
  for (const request of inputs.requests) {
    if (request.ref.seq <= bindings[0]!.seq || request.ref.seq <= declarations[0]!.seq
      || (deviation && request.ref.seq > deviation.seq) || researchRequestRefusal(policy, request)) throw new Error("research replay contains an undeclared or paused request");
  }
  if (deviation && inputs.sends.some(send => send.ref.seq > deviation.seq)) throw new Error("research replay sent after a deviation");
}

/** Bind the complete public request tuple, including endpoint identity and
 * every resolved option. Credentials are never part of the policy body. */
/** The research policy as registration accepts it, or the refusal it would
 * make; no side effect (the research runtime's preflight calls it too). */
export function validateResearchPolicy(raw: unknown): ReturnType<typeof researchPolicySchema.parse> {
  const policy = researchPolicySchema.parse(JSON.parse(canonicalJson(raw)));
  if (containsSecretValue(policy)) throw new Error("research policy cannot retain credentials");
  return policy;
}

export function registerResearchGuard(log: EventLog, raw: unknown): () => void {
  const policy = validateResearchPolicy(raw);
  const digest = inputDigest(policy);
  const earlier = log.events.filter(row => row.name === "research/bind");
  if (earlier.some(row => row.payload.digest !== digest)) throw new Error("research policy changed on resume");
  if (!earlier.length) {
    if (log.events.some(row => /^(provider\/request|tool\/call|work\/run_result)$/u.test(row.name))) throw new Error("research policy must bind before action");
    log.appendBatchDurable(() => [
      { kind: "observe", name: "research/bind", payload: { digest, policy } },
      { kind: "observe", name: "provider/policy", payload: { id: "research" } },
    ]);
  }
  return registerProviderRequestGuard(log, "research", request => {
    if (log.events.some(row => row.name === "research/deviation")) throw new Error("research deviation: attempt is paused");
    const { context, route, role, model, options } = request;
    const actual = { route, role, model, options };
    const reason = researchRequestRefusal(policy, request);
    if (reason) {
      log.appendDurable({ kind: "observe", name: "research/deviation", payload: {
        policy_digest: digest, scheduled_key: policy.scheduled_key, attempt_id: policy.attempt_id,
        reason, actual, system_prompt_sha256: systemPromptHash(context.systemPrompt), tools_sha256: toolSchemaHash(context.tools),
      } });
      throw new Error(`research deviation: ${reason}`);
    }
  });
}
