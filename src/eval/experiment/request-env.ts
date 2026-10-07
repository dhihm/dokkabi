/**
 * The experiment runtime's registration precondition, as one function the
 * plugin calls when it registers and `dokkabi doctor` calls to diagnose a
 * profile (#230, D1): the same decision, never a second copy. It reads the
 * process environment only and throws exactly what registration throws.
 */
export function experimentRequestFromEnv(env: NodeJS.Dict<string> = process.env): {
  readonly path: string;
  readonly request: { readonly condition?: unknown } & Record<string, unknown>;
} {
  const path = env.DOKKABI_EXPERIMENT_MANIFEST, raw = env.DOKKABI_EXPERIMENT_REQUEST;
  if (!path || !raw || !env.DOKKABI_EVAL_ABLATE) throw new Error("registered experiment requires manifest, request and condition");
  const request = JSON.parse(raw) as { readonly condition?: unknown } & Record<string, unknown>;
  if (request.condition !== env.DOKKABI_EVAL_ABLATE) throw new Error("requested experiment condition differs from environment");
  return { path, request };
}
