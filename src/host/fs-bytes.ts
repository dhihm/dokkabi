import { readdirSync, type PathLike } from "node:fs";

/** Directory names as exact bytes with Buffer methods on every runtime.
 * Bun on Linux can return Uint8Array despite the buffer encoding overload. */
export function readDirectoryBytes(path: PathLike): Buffer[] {
  return readdirSync(path, { encoding: "buffer" }).map((name) =>
    Buffer.isBuffer(name) ? name : Buffer.from(name),
  );
}
