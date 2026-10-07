import { effectiveSandboxChildEnvironment, type SandboxPolicy } from "../../host/sandbox.ts";
import { toolCacheRootOf } from "../../host/sandbox-env.ts";
import { evidenceDigest } from "./contract.ts";

export type CaseEnvironment = {
  kind: "sealed-child-environment-v1";
  variables: Readonly<Record<string, string>>;
  private_roots: { home?: string; temp?: string; tool_cache?: string };
} | { kind: "ambient-environment-digest-v1"; digest: string };

/** Private roots are fresh host-owned directories, not checker settings.
 * Retain their concrete paths, but compare their explicitly named roles.
 * Every other child-visible value remains part of the contract. */
export function caseEnvironmentContract(environment: CaseEnvironment): unknown {
  if (environment.kind === "ambient-environment-digest-v1") return environment;
  const roots = Object.entries(environment.private_roots).sort((a, b) => b[1].length - a[1].length);
  return { kind: environment.kind, variables: Object.fromEntries(Object.entries(environment.variables).map(([key, value]) => {
    const root = roots.find(([, path]) => value === path || value.startsWith(path + "/"));
    return [key, root ? { private_root: root[0], suffix: value.slice(root[1].length) } : value];
  })) };
}

export function captureCaseEnvironment(policy?: SandboxPolicy): CaseEnvironment {
  if (!policy || policy.disabled || policy.backend === "none") {
    // Unfenced commands/measurement modules may see credentials. Retain only
    // their conservative digest; never publish ambient values in a blob.
    return { kind: "ambient-environment-digest-v1", digest: evidenceDigest(policy?.childEnv ?? process.env) };
  }
  return { kind: "sealed-child-environment-v1", variables: effectiveSandboxChildEnvironment(policy), private_roots: {
    ...(policy.sandboxHome ? { home: policy.sandboxHome } : {}),
    ...(policy.sandboxTemp ? { temp: policy.sandboxTemp } : {}),
    // G3' (D57h): the tool-cache root is a private root of its own role —
    // a judged policy's directory of that policy alone, emptied around every
    // execution, or a policy's home's — private like its home and temp, so
    // two judged runs of one case, or a judged run and the execution view's
    // image of the same checker, keep one contract.
    tool_cache: toolCacheRootOf(policy),
  } };
}
