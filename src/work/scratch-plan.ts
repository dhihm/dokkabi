import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadWorkPlan } from "./load.ts";
import { validatePlan } from "./validate.ts";
import type { Case, CaseLayer, WorkPlan } from "./schema.ts";
import { ScratchError } from "./scratch-error.ts";
import { canonicalWorkspaceRoot, safeRelativePath } from "./scratch-path.ts";

export interface ScratchCaseAttachment {
  readonly planPath: string;
  readonly scenario: string;
  readonly caseId?: string;
  readonly layer?: CaseLayer;
  readonly timeoutMs?: number;
  readonly redMeans?: string;
  readonly greenMeans?: string;
}

export interface PreparedScratchPlan {
  readonly caseId: string;
  write(): void;
}

export function prepareScratchPlan(
  workspaceRoot: string,
  target: string,
  command: string,
  attachment: ScratchCaseAttachment,
): PreparedScratchPlan {
  validateAttachment(attachment);
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const planRelative = safeRelativePath(root, attachment.planPath);
  const planPath = join(root, planRelative);
  const loaded = loadWorkPlan(planPath);
  if (loaded.errors.length > 0) {
    throw new ScratchError("invalid_plan", `scratch promotion requires a valid work plan: ${loaded.errors.join("; ")}`);
  }
  if (!loaded.plan.scenarios.some((item) => item.id === attachment.scenario)) {
    throw new ScratchError("invalid_plan", `unknown work plan scenario ${attachment.scenario}`);
  }
  const caseId = attachment.caseId ?? defaultCaseId(target);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(caseId)) {
    throw new ScratchError("invalid_plan", "scratch case id must use 1-80 safe identifier characters");
  }
  if (loaded.plan.cases.some((item) => item.id === caseId)) {
    throw new ScratchError("invalid_plan", `duplicate case ${caseId}`);
  }
  const item: Case = {
    id: caseId,
    scenario: attachment.scenario,
    layer: attachment.layer ?? "contract",
    command,
    red_means: attachment.redMeans ?? "The promoted regression probe fails.",
    green_means: attachment.greenMeans ?? "The promoted regression probe passes.",
    timeout_ms: attachment.timeoutMs ?? 120_000,
    depends_on: [target],
  };
  const plan: WorkPlan = { ...loaded.plan, cases: [...loaded.plan.cases, item] };
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    throw new ScratchError("invalid_plan", `promoted case would invalidate the work plan: ${errors.join("; ")}`);
  }
  return { caseId, write: () => writePlanAtomically(planPath, plan) };
}

export function promotedCaseCommand(target: string): string {
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(target)) return `bun test ${target}`;
  if (/\.py$/u.test(target)) return `python -m pytest ${target}`;
  throw new ScratchError("invalid_target", "promotion target must be a Bun or Python test file");
}

function defaultCaseId(target: string): string {
  const stem = basename(target).replace(/\.[^.]+$/u, "").replace(/[^A-Za-z0-9._-]+/gu, "-");
  return `scratch-${stem}`.slice(0, 80);
}

function validateAttachment(attachment: ScratchCaseAttachment): void {
  if (!attachment.scenario || Buffer.byteLength(attachment.scenario) > 160 || /[\0\r\n]/u.test(attachment.scenario)) {
    throw new ScratchError("invalid_plan", "scratch scenario id must be a bounded single-line value");
  }
  if (
    attachment.timeoutMs !== undefined
    && (!Number.isSafeInteger(attachment.timeoutMs) || attachment.timeoutMs < 1 || attachment.timeoutMs > 3_600_000)
  ) {
    throw new ScratchError("invalid_plan", "scratch case timeout must be an integer from 1 to 3600000 milliseconds");
  }
  for (const text of [attachment.redMeans, attachment.greenMeans]) {
    if (text !== undefined && (Buffer.byteLength(text) > 2_000 || /[\0]/u.test(text))) {
      throw new ScratchError("invalid_plan", "scratch case verdict text must be at most 2000 bytes");
    }
  }
}

function writePlanAtomically(path: string, plan: WorkPlan): void {
  const current = lstatSync(path);
  if (!current.isFile() || current.nlink !== 1 || current.isSymbolicLink()) {
    throw new ScratchError("invalid_plan", "work plan must be a private regular file");
  }
  const temporary = join(dirname(path), `.scratch-plan-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (nodeCode(error) !== "ENOENT") throw error;
    }
  }
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}
