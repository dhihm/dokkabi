import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { BlobStore, BlobIntegrityError } from "./blob-store.ts";
import { assembleBody, decodeManifest, sha256, storedName, type PartsSource } from "./blob-parts.ts";

/** One acquisition-scoped store for preflight and retained replay evidence. */
export class BoundedReplayBlobs extends BlobStore {
  private readonly bodies = new Map<string, string>();
  private diskBytes = 0;
  private retainedBytes = 0;
  private readonly bodyLimit: number;
  private readonly totalLimit: number;
  constructor(root: string, limits: { bodyBytes?: number; totalBytes?: number } = {}) {
    super(root);
    this.bodyLimit = limits.bodyBytes ?? 32 * 1024 * 1024;
    this.totalLimit = limits.totalBytes ?? 128 * 1024 * 1024;
    for (const n of [this.bodyLimit, this.totalLimit]) if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid replay blob budget");
  }
  private readBudgeted(path: string, limit = this.bodyLimit): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      const budget = Math.min(limit, this.totalLimit - this.diskBytes);
      if (!stat.isFile() || stat.size > budget) throw new Error("replay stored blob byte budget exceeded");
      const chunks: Buffer[] = [], buffer = Buffer.alloc(65536); let bytes = 0;
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
        bytes += n; if (bytes > budget) throw new Error("replay stored blob byte budget exceeded");
        this.diskBytes += n; chunks.push(Buffer.from(buffer.subarray(0, n)));
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { closeSync(fd); }
  }
  override get(digest: string): string {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid replay blob digest");
    const cached = this.bodies.get(digest); if (cached !== undefined) return cached;
    const limit = Math.min(this.bodyLimit, this.totalLimit - this.retainedBytes);
    let body: string;
    if (existsSync(this.pathOf(digest))) body = this.readBudgeted(this.pathOf(digest), limit);
    else {
      const checked = (id: string, kind: "part" | "list") => {
        const path = this.fileOf(storedName(id, kind)); if (!existsSync(path)) return undefined;
        const text = this.readBudgeted(path, kind === "list" ? Math.min(limit, 4 * 1024 * 1024) : limit);
        if (sha256(text) !== id) throw new BlobIntegrityError(id); return text;
      };
      const source: PartsSource = {
        manifest: id => {
          const path = this.fileOf(storedName(id, "manifest")); if (!existsSync(path)) return undefined;
          const text = this.readBudgeted(path, Math.min(this.bodyLimit, 4 * 1024 * 1024));
          if (decodeManifest(text, id).bytes > limit) throw new Error("replay assembled blob byte budget exceeded");
          return text;
        },
        part: id => checked(id, "part"), list: id => checked(id, "list"),
      };
      body = assembleBody(digest, source, undefined, undefined, limit);
    }
    const size = Buffer.byteLength(body);
    if (size > limit || sha256(body) !== digest) throw new BlobIntegrityError(digest);
    this.retainedBytes += size; this.bodies.set(digest, body); return body;
  }
}
