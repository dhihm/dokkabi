/**
 * Prompt files declare <<slots>> in YAML frontmatter. fillPrompt refuses
 * leftover <<name>> or {{brace}} pairs. TypeScript only supplies facts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SLOT = /<<([a-z][a-z0-9_]*)>>/g;
const MUSTACHE = /\{\{/;

export type PromptSlots = Record<string, string>;

export function fillPrompt(template: string, slots: PromptSlots): string {
  if (MUSTACHE.test(template)) {
    throw new Error("prompt template uses {{mustache}}; Dokkabi slots are <<name>>");
  }
  const declared = declaredSlots(template);
  for (const name of declared) {
    if (!(name in slots)) {
      throw new Error(`prompt slot <<${name}>> was not filled`);
    }
  }
  const extra = Object.keys(slots).filter((name) => !declared.includes(name));
  if (extra.length > 0) {
    throw new Error(`prompt filled unknown slots: ${extra.join(", ")}`);
  }
  const filled = template.replace(SLOT, (_all, name: string) => slots[name] ?? "");
  const leftover = filled.match(SLOT);
  if (leftover) {
    throw new Error(`prompt still has unfilled slots: ${leftover.join(", ")}`);
  }
  return stripFrontmatter(filled).trimEnd() + "\n";
}

export function loadPromptFile(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "..", "prompts", rel);
  return readFileSync(path, "utf8");
}

export function renderPrompt(rel: string, slots: PromptSlots): string {
  return fillPrompt(loadPromptFile(rel), slots);
}

function declaredSlots(template: string): string[] {
  const fm = template.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) {
    return uniqueSlots(template);
  }
  const frontmatter = fm[1];
  if (frontmatter === undefined) {
    return uniqueSlots(template);
  }
  const listed = frontmatter
    .split("\n")
    .map((line) => line.match(/^slots:\s*\[(.*)\]\s*$/))
    .find((match) => match !== null);
  if (!listed) {
    return uniqueSlots(template);
  }
  const names = listed[1];
  if (names === undefined) {
    return uniqueSlots(template);
  }
  return names
    .split(",")
    .map((part) => part.trim().replaceAll('"', "").replaceAll("'", ""))
    .filter((name) => name.length > 0);
}

function uniqueSlots(template: string): string[] {
  return [...new Set([...template.matchAll(SLOT)].flatMap((match) => {
    const name = match[1];
    return name === undefined ? [] : [name];
  }))];
}

function stripFrontmatter(template: string): string {
  return template.replace(/^---\n[\s\S]*?\n---\n/, "");
}
