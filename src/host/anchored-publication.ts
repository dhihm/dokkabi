import { resolve } from "node:path";
import { assertSandboxExecutableIdentity, findAndSealSandboxExecutable } from "./sandbox-executable.ts";

/** Python's POSIX dir_fd operations bind every write/rename to open directory
 * descriptors on Linux and macOS. No PATH lookup, repository script or shell. */
const PUBLISH = String.raw`
import json, os, secrets, stat, sys, tempfile
D = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def parts(value):
    values = value.split('/')
    if not values or any(x in ('', '.', '..') or '\0' in x for x in values):
        raise ValueError('noncanonical publication path')
    return values

def walk(fd, names, create=False):
    current = os.dup(fd)
    try:
        for name in names:
            try:
                child = os.open(name, D, dir_fd=current)
            except FileNotFoundError:
                if not create: raise
                try: os.mkdir(name, 0o700, dir_fd=current)
                except FileExistsError: pass
                child = os.open(name, D, dir_fd=current)
                os.fsync(current)
            os.close(current)
            current = child
        return current
    except:
        os.close(current)
        raise

def remove_tree(parent, name):
    try: fd = os.open(name, D, dir_fd=parent)
    except OSError:
        os.unlink(name, dir_fd=parent)
        return
    try:
        for child in os.listdir(fd): remove_tree(fd, child)
    finally: os.close(fd)
    os.rmdir(name, dir_fd=parent)

header = sys.stdin.buffer.readline(16 * 1024 * 1024 + 1)
if len(header) > 16 * 1024 * 1024 or not header.endswith(b'\n'): raise ValueError('publication manifest limit')
data = json.loads(header)
dest = data['destination']
# Canonical system aliases on macOS are OS-owned, not user-controlled ancestry.
if sys.platform == 'darwin':
    for alias in ('/tmp/', '/var/', '/etc/'):
        if dest.startswith(alias): dest = '/private' + dest; break
if not dest.startswith('/'): raise ValueError('absolute publication destination required')
components = parts(dest[1:])
root = os.open('/', D)
try:
    anchor = data.get('anchor')
    if anchor:
        anchor_parts = parts(anchor['path'][1:])
        base = walk(root, anchor_parts)
        try:
            identity = os.fstat(base)
            if str(identity.st_dev) != anchor['dev'] or str(identity.st_ino) != anchor['ino']: raise ValueError('workspace root identity changed')
            if components[:len(anchor_parts)] != anchor_parts or len(components) <= len(anchor_parts): raise ValueError('destination outside anchor')
            parent = walk(base, components[len(anchor_parts):-1], True)
        finally: os.close(base)
    else: parent = walk(root, components[:-1], True)
finally: os.close(root)
name = components[-1]
holder = tempfile.mkdtemp(prefix='dokkabi-publication-')
holder_fd = os.open(holder, D)
stage = 'tree'
os.mkdir(stage, 0o700, dir_fd=holder_fd)
stage_fd = os.open(stage, D, dir_fd=holder_fd)
try:
    files = data['files']
    if not files or len(files) > 100000: raise ValueError('publication file count')
    total = 0
    for item in files:
        names = parts(item['name'])
        size = item['size']; total += size
        if not isinstance(size, int) or size < 0 or total > 512 * 1024 * 1024: raise ValueError('publication byte limit')
        folder = walk(stage_fd, names[:-1], True)
        try:
            fd = os.open(names[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, item['mode'], dir_fd=folder)
            try:
                left = size
                while left:
                    chunk = sys.stdin.buffer.read(min(left, 65536))
                    if not chunk: raise ValueError('truncated publication input')
                    offset = 0
                    while offset < len(chunk): offset += os.write(fd, chunk[offset:])
                    left -= len(chunk)
                os.fsync(fd)
            finally: os.close(fd)
            os.fsync(folder)
        finally: os.close(folder)
    if sys.stdin.buffer.read(1): raise ValueError('unexpected publication input')
    os.fsync(stage_fd)
    if data['kind'] in ('file', 'replace-file'):
        if len(files) != 1 or files[0]['name'] != 'payload': raise ValueError('invalid file publication')
        if data['kind'] == 'replace-file':
            try:
                old = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(old.st_mode): raise ValueError('destination is not a regular file')
            except FileNotFoundError: pass
            os.replace('payload', name, src_dir_fd=stage_fd, dst_dir_fd=parent)
        else: os.link('payload', name, src_dir_fd=stage_fd, dst_dir_fd=parent, follow_symlinks=False)
    elif data['kind'] == 'directory':
        try:
            target = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(target.st_mode): raise ValueError('destination is not a real directory')
            existing = os.open(name, D, dir_fd=parent)
            try:
                if os.listdir(existing): raise ValueError('destination is not empty')
            finally: os.close(existing)
        except FileNotFoundError: pass
        os.rename(stage, name, src_dir_fd=holder_fd, dst_dir_fd=parent)
        stage = None
    else: raise ValueError('invalid publication kind')
    os.fsync(parent)
finally:
    os.close(stage_fd)
    if stage is not None: remove_tree(holder_fd, stage)
    os.close(holder_fd)
    os.rmdir(holder)
    os.close(parent)
`;

export function publishAnchored(destination: string, files: ReadonlyMap<string, Buffer>, executable: ReadonlySet<string> = new Set(), kind: "file" | "directory" | "replace-file" = "directory", anchor?: { path: string; dev: string; ino: string }): void {
  const interpreter = findAndSealSandboxExecutable("python3", [process.cwd()]);
  if (!interpreter) throw new Error("anchored publication requires a trusted Python 3 interpreter");
  assertSandboxExecutableIdentity(interpreter);
  const entries = [...files].map(([name, bytes]) => ({ name, size: bytes.length, mode: executable.has(name) ? 0o700 : 0o600 }));
  const manifest = Buffer.from(JSON.stringify({ destination: resolve(destination), kind, files: entries, anchor }) + "\n");
  if (manifest.length > 16 * 1024 * 1024 || entries.length > 100000 || entries.reduce((n,e)=>n+e.size,0)>512*1024*1024) throw new Error("anchored publication budget exceeded");
  const result = Bun.spawnSync([interpreter.path, "-I", "-c", PUBLISH], {
    cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdin: Buffer.concat([manifest, ...files.values()]), stdout: "ignore", stderr: "pipe", timeout: 60000, maxBuffer: 8192,
  });
  if (result.exitCode !== 0 || result.signalCode) throw new Error("anchored publication refused or incomplete");
}
