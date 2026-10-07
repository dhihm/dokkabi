import {
  FileError,
  NodeExecutionEnv,
  type FileInfo,
  type Result,
} from "@earendil-works/pi-agent-core/node";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { WorkspaceFileHandle, WorkspacePathAnchor } from "./workspace-path.ts";
import { linuxTargetIo, portableTargetIo } from "./workspace-target-io.ts";
import { MutationRefusal, type TargetIo } from "./workspace-versions.ts";
import { LinkSafetyError, openBeneath, readOpened, safeRoot, type SafeRoot } from "../work/link-safe-fs.ts";

export type WorkspaceFileOperation = "read" | "write" | "edit";

/**
 * Per-call hooks of the version authority (#221). `read` sees the bytes a
 * read returned and the identity of the object that held them; `editRead`
 * sees what an edit is about to work on and may refuse it (a
 * MutationRefusal); `write` is the final boundary — it checks and writes
 * through `io` in one synchronous run and says whether the bytes landed.
 * Without hooks an environment behaves as it always did.
 */
export interface WorkspaceVersionHooks {
  readonly read?: (bytes: Buffer, identity: string, rel: string) => void;
  readonly editRead?: (bytes: Buffer, identity: string, rel: string) => void;
  readonly write?: (io: TargetIo, rel: string, content: Buffer) => "landed" | "refused";
}

/** Decoded as Pi's edit expects it: a UTF-8 BOM is kept, so the edit's own
 * BOM handling preserves it. */
function decodeKeepingBom(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * Call-local Pi filesystem environment backed by fd-relative workspace
 * authority. Edit keeps one O_RDWR descriptor from fileInfo through read and
 * replace, so an adversarial rename cannot redirect the write after the read.
 */
export class AtomicWorkspaceExecutionEnv extends NodeExecutionEnv {
  private readonly canonicalRoot: string;
  private readonly anchor: WorkspacePathAnchor;
  private readonly handles = new Map<string, WorkspaceFileHandle>();

  constructor(
    workspaceRoot: string,
    private readonly operation: WorkspaceFileOperation,
    private readonly hooks?: WorkspaceVersionHooks,
  ) {
    const anchor = new WorkspacePathAnchor(workspaceRoot);
    super({ cwd: anchor.root });
    this.anchor = anchor;
    this.canonicalRoot = anchor.root;
  }

  closeWorkspace(): void {
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
    this.anchor.close();
  }

  override async absolutePath(path: string): Promise<Result<string, FileError>> {
    try {
      const absolute = resolve(this.canonicalRoot, path);
      this.relativePath(absolute);
      return { ok: true, value: absolute };
    } catch {
      return refused();
    }
  }

  override async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    if (abortSignal?.aborted) return aborted();
    try {
      this.stableHandle(path);
      return { ok: true, value: true };
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return { ok: true, value: false };
      return refused();
    }
  }

  override async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    if (abortSignal?.aborted) return aborted();
    try {
      const handle = this.stableHandle(path);
      const info = handle.info();
      return {
        ok: true,
        value: {
          name: basename(path),
          path,
          kind: "file",
          size: info.size,
          mtimeMs: info.mtimeMs,
        },
      };
    } catch (error) {
      return fileFailure(error);
    }
  }

  override async readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    if (abortSignal?.aborted) return aborted();
    try {
      const handle = this.stableHandle(path);
      const bytes = handle.read();
      if (this.hooks) {
        const identity = handle.info().identity;
        const rel = this.relativePath(path);
        if (this.operation === "read") this.hooks.read?.(Buffer.from(bytes), identity, rel);
        if (this.operation === "edit") this.hooks.editRead?.(Buffer.from(bytes), identity, rel);
      }
      return { ok: true, value: bytes };
    } catch (error) {
      if (error instanceof MutationRefusal) return versionRefused();
      return fileFailure(error);
    }
  }

  override async readTextFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(path, abortSignal);
    return result.ok
      ? { ok: true, value: decodeKeepingBom(result.value) }
      : result;
  }

  override async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    if (abortSignal?.aborted) return aborted();
    try {
      const relativePath = this.relativePath(path);
      if (this.hooks?.write && (this.operation === "edit" || this.operation === "write")) {
        // The final boundary: no await between its check and its write.
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
        return this.hooks.write(linuxTargetIo(this.canonicalRoot), relativePath, bytes) === "landed"
          ? { ok: true, value: undefined }
          : versionRefused();
      }
      if (this.operation === "edit") {
        this.stableHandle(path).replace(content);
      } else if (this.operation === "write") {
        this.anchor.writeFile(relativePath, content);
      } else {
        return refused();
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return fileFailure(error);
    }
  }

  private stableHandle(path: string): WorkspaceFileHandle {
    const relativePath = this.relativePath(path);
    const found = this.handles.get(relativePath);
    if (found) return found;
    const handle = this.anchor.openFile(relativePath, this.operation === "edit");
    this.handles.set(relativePath, handle);
    return handle;
  }

  private relativePath(path: string): string {
    if (path.includes("\0")) throw new Error("invalid workspace path");
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.canonicalRoot, path);
    const rel = relative(this.canonicalRoot, absolute);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return rel || ".";
    throw new Error("workspace path escapes its root");
  }
}

