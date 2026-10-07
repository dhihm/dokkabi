import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CURRENT_WIKI_SCHEMA = 2;

export interface OntologyClass {
  id: string;
}

export interface OntologyPredicate {
  id: string;
  domain: string[];
  range: string[];
  evidence?: "required" | "optional";
}

export interface OntologyPack {
  schema: 1;
  id: string;
  namespace: string;
  classes: OntologyClass[];
  predicates: OntologyPredicate[];
}

const CORE_CLASSES = [
  "wiki:Task", "wiki:Worklog", "wiki:ResearchNote", "wiki:Claim",
  "wiki:Decision", "wiki:Experiment", "wiki:Procedure", "wiki:Incident",
  "wiki:Artifact", "wiki:Source",
];

export const CORE_ONTOLOGY: OntologyPack = {
  schema: 1,
  id: "wiki-core",
  namespace: "wiki",
  classes: CORE_CLASSES.map((id) => ({ id })),
  predicates: [
    { id: "wiki:partOf", domain: ["*"], range: ["wiki:Task"], evidence: "optional" },
    { id: "wiki:derivedFrom", domain: ["*"], range: ["*"], evidence: "required" },
    { id: "wiki:produces", domain: ["wiki:Task", "wiki:Experiment", "wiki:ResearchNote"], range: ["wiki:Claim", "wiki:Artifact", "wiki:Decision"], evidence: "required" },
    { id: "wiki:validates", domain: ["wiki:Experiment", "wiki:Artifact", "wiki:Source"], range: ["wiki:Claim", "wiki:Decision", "wiki:Procedure"], evidence: "required" },
    { id: "wiki:contradicts", domain: ["wiki:Claim", "wiki:Decision"], range: ["wiki:Claim", "wiki:Decision"], evidence: "required" },
    { id: "wiki:supersedes", domain: ["wiki:Claim", "wiki:Decision", "wiki:Procedure"], range: ["wiki:Claim", "wiki:Decision", "wiki:Procedure"], evidence: "required" },
    { id: "wiki:dependsOn", domain: ["*"], range: ["*"], evidence: "optional" },
    { id: "wiki:resolves", domain: ["wiki:Decision", "wiki:Procedure", "wiki:Incident"], range: ["wiki:Claim", "wiki:Incident"], evidence: "required" },
    { id: "wiki:appliesTo", domain: ["wiki:Claim", "wiki:Decision", "wiki:Procedure"], range: ["*"], evidence: "optional" },
    { id: "wiki:relatedTo", domain: ["*"], range: ["*"], evidence: "optional" },
  ],
};

export interface OntologyCatalog {
  classes: Set<string>;
  predicates: Map<string, OntologyPredicate>;
  packs: OntologyPack[];
}

export function validateOntologyPacks(packs: OntologyPack[]): OntologyCatalog {
  const classes = new Set(CORE_ONTOLOGY.classes.map((row) => row.id));
  const predicates = new Map(CORE_ONTOLOGY.predicates.map((row) => [row.id, row]));
  const ids = new Set([CORE_ONTOLOGY.id]);
  const namespaces = new Set([CORE_ONTOLOGY.namespace]);
  const normalizedPacks: OntologyPack[] = [];
  for (const pack of packs) {
    if (pack.schema !== 1 || !pack.id || !pack.namespace || !Array.isArray(pack.classes) || !Array.isArray(pack.predicates)) throw new Error("invalid ontology pack metadata");
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(pack.namespace)) throw new Error("invalid ontology namespace");
    if (pack.namespace === "wiki" || pack.id === CORE_ONTOLOGY.id) throw new Error("domain ontology cannot redefine the core namespace");
    if (ids.has(pack.id)) throw new Error(`duplicate ontology pack ${pack.id}`);
    if (namespaces.has(pack.namespace)) throw new Error(`duplicate ontology namespace ${pack.namespace}`);
    ids.add(pack.id);
    namespaces.add(pack.namespace);
    for (const item of pack.classes) {
      if (item.id.startsWith("wiki:")) throw new Error("domain ontology cannot redefine the core namespace");
      if (!item.id.startsWith(`${pack.namespace}:`)) throw new Error(`ontology class ${item.id} escapes namespace ${pack.namespace}`);
      if (!validTerm(item.id)) throw new Error(`invalid ontology class ${item.id}`);
      if (classes.has(item.id)) throw new Error(`duplicate ontology class ${item.id}`);
      classes.add(item.id);
    }
  }
  for (const pack of packs) {
    const normalizedPredicates: OntologyPredicate[] = [];
    for (const item of pack.predicates) {
      if (item.id.startsWith("wiki:")) throw new Error("domain ontology cannot redefine the core namespace");
      if (!item.id.startsWith(`${pack.namespace}:`)) throw new Error(`ontology predicate ${item.id} escapes namespace ${pack.namespace}`);
      if (!validTerm(item.id)) throw new Error(`invalid ontology predicate ${item.id}`);
      if (predicates.has(item.id)) throw new Error(`duplicate ontology predicate ${item.id}`);
      const normalized = normalizePredicate(item);
      for (const type of [...normalized.domain, ...normalized.range]) {
        if (type !== "*" && !classes.has(type)) throw new Error(`ontology predicate ${item.id} references unknown class ${type}`);
      }
      predicates.set(item.id, normalized);
      normalizedPredicates.push(normalized);
    }
    normalizedPacks.push({ ...pack, classes: [...pack.classes], predicates: normalizedPredicates });
  }
  return { classes, predicates, packs: [CORE_ONTOLOGY, ...normalizedPacks] };
}

