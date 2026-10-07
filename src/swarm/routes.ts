import type { LlmFacade } from "../loader/types.ts";

export const SWARM_ROLES = ["lead", "scout", "builder", "reviewer"] as const;
export const SWARM_CANDIDATE_ROLES = ["lead", "scout", "builder"] as const;
export const SWARM_REVIEWER_ROLE = "reviewer" as const;

export type SwarmRole = typeof SWARM_ROLES[number];
export type SwarmCandidateRole = typeof SWARM_CANDIDATE_ROLES[number];
export type SwarmRouteMap = Record<SwarmRole, string>;

export interface SwarmAssignment {
  role: SwarmRole;
  route: string;
  /** Optional explicit model id for this role (freeswarm pins a specific free
   * model per role). Absent means the route's default model. */
  model?: string;
}

export const DEFAULT_SWARM_ROUTES: Readonly<SwarmRouteMap> = {
  lead: "vllm",
  scout: "kraken-gpu1",
  builder: "kraken-gpu2",
  reviewer: "kraken-gpu3",
};

const ROLE_ENV: Readonly<Record<SwarmRole, string>> = {
  lead: "DOKKABI_SWARM_LEAD_ROUTE",
  scout: "DOKKABI_SWARM_SCOUT_ROUTE",
  builder: "DOKKABI_SWARM_BUILDER_ROUTE",
  reviewer: "DOKKABI_SWARM_REVIEWER_ROUTE",
};

export function isSwarmRole(value: string): value is SwarmRole {
  return SWARM_ROLES.some((role) => role === value);
}

export function parseSwarmRoles(value?: string): SwarmRole[] {
  if (value === undefined || value.trim() === "") {
    return [...SWARM_ROLES];
  }
  const roles: SwarmRole[] = [];
  const seen = new Set<SwarmRole>();
  for (const item of value.split(",")) {
    const role = item.trim();
    if (!isSwarmRole(role)) {
      throw new Error(`unknown swarm role ${role || "(empty)"}`);
    }
    if (seen.has(role)) {
      throw new Error(`duplicate swarm role ${role}`);
    }
    seen.add(role);
    roles.push(role);
  }
  return roles;
}

export function parseSwarmCandidateRoles(value?: string): SwarmCandidateRole[] {
  const roles = parseSwarmRoles(value ?? SWARM_CANDIDATE_ROLES.join(","));
  return roles.map((role) => {
    if (role === SWARM_REVIEWER_ROLE) {
      throw new Error("reviewer is the final integration role, not a swarm candidate");
    }
    return role;
  });
}

export function resolveSwarmRouteMap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SwarmRouteMap {
  return {
    lead: env[ROLE_ENV.lead]?.trim() || DEFAULT_SWARM_ROUTES.lead,
    scout: env[ROLE_ENV.scout]?.trim() || DEFAULT_SWARM_ROUTES.scout,
    builder: env[ROLE_ENV.builder]?.trim() || DEFAULT_SWARM_ROUTES.builder,
    reviewer: env[ROLE_ENV.reviewer]?.trim() || DEFAULT_SWARM_ROUTES.reviewer,
  };
}

export async function validateSwarmRoutes(
  facade: LlmFacade,
  roles: readonly SwarmRole[],
  routeMap: Readonly<SwarmRouteMap>,
): Promise<SwarmAssignment[]> {
  const assignments: SwarmAssignment[] = [];
  for (const role of roles) {
    const routeName = routeMap[role];
    const route = facade.routes.get(routeName);
    if (!route) {
      throw new Error(`unknown swarm route ${routeName} for role ${role}`);
    }
    const ready = await route.ready();
    if (!ready.ok) {
      throw new Error(`swarm route ${routeName} for role ${role} is not ready: ${ready.reason ?? "unknown reason"}`);
    }
    assignments.push({ role, route: routeName });
  }
  return assignments;
}
