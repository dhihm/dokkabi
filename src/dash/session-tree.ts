import type { SwarmChildStatus } from "../swarm/events.ts";
import { SWARM_ROLES } from "../swarm/routes.ts";
import type { SessionRow } from "./session-scan.ts";

export interface SessionRelation {
  parentId: string;
  childId: string;
  role: string;
  route: string;
  openSeq: number;
  status?: SwarmChildStatus;
  replayDigest?: string;
  relationError?: "duplicate_close";
  dispatchDigest?: string;
  resultEnvelopeDigest?: string;
  contractIntegrity?: "ok" | "missing" | "mismatch";
  resultIntegrity?: "ok" | "missing" | "mismatch";
}

export interface SessionTreeNode {
  id: string;
  row?: SessionRow;
  depth: number;
  role?: string;
  route?: string;
  childStatus?: SwarmChildStatus;
  replayDigest?: string;
  contractIntegrity?: "ok" | "missing" | "mismatch";
  resultIntegrity?: "ok" | "missing" | "mismatch";
  missing: boolean;
  lineageError?: "conflicting_parent" | "cycle" | "duplicate_close";
}

const roleOrder = new Map<string, number>([
  ...SWARM_ROLES.map((role, index) => [role, index] as const),
  ["accept-spec", SWARM_ROLES.length],
  ["accept", SWARM_ROLES.length + 1],
]);

function compareRelations(a: SessionRelation, b: SessionRelation): number {
  return a.parentId.localeCompare(b.parentId) ||
    a.openSeq - b.openSeq ||
    (roleOrder.get(a.role) ?? 99) - (roleOrder.get(b.role) ?? 99) ||
    a.childId.localeCompare(b.childId);
}

function compareIds(a: string, b: string, rows: ReadonlyMap<string, SessionRow>): number {
  return (rows.get(b)?.lastTs ?? 0) - (rows.get(a)?.lastTs ?? 0) || a.localeCompare(b);
}

function cycleNodes(ids: ReadonlySet<string>, parentByChild: ReadonlyMap<string, string>): Set<string> {
  const cycles = new Set<string>();
  for (const start of ids) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor !== undefined) {
      const position = positions.get(cursor);
      if (position !== undefined) {
        for (const id of path.slice(position)) {
          cycles.add(id);
        }
        break;
      }
      positions.set(cursor, path.length);
      path.push(cursor);
      cursor = parentByChild.get(cursor);
    }
  }
  return cycles;
}

export function projectSessionTree(
  sessionRows: readonly SessionRow[],
  inputRelations: readonly SessionRelation[],
): SessionTreeNode[] {
  const rows = new Map(sessionRows.map((row) => [row.id, row]));
  const relations = [...inputRelations].sort(compareRelations);
  const ids = new Set(rows.keys());
  const parents = new Map<string, Set<string>>();
  const relationByPair = new Map<string, SessionRelation>();
  for (const relation of relations) {
    ids.add(relation.parentId);
    ids.add(relation.childId);
    const childParents = parents.get(relation.childId) ?? new Set<string>();
    childParents.add(relation.parentId);
    parents.set(relation.childId, childParents);
    const key = `${relation.parentId}\0${relation.childId}`;
    if (!relationByPair.has(key)) {
      relationByPair.set(key, relation);
    }
  }

  const errors = new Map<string, SessionTreeNode["lineageError"]>();
  const parentByChild = new Map<string, string>();
  for (const relation of relations) {
    if (relation.relationError) errors.set(relation.childId, relation.relationError);
  }
  for (const [child, childParents] of parents) {
    if (childParents.size !== 1) {
      errors.set(child, "conflicting_parent");
      continue;
    }
    const parent = childParents.values().next().value;
    if (parent !== undefined) {
      parentByChild.set(child, parent);
    }
  }
  for (const id of cycleNodes(ids, parentByChild)) {
    errors.set(id, "cycle");
  }

  const children = new Map<string, SessionRelation[]>();
  for (const relation of relationByPair.values()) {
    if (errors.has(relation.childId)) {
      continue;
    }
    const group = children.get(relation.parentId) ?? [];
    group.push(relation);
    children.set(relation.parentId, group);
  }
  for (const group of children.values()) {
    group.sort(compareRelations);
  }

  const roots = [...ids]
    .filter((id) => errors.has(id) || !parentByChild.has(id))
    .sort((a, b) => compareIds(a, b, rows));
  const output: SessionTreeNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number, relation?: SessionRelation) => {
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    const row = rows.get(id);
    output.push({
      id,
      ...(row ? { row } : {}),
      depth,
      ...(relation ? {
        role: relation.role,
        route: relation.route,
        childStatus: relation.status,
        replayDigest: relation.replayDigest,
        contractIntegrity: relation.contractIntegrity,
        resultIntegrity: relation.resultIntegrity,
      } : {}),
      missing: row === undefined,
      ...(errors.get(id) ? { lineageError: errors.get(id) } : {}),
    });
    for (const child of children.get(id) ?? []) {
      visit(child.childId, depth + 1, child);
    }
  };
  for (const id of roots) {
    visit(id, 0);
  }
  for (const id of [...ids].sort((a, b) => compareIds(a, b, rows))) {
    visit(id, 0);
  }
  return output;
}