export function loadOntologyCatalog(root: string): OntologyCatalog {
  const dir = resolve(root, "meta", "ontology");
  if (!existsSync(dir)) return validateOntologyPacks([]);
  const packs: OntologyPack[] = [];
  for (const name of readdirSync(dir).filter((value) => value.endsWith(".json") && value !== "core.json").sort()) {
    const raw = JSON.parse(readFileSync(resolve(dir, name), "utf8")) as OntologyPack;
    packs.push(raw);
  }
  return validateOntologyPacks(packs);
}

export interface MarkdownMigration {
  path: string;
  from: number;
  to: number;
  changed: boolean;
  raw: string;
  digest: string;
}

/** Explicit v1 -> v2 migration. It never writes; callers must use guarded CAS. */
export function migrateKnowledgeMarkdown(path: string, raw: string): MarkdownMigration {
  const schema = Number(/^wiki_schema:\s*(\d+)\s*$/mu.exec(frontmatter(raw))?.[1] ?? 0);
  if (schema === CURRENT_WIKI_SCHEMA) return { path, from: schema, to: schema, changed: false, raw, digest: sha256(raw) };
  if (schema !== 1) throw new Error(`no knowledge migration from schema ${schema}`);
  const split = splitMarkdown(raw);
  let header = split.header.replace(/^wiki_schema:\s*1\s*$/mu, `wiki_schema: ${CURRENT_WIKI_SCHEMA}`)
    .replaceAll('"wiki:Research"', '"wiki:ResearchNote"')
    .replaceAll('"wiki:Error"', '"wiki:Incident"')
    .replaceAll('"wiki:Concept"', '"wiki:Claim"');
  if (!/^wiki_visibility:/mu.test(header)) header = insertAfter(header, "wiki_status", 'wiki_visibility: "private"');
  if (!/^wiki_evidence:/mu.test(header)) header = insertAfter(header, "wiki_relations", "wiki_evidence: []");
  const migrated = `---\n${header.trimEnd()}\n---\n${split.body}`;
  return { path, from: schema, to: CURRENT_WIKI_SCHEMA, changed: migrated !== raw, raw: migrated, digest: sha256(migrated) };
}

export function coreOntologyJson(): string {
  return `${JSON.stringify(CORE_ONTOLOGY, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePredicate(value: OntologyPredicate): OntologyPredicate {
  if (!value.id || !Array.isArray(value.domain) || value.domain.length === 0 || !Array.isArray(value.range) || value.range.length === 0) throw new Error("invalid ontology predicate");
  if (value.evidence !== undefined && value.evidence !== "required" && value.evidence !== "optional") throw new Error("invalid ontology evidence policy");
  return { id: value.id, domain: [...new Set(value.domain)].sort(), range: [...new Set(value.range)].sort(), evidence: value.evidence ?? "optional" };
}

function validTerm(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}:[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function frontmatter(raw: string): string {
  return splitMarkdown(raw).header;
}

function splitMarkdown(raw: string): { header: string; body: string } {
  if (!raw.startsWith("---\n")) throw new Error("knowledge migration requires frontmatter");
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("knowledge migration requires closed frontmatter");
  return { header: raw.slice(4, end), body: raw.slice(end + 5) };
}

function insertAfter(header: string, key: string, row: string): string {
  const lines = header.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  lines.splice(index < 0 ? lines.length : index + 1, 0, row);
  return lines.join("\n");
}
