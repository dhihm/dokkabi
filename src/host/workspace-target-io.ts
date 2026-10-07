import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  LinkSafetyError,
  openBeneath,
  opensRefuseAnyLink,
  readOpened,
  rewriteBeneath,
  safeRoot,
  writeBeneath,
  type SafeRoot,
} from "../work/link-safe-fs.ts";
import { WorkspacePathAnchor } from "./workspace-path.ts";
import type { LiveTarget, TargetIo } from "./workspace-versions.ts";

/**
 * The two bindings of the final boundary (#221 M3, M6), recorded as a
 * capability and never blurred:
 *
 * - `portable_link_safe` — every path goes through the link-safe module
 *   (S1): each directory checked with lstat, the file opened without
 *   following a link (on macOS O_NOFOLLOW_ANY refuses a link in any
 *   component atomically; elsewhere O_NOFOLLOW on the last one and the chain
 *   re-verified around the call), the inode at the path checked again right
 *   before the write. A rename of a parent between that check and the write
 *   is detected afterwards, not prevented.
 * - `linux_fd_anchored` — every component is opened from its parent's
 *   descriptor with O_NOFOLLOW on the root's mount: a rename cannot redirect
 *   the operation, and the bytes are written through the descriptor whose
 *   inode was checked.
 */

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(Reflect.get(error, "code")) : undefined;
}

export function portableTargetIo(root: string): TargetIo {
  const pinned: SafeRoot = safeRoot(realpathSync(resolve(root)), "the workspace");
  return {
    binding: "portable_link_safe",
    openNoFollowAny: opensRefuseAnyLink(),
    inspect(rel): LiveTarget {
      let file;
      try {
        file = openBeneath(pinned, Buffer.from(rel), "inspect");
      } catch (error) {
        if (error instanceof LinkSafetyError) return { state: "other", detail: error.code };
        if (codeOf(error) === "ENOENT") return { state: "absent" };
        throw error;
      }
      if (file === undefined) return { state: "absent" };
      try {
        const bytes = readOpened(file, file.size);
        file.verify();
        return { state: "file", bytes, identity: `${file.dev}:${file.ino}` };
      } finally {
        file.close();
      }
    },
    rewrite(rel, decide, written) {
      const done = rewriteBeneath(pinned, Buffer.from(rel), (state) => decide({ bytes: state.bytes, identity: `${state.dev}:${state.ino}` }), {
        operation: "write",
        written,
      });
      return { identity: `${done.dev}:${done.ino}` };
    },
    create(rel, bytes, written) {
      // O_CREAT|O_EXCL without following a link: anything at the name is
      // EEXIST; missing parents are made one real directory at a time.
      const made = writeBeneath(pinned, Buffer.from(rel), bytes, {
        mode: 0o644,
        parents: 0o755,
        operation: "create",
        created: written,
      });
      // M3': the inode made is still at the path beneath the root, holding
      // exactly the bytes written.
      readBack(pinned, rel, `${made.dev}:${made.ino}`, bytes);
      return { identity: `${made.dev}:${made.ino}` };
    },
  };
}

/** Open the path again beneath the root, without following a link, and
 * hold it to the identity and bytes just written; else a boundary error
 * thrown AFTER the effect (the caller reports it unresolved). */
function readBack(pinned: SafeRoot, rel: string, identity: string, bytes: Buffer): void {
  const file = openBeneath(pinned, Buffer.from(rel), "verify");
  if (file === undefined) throw Object.assign(new Error(`${rel} is no longer at its path after the write`), { code: "ERACED" });
  try {
    const back = readOpened(file, file.size);
    file.verify();
    if (`${file.dev}:${file.ino}` !== identity || !back.equals(bytes)) {
      throw Object.assign(new Error(`${rel} does not hold the bytes written at its path`), { code: "ERACED" });
    }
  } finally {
    file.close();
  }
}

/** Linux: the fd anchor. Each operation opens its own anchor on the root. */
export function linuxTargetIo(root: string): TargetIo {
  const withAnchor = <T>(run: (anchor: WorkspacePathAnchor) => T): T => {
    const anchor = new WorkspacePathAnchor(root);
    try {
      return run(anchor);
    } finally {
      anchor.close();
    }
  };
  return {
    binding: "linux_fd_anchored",
    openNoFollowAny: false,
    inspect(rel): LiveTarget {
      return withAnchor((anchor) => {
        let handle;
        try {
          handle = anchor.openFile(rel, false);
        } catch (error) {
          const code = codeOf(error);
          if (code === "ENOENT") return { state: "absent" } as const;
          return { state: "other", detail: code ?? "not a private regular file" } as const;
        }
        try {
          return { state: "file", bytes: Buffer.from(handle.read()), identity: handle.info().identity } as const;
        } finally {
          handle.close();
        }
      });
    },
    rewrite(rel, decide, written) {
      return withAnchor((anchor) => {
        // O_RDWR through the parent's descriptor; a multi-name file is refused.
        const handle = anchor.openFile(rel, true);
        try {
          const identity = handle.info().identity;
          const next = decide({ bytes: Buffer.from(handle.read()), identity });
          handle.replace(next);
          written();
          // M3': read back through the descriptor, then reopen the path from
          // the root's descriptor: the written inode must still be there.
          if (!Buffer.from(handle.read()).equals(next)) {
            throw Object.assign(new Error(`${rel} does not hold the bytes written`), { code: "ERACED" });
          }
          const placed = anchor.openFile(rel, false);
          try {
            if (placed.info().identity !== identity) {
              throw Object.assign(new Error(`${rel} is no longer the written file at its path beneath the root`), { code: "ERACED" });
            }
          } finally {
            placed.close();
          }
          return { identity: handle.info().identity };
        } finally {
          handle.close();
        }
      });
    },
    create(rel, bytes, written) {
      return withAnchor((anchor) => {
        const identity = anchor.createFileExclusive(rel, bytes, written);
        const placed = anchor.openFile(rel, false);
        try {
          if (placed.info().identity !== identity || !Buffer.from(placed.read()).equals(bytes)) {
            throw Object.assign(new Error(`${rel} is not the file created at its path beneath the root`), { code: "ERACED" });
          }
        } finally {
          placed.close();
        }
        return { identity };
      });
    },
  };
}