/**
 * The portable binding (#221 M6): the same Pi environment over the link-safe
 * module instead of plain paths. Reads open the file without following a
 * link in any component (O_NOFOLLOW_ANY on macOS) and report the identity of
 * what they read; writes go through the version authority's boundary, or —
 * without hooks — through the same link-safe rewrite/create.
 */
export class LinkSafeWorkspaceExecutionEnv extends NodeExecutionEnv {
  private readonly canonicalRoot: string;
  private readonly pinned: SafeRoot;
  private readonly io: TargetIo;

  constructor(
    workspaceRoot: string,
    private readonly operation: WorkspaceFileOperation,
    private readonly hooks?: WorkspaceVersionHooks,
  ) {
    const canonical = realpathSync(resolve(workspaceRoot));
    super({ cwd: canonical });
    this.canonicalRoot = canonical;
    this.pinned = safeRoot(canonical, "the workspace");
    this.io = portableTargetIo(canonical);
  }

  override async absolutePath(path: string): Promise<Result<string, FileError>> {
    try {
      const absolute = resolve(this.canonicalRoot, path);
      this.relativePath(absolute);
      return { ok: true, value: absolute };
    } catch {
      return refused();
    }
  }

  override async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    if (abortSignal?.aborted) return aborted();
    try {
      const file = openBeneath(this.pinned, Buffer.from(this.relativePath(path)), "read");
      file?.close();
      return { ok: true, value: file !== undefined };
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return { ok: true, value: false };
      return linkSafeFailure(error);
    }
  }

  override async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    if (abortSignal?.aborted) return aborted();
    try {
      const file = openBeneath(this.pinned, Buffer.from(this.relativePath(path)), "read");
      if (file === undefined) return { ok: false, error: new FileError("not_found", "workspace file was not found") };
      try {
        return {
          ok: true,
          value: { name: basename(path), path, kind: "file", size: file.size, mtimeMs: Number(file.mtimeNs / 1_000_000n) },
        };
      } finally {
        file.close();
      }
    } catch (error) {
      return linkSafeFailure(error);
    }
  }

  override async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    if (abortSignal?.aborted) return aborted();
    try {
      const rel = this.relativePath(path);
      const file = openBeneath(this.pinned, Buffer.from(rel), "read");
      if (file === undefined) return { ok: false, error: new FileError("not_found", "workspace file was not found") };
      let bytes: Buffer;
      try {
        // As the Linux anchor: a file with a second name is not read (the
        // other name can lie outside the workspace).
        if (file.nlink !== 1n) throw new LinkSafetyError({ code: "not_file", operation: "read", root: this.pinned, path: Buffer.from(rel), at: Buffer.from(rel) });
        bytes = readOpened(file, file.size);
        file.verify();
      } finally {
        file.close();
      }
      if (this.hooks) {
        const identity = `${file.dev}:${file.ino}`;
        if (this.operation === "read") this.hooks.read?.(bytes, identity, rel);
        if (this.operation === "edit") this.hooks.editRead?.(bytes, identity, rel);
      }
      return { ok: true, value: bytes };
    } catch (error) {
      if (error instanceof MutationRefusal) return versionRefused();
      return linkSafeFailure(error);
    }
  }

  override async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(path, abortSignal);
    return result.ok ? { ok: true, value: decodeKeepingBom(result.value) } : result;
  }

  override async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    if (abortSignal?.aborted) return aborted();
    if (this.operation === "read") return refused();
    try {
      const rel = this.relativePath(path);
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      if (this.hooks?.write) {
        // The final boundary: no await between its check and its write.
        return this.hooks.write(this.io, rel, bytes) === "landed" ? { ok: true, value: undefined } : versionRefused();
      }
      try {
        this.io.rewrite(rel, () => bytes, () => {});
      } catch (error) {
        if (nodeCode(error) !== "ENOENT") throw error;
        this.io.create(rel, bytes, () => {});
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return linkSafeFailure(error);
    }
  }

  private relativePath(path: string): string {
    if (path.includes("\0")) throw new Error("invalid workspace path");
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.canonicalRoot, path);
    const rel = relative(this.canonicalRoot, absolute);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    throw new Error("workspace path escapes its root");
  }
}

function versionRefused<T>(): Result<T, FileError> {
  return { ok: false, error: new FileError("permission_denied", "refused by the workspace version authority") };
}

function linkSafeFailure<T>(error: unknown): Result<T, FileError> {
  if (error instanceof LinkSafetyError) {
    if (error.code === "not_file") {
      return { ok: false, error: new FileError("is_directory", "workspace path is not a regular file") };
    }
    return refused();
  }
  return fileFailure(error);
}

function refused<T>(): Result<T, FileError> {
  return {
    ok: false,
    error: new FileError("permission_denied", "workspace path boundary refused"),
  };
}

function aborted<T>(): Result<T, FileError> {
  return { ok: false, error: new FileError("aborted", "aborted") };
}

function fileFailure<T>(error: unknown): Result<T, FileError> {
  const code = nodeCode(error);
  if (code === "ENOENT") {
    return { ok: false, error: new FileError("not_found", "workspace file was not found") };
  }
  if (code === "ENOTDIR") {
    return { ok: false, error: new FileError("not_directory", "workspace path is not a directory") };
  }
  if (code === "EISDIR") {
    return { ok: false, error: new FileError("is_directory", "workspace path is a directory") };
  }
  return refused();
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}
