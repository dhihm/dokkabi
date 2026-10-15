import { existsSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dlopen, ptr } from "bun:ffi";
import { safeRoot } from "../work/link-safe-fs.ts";
import { assertSandboxExecutableIdentity, requireAndSealSandboxExecutable } from "./sandbox-executable.ts";

/** Logical writable views, not physical workspace copies. A separate helper
 * owns the source-generation watch and validates it synchronously over UDS,
 * including when the verifier itself is a child process. */
interface ViewMetadata {
  readonly format: "dokkabi-verification-view-v1";
  readonly root: string;
  readonly source: string;
  readonly upper: string;
  readonly mount: string;
  readonly owner_pid: number;
  readonly owner_start: string;
  readonly helper_pid: number;
  readonly socket: string;
  readonly dependencies: readonly string[];
}
export type ViewObserver = (state: "opened" | "closed", details: { source: string; view: string; mount_id: string }) => void;
interface OwnedView {
  metadata: ViewMetadata;
  readonly process: ChildProcess;
  readonly directoryFds: readonly number[];
  readonly unmountExecutable: string;
  readonly observe?: ViewObserver;
}
const views = new Map<string, OwnedView>();
const borrowed = new Map<string, ViewMetadata>();
const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const metadataPath = (root: string) => join(dirname(root), "verification-view.json");

function processStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
}
function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}
function mountIdentity(root: string): string | undefined {
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const field = line.split(" ")[4];
    if (field && unescapeMount(field) === root) return line;
  }
  return undefined;
}
export function verificationMountUnder(holder: string): boolean {
  if (process.platform !== "linux") return false;
  return readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((line) => {
    const field = line.split(" ")[4];
    if (!field) return false;
    const root = unescapeMount(field);
    return root === holder || root.startsWith(holder + "/");
  });
}

function readMetadata(root: string): ViewMetadata | undefined {
  const own = views.get(root)?.metadata;
  if (own) return own;
  if (process.platform !== "linux") return undefined;
  const mount = mountIdentity(root);
  if (!mount?.includes(" - fuse.fuse-overlayfs ")) return undefined;
  const path = metadataPath(root);
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parent = lstatSync(dirname(path));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
    || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== stat.uid || (parent.mode & 0o022) !== 0) {
    throw new Error("verification view metadata ownership is invalid");
  }
  const data = JSON.parse(readFileSync(path, "utf8")) as ViewMetadata;
  if (data.format !== "dokkabi-verification-view-v1" || data.root !== root || data.mount !== mount
    || !Number.isSafeInteger(data.owner_pid) || !Number.isSafeInteger(data.helper_pid)
    || !/^dokkabi-view-[a-f0-9-]{36}$/.test(data.socket)
    || data.upper !== join(dirname(root), "view-upper") || !Array.isArray(data.dependencies)
    || data.dependencies.some((item) => typeof item !== "string")) {
    throw new Error("verification view metadata does not match its mount");
  }
  borrowed.set(root, data);
  return data;
}

