import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * File-backed store for Pi's ~/.pi/agent/auth.json.
 * Dokkabi does not mint a second login. It only reads and refreshes this file.
 */
export class PiAuthStore implements CredentialStore {
  constructor(private readonly path: string) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const all = this.load();
    return all[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const all = this.load();
    return Object.entries(all).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.withLock(async () => {
      options?.signal?.throwIfAborted();
      const all = this.load();
      const next = await fn(all[providerId]);
      options?.signal?.throwIfAborted();
      if (next) {
        all[providerId] = next;
      }
      this.save(all);
      return next ?? all[providerId];
    }, options?.signal);
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.withLock(async () => {
      options?.signal?.throwIfAborted();
      const all = this.load();
      delete all[providerId];
      this.save(all);
    }, options?.signal);
  }

  private load(): Record<string, Credential> {
    if (!existsSync(this.path)) {
      return {};
    }
    try {
      chmodSync(dirname(this.path), 0o700);
      chmodSync(this.path, 0o600);
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      throw new Error("credential store is unreadable or invalid", { cause: error });
    }
  }

  private save(all: Record<string, Credential>): void {
    const directory = dirname(this.path);
    this.prepareDirectory();
    const tmp = `${directory}/.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tmp, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(all, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }

  private prepareDirectory(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  private async withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.prepareDirectory();
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + 5_000;
    let lock: number | undefined;
    while (lock === undefined) {
      signal?.throwIfAborted();
      try {
        lock = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if (!isAlreadyExists(error) || Date.now() >= deadline) {
          throw new Error("credential store is busy", { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await fn();
    } finally {
      closeSync(lock);
      try {
        unlinkSync(lockPath);
      } catch {
        // A completed operation must not fail because lock cleanup raced shutdown.
      }
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
