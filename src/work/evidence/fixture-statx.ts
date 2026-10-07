import { dlopen, read } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { basename } from "node:path";
import { getSystemErrorName } from "node:util";
import { linuxMountIdForFd } from "../../host/workspace-path.ts";

type Fields = "dev" | "ino" | "mode" | "nlink" | "uid" | "gid" | "size" | "mtimeNs" | "ctimeNs" | "isFile" | "isDirectory";
export type FixtureStats = Pick<BigIntStats, Fields> & { mountId?: string };
// Linux's fixed 256-byte statx ABI. Require every field used for admission and
// comparison, including STATX_MNT_ID; unsupported kernels use the checked path.
const REQUIRED = 0x13df;
let initialized = false;
let native: ReturnType<typeof loadNative> | undefined;

function loadNative() {
  if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch)) return undefined;
  const paths = new Set(readFileSync("/proc/self/maps", "utf8").split("\n")
    .map(line => line.trim().split(/\s+/u).at(-1) ?? "")
    .filter(path => path.startsWith("/") && /^libc(?:-[0-9.]+)?\.so(?:\.6)?$/u.test(basename(path))));
  if (paths.size !== 1) return undefined;
  // Load the already mapped, OS-owned libc through a held descriptor. Neither
  // the working directory nor library-search environment selects new code.
  const fd = openSync(realpathSync([...paths][0]!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const owner = fstatSync(fd);
    if (!owner.isFile() || owner.uid !== 0 || (owner.mode & 0o022) !== 0) return undefined;
    const library = dlopen("/proc/self/fd/" + fd, {
      statx: { args: ["i32", "ptr", "i32", "u32", "ptr"], returns: "i32" },
      openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    });
    const empty = Buffer.from([0]), bytes = Buffer.alloc(256);
    return {
      stats(descriptor: number): FixtureStats | undefined {
        // AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW observes the held object. The
        // scratch buffer is overwritten on every synchronous call; no result
        // or metadata is reused across files, phases or verifier invocations.
        if (library.symbols.statx(descriptor, empty, 0x1100, REQUIRED, bytes) !== 0
          || (bytes.readUInt32LE(0) & REQUIRED) !== REQUIRED) return undefined;
        const mountId = bytes.readBigUInt64LE(144);
        const ctimeFraction = bytes.readUInt32LE(104), mtimeFraction = bytes.readUInt32LE(120);
        if (mountId === 0n || ctimeFraction >= 1_000_000_000 || mtimeFraction >= 1_000_000_000) return undefined;
        const major = BigInt(bytes.readUInt32LE(136)), minor = BigInt(bytes.readUInt32LE(140));
        const mode = BigInt(bytes.readUInt16LE(28));
        return {
          dev: (minor & 0xffn) | ((major & 0xfffn) << 8n) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n),
          ino: bytes.readBigUInt64LE(32), mode, nlink: BigInt(bytes.readUInt32LE(16)),
          uid: BigInt(bytes.readUInt32LE(20)), gid: BigInt(bytes.readUInt32LE(24)), size: bytes.readBigUInt64LE(40),
          ctimeNs: bytes.readBigInt64LE(96) * 1_000_000_000n + BigInt(ctimeFraction),
          mtimeNs: bytes.readBigInt64LE(112) * 1_000_000_000n + BigInt(mtimeFraction),
          mountId: mountId.toString(),
          isFile: () => (mode & 0o170000n) === 0o100000n,
          isDirectory: () => (mode & 0o170000n) === 0o040000n,
        };
      },
      open(parent: number, name: string, flags: number): number {
        // Keep the pathname owner visible through the native call.
        const result = library.symbols.openat(parent, Buffer.from(name + "\0"), flags | 0x80000); // Linux O_CLOEXEC.
        if (result < 0) {
          const address = library.symbols.__errno_location();
          const code = address === null ? "EIO" : getSystemErrorName(-read.i32(address));
          throw Object.assign(new Error(code), { code });
        }
        return result;
      },
    };
  } finally { closeSync(fd); }
}

function backend() {
  if (!initialized) {
    initialized = true;
    try { native = loadNative(); } catch { /* Existing descriptor checks remain mandatory below. */ }
  }
  return native;
}

export function fixtureOpenAt(parent: number, name: string, flags: number): number {
  return backend()?.open(parent, name, flags) ?? openSync("/proc/self/fd/" + parent + "/" + name, flags);
}

export function fixtureStats(fd: number): FixtureStats {
  if (process.platform !== "linux") return fstatSync(fd, { bigint: true });
  const result = backend()?.stats(fd);
  if (result) return result;
  // A missing symbol, result field or native capability cannot omit the
  // device/mount check or substitute fabricated statx values.
  return Object.assign(fstatSync(fd, { bigint: true }), { mountId: linuxMountIdForFd(fd) });
}