let ipc: ReturnType<typeof loadIpc> | undefined;
function loadIpc() {
  return dlopen("libc.so.6", {
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    connect: { args: ["i32", "ptr", "u32"], returns: "i32" },
    setsockopt: { args: ["i32", "i32", "i32", "ptr", "u32"], returns: "i32" },
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    send: { args: ["i32", "ptr", "u64", "i32"], returns: "i64" },
    recv: { args: ["i32", "ptr", "u64", "i32"], returns: "i64" },
  });
}
function validateLease(data: ViewMetadata): void {
  const lib = ipc ??= loadIpc();
  const fd = lib.symbols.socket(1, 1 | 0x80000, 0); // AF_UNIX, STREAM | CLOEXEC
  if (fd < 0) throw new Error("verification source lease socket could not be created");
  try {
    const timeout = Buffer.alloc(16); timeout.writeBigInt64LE(2n);
    for (const option of [20, 21]) { // RCVTIMEO, SNDTIMEO
      if (lib.symbols.setsockopt(fd, 1, option, ptr(timeout), timeout.length) !== 0) throw new Error("verification source lease timeout could not be set");
    }
    const address = Buffer.alloc(110); address.writeUInt16LE(1);
    const name = Buffer.from(`\0${data.socket}`); name.copy(address, 2);
    if (lib.symbols.connect(fd, ptr(address), 2 + name.length) !== 0) throw new Error("verification source lease helper is unavailable");
    const credentials = Buffer.alloc(12), size = Buffer.alloc(4); size.writeUInt32LE(12);
    if (lib.symbols.getsockopt(fd, 1, 17, ptr(credentials), ptr(size)) !== 0
      || credentials.readInt32LE(0) !== data.helper_pid || credentials.readUInt32LE(4) !== process.getuid?.()) {
      throw new Error("verification source lease helper identity differs");
    }
    const request = Buffer.from("validate\n");
    if (Number(lib.symbols.send(fd, ptr(request), request.length, 0x4000)) !== request.length) throw new Error("verification source lease request failed");
    const parts: Buffer[] = []; let total = 0;
    while (total < 4096) {
      const buffer = Buffer.alloc(1024);
      const length = Number(lib.symbols.recv(fd, ptr(buffer), buffer.length, 0));
      if (length <= 0) break;
      parts.push(buffer.subarray(0, length)); total += length;
      if (buffer.subarray(0, length).includes(10)) break;
    }
    const response = JSON.parse(Buffer.concat(parts).toString()) as { valid?: boolean; reason?: string };
    if (response.valid !== true) throw new Error(`verification source changed while its isolated view was active: ${response.reason ?? "unavailable"}`);
  } finally { closeSync(fd); }
}

// Independent of the Bun owner's event loop: synchronous case subprocesses
// and delegated verifier processes can validate without deadlocking the owner.
const HELPER = String.raw`
import ctypes, json, os, select, signal, socket, struct, subprocess, sys
cfg=json.loads(sys.argv[1]); libc=ctypes.CDLL(None,use_errno=True)
if libc.prctl(1,signal.SIGTERM,0,0,0)!=0: raise OSError(ctypes.get_errno(),'parent death signal')
if os.getppid()!=cfg['owner']: sys.exit(125)
def stop(signum,frame): raise SystemExit(128+signum)
signal.signal(signal.SIGTERM,stop)
fd=libc.inotify_init1(os.O_NONBLOCK|os.O_CLOEXEC)
if fd<0: raise OSError(ctypes.get_errno(),'inotify_init1')
invalid=False; worker=None; server=None
try:
    def watch(path):
        if libc.inotify_add_watch(fd,os.fsencode(path),0xfce|0x1000000|0x2000000)<0:
            raise OSError(ctypes.get_errno(),'inotify_add_watch')
    watch(cfg['source'])
    for base,dirs,files in os.walk(cfg['source'],followlinks=False):
        dirs[:]=[name for name in dirs if not os.path.islink(os.path.join(base,name))]
        for name in dirs: watch(os.path.join(base,name))
    def drain():
        global invalid
        while True:
            try:
                if os.read(fd,65536): invalid=True
                else: break
            except BlockingIOError: break
        return not invalid
    def parent_valid(item):
        s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(2)
        try:
            s.connect('\0'+item['socket'])
            peer=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            if peer[0]!=item['helper_pid'] or peer[1]!=os.getuid(): return False
            s.sendall(b'validate\n');out=b''
            while b'\n' not in out and len(out)<4096:
                chunk=s.recv(1024)
                if not chunk: break
                out+=chunk
            return json.loads(out).get('valid') is True
        finally: s.close()
    def valid():
        global invalid
        if not drain(): return False
        try:
            if not all(parent_valid(item) for item in cfg['parents']): invalid=True
        except Exception: invalid=True
        return not invalid
    if not valid(): raise RuntimeError('source changed while establishing verification generation')
    server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind('\0'+cfg['socket']);server.listen(32)
    parent=os.getpid()
    def bound_child():
        libc.prctl(1,signal.SIGTERM,0,0,0)
        if os.getppid()!=parent: os._exit(125)
    worker=subprocess.Popen(cfg['argv'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=sys.stderr,preexec_fn=bound_child)
    ready=os.open(cfg['ready'],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(ready,'w') as f: json.dump({'worker_pid':worker.pid},f)
    while worker.poll() is None:
        pending,_,_=select.select([fd,server],[],[],0.1)
        if fd in pending: drain()
        if server in pending:
            connection,_=server.accept();connection.settimeout(2)
            try:
                peer=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                request=connection.recv(64)
                good=peer[1]==os.getuid() and request==b'validate\n' and valid()
                connection.sendall((json.dumps({'valid':good,'reason':None if good else 'source_generation_invalid'})+'\n').encode())
            except Exception: pass
            finally: connection.close()
finally:
    if worker is not None and worker.poll() is None:
        worker.terminate()
        try: worker.wait(timeout=3)
        except subprocess.TimeoutExpired: worker.kill();worker.wait()
    if server is not None: server.close()
    os.close(fd)
`;

