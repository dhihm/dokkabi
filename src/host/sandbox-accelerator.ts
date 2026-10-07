import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A sandbox that hides the machine's accelerator cannot do the machine's work.
 *
 * The bwrap world is built with `--dev /dev`, which mounts a fresh minimal
 * devtmpfs: null, zero, random, tty. The accelerator's device nodes are not
 * in it, so a driver inside the sandbox finds no device and fails to
 * initialise. Every case that touches the local GPU therefore failed for a
 * reason that had nothing to do with the case, and the only way to reach an
 * accelerator was to send the work to another machine over ssh — on a box
 * whose own accelerators sat idle.
 *
 * The sandbox exists to bound what the run can read and write and reach on
 * the network. It was never meant to deny the operator's own hardware to the
 * operator's own work: these nodes are already open to the same user outside
 * the sandbox, and binding them back changes no filesystem or network
 * boundary. They are bound only in a writable world — the sealed read-only
 * phase writes a plan and has no business opening a device.
 *
 * Discovery is by presence. A machine without accelerators binds nothing and
 * behaves exactly as before.
 */

/** Device paths an accelerator runtime opens, in the order drivers expect. */
const ACCELERATOR_NODES: readonly string[] = [
  // WSL reaches the GPU through the DirectX kernel driver, not the nvidia
  // nodes: on that platform /dev/dxg is the whole device surface, and the
  // runtime libraries live under /usr/lib/wsl, which the world already gets
  // with /usr. A list written from a bare-metal Linux box had none of this,
  // so a laptop running the harness under WSL saw no accelerator at all.
  "/dev/dxg",
  "/dev/nvidiactl",
  "/dev/nvidia-uvm",
  "/dev/nvidia-uvm-tools",
  "/dev/nvidia-modeset",
  "/dev/nvidia-nvlink",
  "/dev/nvidia-nvswitchctl",
  "/dev/kfd",           // AMD ROCm compute
];

/** Directories whose whole contents belong to one accelerator family. */
const ACCELERATOR_DIRS: readonly string[] = [
  "/dev/nvidia-caps",
  "/dev/dri",
];

/** Numbered per-device nodes, e.g. /dev/nvidia0, /dev/nvidia-nvswitch0. */
const NUMBERED_PREFIXES: readonly string[] = [
  "/dev/nvidia",
  "/dev/nvidia-nvswitch",
];

function isNumberedNode(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false;
  const rest = name.slice(prefix.length);
  return rest.length > 0 && /^[0-9]+$/u.test(rest);
}

/**
 * The accelerator device nodes present on this machine. Empty on a machine
 * with no accelerator, and on any platform whose sandbox does not bind devices.
 */
export function acceleratorDevicePaths(root = "/dev"): string[] {
  const found: string[] = [];
  const add = (path: string): void => {
    if (!found.includes(path) && existsSync(path)) found.push(path);
  };
  for (const node of ACCELERATOR_NODES) {
    add(node.startsWith("/dev/") ? join(root, node.slice(5)) : node);
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }
  for (const entry of entries.sort()) {
    const full = join(root, entry);
    for (const prefix of NUMBERED_PREFIXES) {
      const bare = prefix.startsWith("/dev/") ? prefix.slice(5) : prefix;
      if (isNumberedNode(entry, bare)) add(full);
    }
  }
  for (const dir of ACCELERATOR_DIRS) {
    const full = dir.startsWith("/dev/") ? join(root, dir.slice(5)) : dir;
    try {
      if (existsSync(full) && statSync(full).isDirectory()) add(full);
    } catch {
      // A directory we cannot stat is one we cannot bind; skip it.
    }
  }
  return found;
}

/**
 * Whether this machine reaches its accelerator the WSL way.
 *
 * It matters because the two platforms fail differently. On bare metal the
 * nvidia driver refuses a process in a user namespace however the devices are
 * bound, so a case there must run unfenced. WSL's device is the DirectX
 * kernel node and its runtime lives under /usr, both of which a sandbox can
 * carry — so binding may be enough, and a case there may not need to leave
 * the fence at all.
 */
export function isWslAccelerator(paths: readonly string[]): boolean {
  return paths.some((path) => path.endsWith("/dxg"));
}

/**
 * Directories an accelerator's own tools live in, off the default PATH.
 *
 * Binding the device is half the job. WSL puts `nvidia-smi` and the CUDA
 * runtime in `/usr/lib/wsl/lib`, which no default PATH contains, so inside the
 * sandbox the binary is present and readable and still "command not found" —
 * a failure that reads like a machine with no GPU rather than a lookup path
 * with a gap.
 *
 * Returned only when a device was actually bound. A machine with no
 * accelerator gains no directory, so nothing widens for a run that could not
 * have used it.
 */
export function acceleratorToolPaths(devicePaths: readonly string[], root = "/"): string[] {
  if (devicePaths.length === 0) return [];
  const candidates = isWslAccelerator(devicePaths) ? ["/usr/lib/wsl/lib"] : [];
  return candidates
    .map((dir) => (root === "/" ? dir : join(root, dir.slice(1))))
    .filter((dir) => existsSync(dir));
}

/**
 * bwrap arguments binding those nodes back into the sandbox world.
 *
 * `--dev-bind-try` rather than `--dev-bind`: the set is discovered on the host
 * and a node can disappear between discovery and spawn (a driver reload, a
 * container boundary), and losing a device must not turn every sandboxed
 * command into a spawn failure.
 */
export function acceleratorBindArgs(paths: readonly string[]): string[] {
  return paths.flatMap((path) => ["--dev-bind-try", path, path]);
}
