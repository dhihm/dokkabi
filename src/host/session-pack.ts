import { decodeArchive, encodeArchive, publishArchive, publishArchiveDirectory, readArchive } from "./safe-archive.ts";
import { snapshotSessionBytes } from "../eval/experiment/checkpoint.ts";
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { EventLog } from "./event-log.ts";
import { BlobStore, collectReferencedBlobs } from "./blob-store.ts";
import { storedName } from "./blob-parts.ts";

/**
 * Keep a session that is about to lose its home.
 *
 * A SWE instance runs under a throwaway `DOKKABI_HOME` and the operator
 * deletes that directory when the campaign moves on, taking the EventLog —
 * the only record of what happened — with it. This copies the log and the
 * blobs it references into a home that survives, so the board can still open
 * the run and `replay` can still recompute its contract.
 *
 * Best effort by contract: it returns the kept path, or `undefined` when the
 * copy could not be made. An instance must never fail because its archive
 * could not be written.
 */
export function preserveSession(input: {
  logPath: string;
  sessionId: string;
  destHome: string;
}): string | undefined {
  try {
    const logPath = resolve(input.logPath);
    if (!existsSync(logPath)) {
      return undefined;
    }
    const target = join(resolve(input.destHome), "sessions", input.sessionId);
    const destLog = join(target, "events.jsonl");
    if (destLog === logPath) {
      // Already where it will be kept.
      return logPath;
    }
    // A second run of the same instance must not overwrite the first record.
    const finalDir = existsSync(destLog) ? `${target}-${shortStamp(logPath)}` : target;
    const finalLog = join(finalDir, "events.jsonl");
    mkdirSync(finalDir, { recursive: true, mode: 0o700 });
    copyFileSync(logPath, finalLog);
    const log = new EventLog(logPath, { readOnly: true });
    const source = BlobStore.forSession(logPath);
    const kept = BlobStore.forSession(finalLog);
    const seen = new Set<string>();
    for (const digest of collectReferencedBlobs(log.events)) {
      if (!source.has(digest)) {
        // The log names a blob the store no longer has. That is a gap in the
        // original, not something this copy can invent (constitution 1).
        continue;
      }
      // A whole body, or a body stored as parts (D53): its manifests, lists
      // and parts. One whose manifest cannot be read keeps what is there.
      let names: string[];
      try { names = source.bodyFiles(digest, seen); } catch { names = [storedName(digest, "manifest")]; }
      for (const name of names) {
        if (!existsSync(source.fileOf(name))) continue;
        const dest = kept.fileOf(name);
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        copyFileSync(source.fileOf(name), dest);
      }
    }
    return finalLog;
  } catch {
    return undefined;
  }
}

/** Distinguish same-named sessions kept from different runs. */
function shortStamp(logPath: string): string {
  try {
    return String(statSync(logPath).mtimeMs).slice(-8);
  } catch {
    return "dup";
  }
}

export function packSession(input: { logPath: string; archivePath: string }): void {
  snapshotSessionBytes(resolve(input.logPath), snapshot => {
    publishArchive(input.archivePath, encodeArchive(snapshot.files));
  });
}

export function unpackSession(input: { archivePath: string; destDir: string }): void {
  const files = decodeArchive(readArchive(input.archivePath));
  // BSD tar stored AppleDouble companions by default. They are OS metadata,
  // never replay evidence. Validate the container and counterpart; leave the
  // original archive intact and do not restore resource forks or attributes.
  for (const [path, body] of files) {
    if (!basename(path).startsWith("._")) continue;
    const name = basename(path).slice(2), counterpart = dirname(path) === "." ? name : `${dirname(path)}/${name}`;
    if (body.length < 26 || body.readUInt32BE(0) !== 0x00051607 || body.readUInt32BE(4) !== 0x00020000
      || (!files.has(counterpart) && ![...files.keys()].some(member => member.startsWith(counterpart + "/")))) throw new Error("unpack: invalid legacy metadata companion");
    const count = body.readUInt16BE(24), table = 26 + count * 12;
    if (table > body.length) throw new Error("unpack: incomplete metadata table");
    for (let index = 0; index < count; index++) {
      const offset = body.readUInt32BE(26 + index * 12 + 4), size = body.readUInt32BE(26 + index * 12 + 8);
      if (offset < table || offset + size > body.length) throw new Error("unpack: invalid metadata bounds");
    }
    files.delete(path);
  }
  // Whole bodies, and the manifests, lists and parts of bodies stored as parts.
  if (!files.has("events.jsonl") || [...files.keys()].some(path => path !== "events.jsonl"
    && !/^blobs\/([0-9a-f]{2})\/\1[0-9a-f]{62}(\.(part|list|manifest))?$/u.test(path))) throw new Error("unpack: unexpected session archive member");
  publishArchiveDirectory(input.destDir, files, staging => {
    const snapshot = snapshotSessionBytes(join(staging, "events.jsonl"));
    if (files.size !== snapshot.files.size || [...files].some(([path, body]) => !snapshot.files.get(path)?.equals(body))) throw new Error("unpack: incomplete or extra session evidence");
  });
}

export function defaultArchiveName(logPath: string): string {
  return `${basename(dirname(logPath)) || "session"}.dokkabi-session`;
}