export function createVerificationView(source: string, holder: string, remainingMs?: number, observe?: ViewObserver): string {
  if (process.platform !== "linux") throw new Error("lazy verification views require Linux");
  const pinned = safeRoot(source, "verification source"), parent = safeRoot(holder, "verification view holder");
  const owner = lstatSync(parent.text);
  if (owner.uid !== process.getuid?.() || (owner.mode & 0o022) !== 0) throw new Error("verification holder must be privately owned");
  if (parent.text === pinned.text || parent.text.startsWith(pinned.text + "/")) throw new Error("verification holder must be outside the source");
  const root = join(parent.text, "ws"), upper = join(parent.text, "view-upper"), work = join(parent.text, "view-work");
  const deadline = Date.now() + Math.min(10000, remainingMs ?? 10000);
  if (deadline <= Date.now()) throw new Error("verification view has no remaining time budget");
  const executables = {
    python: requireAndSealSandboxExecutable("python3", [source, holder]),
    fuse: requireAndSealSandboxExecutable("fuse-overlayfs", [source, holder]),
    unmount: requireAndSealSandboxExecutable("fusermount3", [source, holder]),
  };
  for (const executable of Object.values(executables)) assertSandboxExecutableIdentity(executable);
  const parents: ViewMetadata[] = [];
  const origin = readMetadata(pinned.text);
  if (origin) { assertVerificationViewStable(pinned.text); parents.push(origin); }
  for (const dependency of origin?.dependencies ?? []) { const item = readMetadata(dependency); if (item) parents.push(item); }
  const directoryFds: number[] = [];
  let child: ChildProcess | undefined, workerPid: number | undefined, registered = false;
  try {
    for (const path of [root, upper, work]) mkdirSync(path, { mode: 0o700 });
    for (const path of [pinned.text, upper, work]) directoryFds.push(openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const sourceStat = fstatSync(directoryFds[0]!, { bigint: true });
    if (sourceStat.dev !== pinned.dev || sourceStat.ino !== pinned.ino) throw new Error("verification source root changed before mounting");
    const aliases = directoryFds.map((fd) => `/proc/${process.pid}/fd/${fd}`);
    const socket = `dokkabi-view-${randomUUID()}`, ready = join(parent.text, "view-helper.json");
    const argv = [executables.fuse.path, "-f", "-o", `lowerdir=${aliases[0]},upperdir=${aliases[1]},workdir=${aliases[2]},auto_unmount`, root];
    const fd = openSync(join(parent.text, "view-mount.log"), "wx", 0o600);
    try {
      child = spawn(executables.python.path, ["-I", "-S", "-c", HELPER, JSON.stringify({ owner: process.pid, source: pinned.text, parents, socket, ready, argv })], {
        stdio: ["ignore", "ignore", fd], env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: parent.text },
      });
      child.on("error", () => {}); child.unref();
      if (!child.pid) throw new Error("verification helper did not start");
    } finally { closeSync(fd); }
    let mount: string | undefined;
    while (!(mount = mountIdentity(root)) || !existsSync(ready) || lstatSync(ready).size === 0) {
      if (Date.now() >= deadline) throw new Error(`verification overlay did not mount: ${readFileSync(join(parent.text, "view-mount.log"), "utf8").slice(-300)}`);
      pause(10);
    }
    workerPid = (JSON.parse(readFileSync(ready, "utf8")) as { worker_pid: number }).worker_pid;
    const status = readFileSync(`/proc/${workerPid}/status`, "utf8");
    if (!mount.includes(" - fuse.fuse-overlayfs ") || readlinkSync(`/proc/${workerPid}/exe`) !== executables.fuse.path
      || /^PPid:\s*(\d+)/m.exec(status)?.[1] !== String(child.pid)) throw new Error("verification mount worker identity differs");
    const metadata: ViewMetadata = { format: "dokkabi-verification-view-v1", root, source: pinned.text, upper, mount, owner_pid: process.pid, owner_start: processStart(process.pid), helper_pid: child.pid!, socket, dependencies: [] };
    validateLease(metadata);
    writeFileSync(metadataPath(root), JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
    views.set(root, { metadata, process: child, directoryFds, unmountExecutable: executables.unmount.path, observe });
    observe?.("opened", { source: pinned.text, view: root, mount_id: mount.split(" ")[0]! });
    registered = true;
    return root;
  } finally {
    if (!registered) {
      child?.kill("SIGTERM");
      const until = Date.now() + 3000;
      while (mountIdentity(root) && Date.now() < until) pause(10);
      views.delete(root);
      for (const fd of directoryFds) closeSync(fd);
    }
  }
}

export function registerVerificationViewDependency(root: string, dependency: string): void {
  const own = views.get(root);
  if (!own) return; // APFS clones are kernel snapshots, not guarded lower views.
  own.metadata = { ...own.metadata, dependencies: [...own.metadata.dependencies, dependency] };
  writeFileSync(metadataPath(root), JSON.stringify(own.metadata), { mode: 0o600 });
}
export function assertVerificationViewStable(root: string): void {
  const canonical = process.platform === "linux" ? realpathSync(root) : root;
  const data = readMetadata(canonical);
  if (!data) return;
  if (mountIdentity(canonical) !== data.mount || processStart(data.owner_pid) !== data.owner_start) throw new Error("verification view owner or mount identity changed");
  validateLease(data);
  for (const dependency of data.dependencies) assertVerificationViewStable(dependency);
}
/** The source lease freezes accepted lower generations. Writes are private in
 * the upper FS, whose actual clock is available in child verifiers as well. */
export function verificationViewClock(dev: bigint): { path: string; dev: bigint } | undefined {
  for (const data of [...views.values()].map((view) => view.metadata).concat([...borrowed.values()])) {
    if (mountIdentity(data.root) !== data.mount) { borrowed.delete(data.root); continue; }
    if (lstatSync(data.root, { bigint: true }).dev === dev) return { path: data.upper, dev: lstatSync(data.upper, { bigint: true }).dev };
  }
  return undefined;
}
export function disposeVerificationViewsUnder(holder: string): boolean {
  for (const view of [...views.values()].reverse()) {
    const { root, source, mount } = view.metadata;
    if (root !== holder && !root.startsWith(holder + "/")) continue;
    if (mountIdentity(root) !== mount) return false;
    const result = spawnSync(view.unmountExecutable, ["-u", root], { timeout: 5000 });
    if (result.status !== 0 || mountIdentity(root)) return false;
    view.process.kill("SIGTERM");
    for (const fd of view.directoryFds) closeSync(fd);
    views.delete(root); borrowed.delete(root);
    view.observe?.("closed", { source, view: root, mount_id: mount.split(" ")[0]! });
  }
  return true;
}
process.once("exit", () => { for (const root of [...views.keys()].reverse()) disposeVerificationViewsUnder(root); });
