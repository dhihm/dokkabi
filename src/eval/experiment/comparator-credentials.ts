import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { durableResearchFile } from "./environment.ts";

/** Isolating preferences must not fork a single-use OAuth refresh chain.
 * Publish only the selected provider's rotation, under the credential-store
 * lock and a compare-and-swap check. Secret values never enter run receipts. */
export async function reconcileComparatorCredential(source: string, privatePath: string, provider: string, before: unknown): Promise<"unchanged" | "rotated"> {
  const after = JSON.parse(readFileSync(privatePath, "utf8"))[provider] as unknown;
  if (!after || typeof after !== "object") throw new Error("private provider credential unavailable after execution");
  if (JSON.stringify(after) === JSON.stringify(before)) return "unchanged";
  const lock = `${source}.lock`, deadline = Date.now() + 5000;
  let fd: number | undefined;
  while (fd === undefined) {
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error("provider credential store is busy");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const temp = `${source}.${randomUUID()}.tmp`;
  try {
    const current = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
    if (JSON.stringify(current[provider]) === JSON.stringify(after)) return "unchanged";
    if (JSON.stringify(current[provider]) !== JSON.stringify(before)) throw new Error("provider credential changed concurrently; refreshed private state is retained");
    current[provider] = after;
    durableResearchFile(temp, JSON.stringify(current) + "\n");
    renameSync(temp, source);
    const directory = openSync(dirname(source), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    return "rotated";
  } finally {
    closeSync(fd); unlinkSync(lock);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
