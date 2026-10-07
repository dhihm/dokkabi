import type { HandshakeResponse } from "./WorkbenchProtocol.ts";

/** Resolve only authenticated catalog identities, preserving legacy bare IDs. */
export function requestedDokkabiModel(
  request: string,
  identity: HandshakeResponse,
): { route: string; model: string } | undefined {
  const exact = identity.models?.find((entry) => `${entry.route}/${entry.model}` === request);
  if (exact) return { route: exact.route, model: exact.model };
  if (identity.model === request) return { route: identity.route, model: request };
  const bare = identity.models?.filter((entry) => entry.model === request) ?? [];
  if (bare.length === 1) return { route: bare[0]!.route, model: bare[0]!.model };
  return undefined;
}
