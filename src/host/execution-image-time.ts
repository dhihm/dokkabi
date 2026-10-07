import { dlopen } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fixtureStats } from "../work/evidence/fixture-statx.ts";

export function imageMtime(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return fixtureStats(fd).mtimeNs.toString(); } finally { closeSync(fd); }
}

function loadTimes() {
  if (!["arm64", "x64"].includes(process.arch)) throw new Error("execution_image_timestamp_platform");
  let path = "/usr/lib/libSystem.B.dylib", fd: number | undefined;
  if (process.platform === "linux") {
    const paths = new Set(readFileSync("/proc/self/maps", "utf8").split("\n").map(line => line.trim().split(/\s+/u).at(-1) ?? "")
      .filter(path => path.startsWith("/") && /^libc(?:-[0-9.]+)?\.so(?:\.6)?$/u.test(basename(path))));
    if (paths.size !== 1) throw new Error("execution_image_timestamp_library");
    fd = openSync(realpathSync([...paths][0]!), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) { closeSync(fd); throw new Error("execution_image_timestamp_library"); }
    path = "/proc/self/fd/" + fd;
  } else if (process.platform !== "darwin") throw new Error("execution_image_timestamp_platform");
  try { return dlopen(path, { utimensat: { args: ["i32", "ptr", "ptr", "i32"], returns: "i32" } }); }
  finally { if (fd !== undefined) closeSync(fd); }
}
let library: ReturnType<typeof loadTimes> | undefined;

/** Node's double-valued utimes loses nanoseconds; native timespec preserves
 * source mtime without copying inode/ctime identity into a different object. */
export function restoreImageMtime(path: string, value: string): void {
  const ns = BigInt(value), times = Buffer.alloc(32), seconds = ns / 1000000000n, fraction = ns % 1000000000n;
  for (const offset of [0, 16]) { times.writeBigInt64LE(fraction < 0 ? seconds - 1n : seconds, offset); times.writeBigInt64LE(fraction < 0 ? fraction + 1000000000n : fraction, offset + 8); }
  const native = library ??= loadTimes();
  if (native.symbols.utimensat(process.platform === "linux" ? -100 : -2, Buffer.from(path + "\0"), times, process.platform === "linux" ? 0x100 : 0x20) !== 0 || imageMtime(path) !== value) throw new Error("execution_image_timestamp_restore");
}
