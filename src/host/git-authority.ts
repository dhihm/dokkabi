import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertSandboxExecutableIdentity,
  requireAndSealSandboxExecutable,
} from "./sandbox-executable.ts";
import { trustedGitMetadata, type TrustedGitMetadata } from "./sandbox-docker.ts";

/**
 * S2 (D57e, design memo §117): NO HOST PROCESS RUNS A PROGRAM A SESSION CHOSE.
 *
 * Git names programs in its configuration — `core.fsmonitor`, a filter's
 * `clean`/`smudge`/`process`, `diff.<driver>.textconv`, `diff.external`,
 * hooks and `core.hooksPath`, `core.pager`, `core.askPass`, `core.sshCommand`,
 * `core.editor`, `gpg.program`, … — and a repository's configuration can
 * include any other file (`include.path`, `includeIf`). A session writes its
 * tree's `.git` like any other file. So the host never lets git read a tree's
 * configuration at all: every sealed git process runs on a HOST-BUILT git
 * directory — a private temporary directory holding a configuration the host
 * wrote (no includes, every program-naming key fixed to nothing), the tree's
 * HEAD copied in as data, its refs and objects as data, NEVER its index (I2,
 * D57g: a fresh empty one of the host's own; where a work-tree index is
 * needed the host builds it from its own listing, host-index.ts) — with the
 * tree as the work tree. What git can still read of the tree is
 * data: attributes and ignore files name drivers only through a
 * configuration, and this one defines none. Submodules are never recursed
 * into (a submodule's own git would read its own configuration): the
 * configuration says so and every subcommand that looks inside one is given
 * `--ignore-submodules=all`. The sealed `-c` arguments and environment stay
 * as defence in depth: they also reach any git child process.
 *
 * A caller that needs a value of the tree's own configuration (an origin URL)
 * reads the file as data (sealedGitConfigFile: `git config --file …
 * --no-includes`, outside any repository).
 */

const SEALED_GIT_ARGS = Object.freeze([
  "--no-pager",
  "--no-replace-objects",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  // I2 (D57g): attributes neutralised — no attributes file, no textconv, no
  // external diff; in-tree `.gitattributes` names no driver the host defines.
  "-c", "core.attributesFile=/dev/null",
  "-c", "diff.noprefix=false",
  "-c", "core.askPass=/bin/false",
  "-c", "core.pager=cat",
  "-c", "core.editor=/bin/false",
  "-c", "core.sshCommand=/bin/false",
  "-c", "core.untrackedCache=false",
  "-c", "credential.helper=",
  "-c", "credential.interactive=never",
  "-c", "diff.ignoreSubmodules=all",
  "-c", "status.submoduleSummary=false",
  "-c", "submodule.recurse=false",
  "-c", "protocol.allow=never",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "gpg.program=/bin/false",
  "-c", "log.showSignature=false",
  "-c", "sequence.editor=/bin/false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
] as const);

const SEALED_GIT_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/dev/null",
  XDG_CONFIG_HOME: "/dev/null",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_SSH_COMMAND: "/bin/false",
  GCM_INTERACTIVE: "Never",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: "/bin/false",
  EDITOR: "/bin/false",
  VISUAL: "/bin/false",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
});

const ALLOWED_EXTRA_ENV = new Set([
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
]);

/** Subcommands that compare a work tree with its index or a tree and so
 * would look inside a populated submodule by starting a git there. */
const SUBMODULE_LOOKING = new Set(["status", "diff", "diff-files", "diff-index"]);

/** The subcommands a sealed git may run: what the host's callers use, each
 * one known not to start a git inside a submodule (whose own configuration
 * that git would read) once SUBMODULE_LOOKING is applied. `add`, `commit -a`,
 * `rm`, `stash`, `checkout` and their kind check a submodule's dirtiness
 * whatever the configuration says; the tree is staged with
 * stageTreeSealed (ls-files + update-index) instead. */
const SEALED_SUBCOMMANDS = new Set([
  "apply", "bundle", "cat-file", "check-ignore", "check-ref-format", "checkout-index", "commit-tree", "diff", "diff-files", "diff-index",
  "diff-tree", "fetch", "for-each-ref", "grep", "hash-object", "log", "ls-files", "ls-tree", "merge-base", "mktree", "push",
  "read-tree", "reset", "rev-list", "rev-parse", "show", "status", "symbolic-ref", "update-index", "update-ref", "var",
  "write-tree",
]);

/** The repository format the host-built configuration carries: the only
 * values of the tree's configuration git needs to read the tree's objects
 * and refs at all. */
interface RepositoryFormat {
  readonly version: 0 | 1;
  readonly objectFormat: "sha1" | "sha256";
  readonly refStorage: "files" | "reftable";
  /** What the file system the tree lives on can hold, as git init probed it
   * (booleans only, validated): whether file modes, symbolic links and names
   * differing only in case are distinct there. */
  readonly filemode: boolean;
  readonly symlinks: boolean;
  readonly ignorecase: boolean;
}

const FS_FLAGS = ["core.filemode", "core.symlinks", "core.ignorecase"] as const;

/** git's boolean spellings; undefined for anything else. */
function gitBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0", ""].includes(value)) return false;
  return undefined;
}

/**
 * Execute Git as a host capability, never via repository-controlled PATH,
 * the operator environment, or the tree's own configuration: git reads a
 * host-built git directory (buildHostGitDirectory) with the tree as its work
 * tree. HEAD moves the command makes are written back to the tree's HEAD as
 * data; refs, objects and the index are the tree's own, read and written as
 * data.
 */
/** How many sealed git processes the host started (diagnostics, cost). */
export const SEALED_GIT_CALLS = { calls: 0 };

export function spawnSealedHostGit(
  root: string,
  args: readonly string[],
  options: {
    readonly extraEnv?: Readonly<Record<string, string>>;
    /** A validated, in-memory GitHub HTTPS header for one fixed host push. */
    readonly httpsAuthHeader?: string;
    /** stdin: text, or exact bytes (a `-z` list of paths, D57). */
    readonly input?: string | Buffer;
    readonly timeoutMs?: number;
    /** The tree's own index, named for why (I2, D57g) — never an authority
     * for what a tree covers or tracks: `host-made`, a repository the host
     * itself made (a swarm target); `state-as-data`, the pre-fix save and
     * restore, which keeps a developer's index as bytes and puts it back;
     * `display`, the dashboard showing the operator the repository's own
     * status and staged diff. */
    readonly treeIndex?: "host-made" | "state-as-data" | "display";
  } = {},
) {
  SEALED_GIT_CALLS.calls += 1;
  const canonicalRoot = realpathSync(resolve(root));
  const metadata = trustedGitMetadata(canonicalRoot);
  if (!metadata) throw new Error("host Git workspace metadata is not trusted");
  assertGitObjectAuthority(metadata.gitDir, metadata.commonDir);
  const executable = requireAndSealSandboxExecutable("git", [canonicalRoot]);
  assertSandboxExecutableIdentity(executable);
  const extraEnv = options.extraEnv ?? {};
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!ALLOWED_EXTRA_ENV.has(key) || value.includes("\0") || value.includes("\n")) {
      throw new Error(`untrusted host Git environment override: ${key}`);
    }
    validateObjectEnvironment(metadata, key, value);
  }
  const httpsAuthHeader = options.httpsAuthHeader;
  if (httpsAuthHeader !== undefined &&
      (!/^Authorization: basic [A-Za-z0-9+/=]{8,8192}$/u.test(httpsAuthHeader)
        || httpsAuthHeader.includes("\n") || httpsAuthHeader.includes("\0"))) {
    throw new Error("untrusted host Git HTTPS authorization header");
  }
  const sealedArgs = withoutSubmodules(args);
  const host = buildHostGitDirectory(executable.path, metadata);
  try {
    const result = Bun.spawnSync([
      executable.path,
      ...SEALED_GIT_ARGS,
      `--git-dir=${host.dir}`,
      `--work-tree=${canonicalRoot}`,
      ...(httpsAuthHeader ? ["--config-env=http.extraHeader=DOKKABI_GITHUB_AUTH_HEADER"] : []),
      ...sealedArgs,
    ], {
      cwd: canonicalRoot,
      env: {
        ...SEALED_GIT_ENV,
        // I2 (D57g): never the tree's index — a fresh, empty one of the
        // host's own, unless the caller gives its own (a host-built index,
        // host-index.ts) or the repository is one the host made.
        GIT_INDEX_FILE: options.treeIndex !== undefined ? host.treeIndex : host.index,
        GIT_OBJECT_DIRECTORY: host.objects,
        ...extraEnv,
        ...(httpsAuthHeader ? { DOKKABI_GITHUB_AUTH_HEADER: httpsAuthHeader } : {}),
      },
      ...(options.input === undefined ? {} : { stdin: typeof options.input === "string" ? Buffer.from(options.input) : options.input }),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    host.writeBackHead();
    return result;
  } finally {
    host.dispose();
  }
}

/**
 * `git config --file <the tree's own config file> --no-includes <args>`:
 * the tree's configuration read (or, for a repository the host itself just
 * made, written) as DATA — outside any repository, no include followed,
 * nothing it names run. Throws when the tree's git metadata is not trusted.
 */
export function sealedGitConfigFile(root: string, args: readonly string[], options: { readonly timeoutMs?: number } = {}) {
  const canonicalRoot = realpathSync(resolve(root));
  const metadata = trustedGitMetadata(canonicalRoot);
  if (!metadata) throw new Error("host Git workspace metadata is not trusted");
  const executable = requireAndSealSandboxExecutable("git", [canonicalRoot]);
  assertSandboxExecutableIdentity(executable);
  const file = join(metadata.commonDir ?? metadata.gitDir, "config");
  return Bun.spawnSync([executable.path, ...SEALED_GIT_ARGS, "config", "--file", file, "--no-includes", ...args], {
    cwd: "/",
    env: { ...SEALED_GIT_ENV, GIT_CEILING_DIRECTORIES: "/" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * git's `diff --numstat --ignore-space-at-eol` of two byte strings the host
 * holds (C1: a change set's line counts are the host's, never a repository's
 * diff): both written to a private temporary directory and compared with
 * `git diff --no-index` outside any repository — no configuration, no
 * attributes, no driver. `beforeAbsent`/`afterAbsent` compare against
 * nothing (an added or a deleted file). Undefined when git cannot say.
 */
export function sealedNoIndexNumstat(
  before: Buffer,
  after: Buffer,
  options: { readonly beforeAbsent?: boolean; readonly afterAbsent?: boolean } = {},
): { readonly added: number; readonly removed: number } | undefined {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dokkabi-numstat-")));
  try {
    const a = options.beforeAbsent === true ? "/dev/null" : join(dir, "a");
    const b = options.afterAbsent === true ? "/dev/null" : join(dir, "b");
    if (options.beforeAbsent !== true) writeFileSync(a, before, { mode: 0o600 });
    if (options.afterAbsent !== true) writeFileSync(b, after, { mode: 0o600 });
    const executable = requireAndSealSandboxExecutable("git", [dir]);
    assertSandboxExecutableIdentity(executable);
    const run = Bun.spawnSync([
      executable.path, ...SEALED_GIT_ARGS,
      "diff", "--no-index", "--numstat", "--ignore-space-at-eol", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--", a, b,
    ], {
      cwd: dir,
      env: { ...SEALED_GIT_ENV, GIT_CEILING_DIRECTORIES: dirname(dir) },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    if (run.exitCode === 0) return { added: 0, removed: 0 };
    if (run.exitCode !== 1) return undefined;
    const line = run.stdout.toString("latin1").split("\n")[0] ?? "";
    const match = /^(\d+|-)\t(\d+|-)\t/u.exec(line);
    if (!match) return undefined;
    return { added: match[1] === "-" ? 0 : Number(match[1]), removed: match[2] === "-" ? 0 : Number(match[2]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The arguments a sealed git runs with: the subcommand must be one of
 * SEALED_SUBCOMMANDS, no submodule recursion may be asked for, and a
 * subcommand that would otherwise start a git inside a populated submodule
 * (which reads that submodule's own configuration) gets
 * `--ignore-submodules=all` unless the caller chose a value itself. Throws
 * otherwise, before anything runs. */
function withoutSubmodules(args: readonly string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "-C") index += 2;
    else if (arg.startsWith("-")) index += 1;
    else break;
  }
  const subcommand = args[index];
  if (subcommand === undefined || !SEALED_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`host Git subcommand is not sealed: ${String(subcommand).slice(0, 40)}`);
  }
  if (args.some((arg) => /^--recurse-submodules(?:=|$)/u.test(arg))) {
    throw new Error("host Git never recurses into submodules");
  }
  if (!SUBMODULE_LOOKING.has(subcommand)) return [...args];
  if (args.some((arg) => arg.startsWith("--ignore-submodules"))) return [...args];
  return [...args.slice(0, index + 1), "--ignore-submodules=all", ...args.slice(index + 1)];
}

// --- the host-built git directory ------------------------------------------------------

interface HostGitDirectory {
  /** The git directory git is given (`--git-dir`). */
  readonly dir: string;
  /** A fresh index of the host's own (GIT_INDEX_FILE unless the caller gives
   * one): empty. */
  readonly index: string;
  /** The tree's own index file — only for a repository the host made. */
  readonly treeIndex: string;
  /** The tree's object directory (GIT_OBJECT_DIRECTORY unless given). */
  readonly objects: string;
  /** Write a HEAD the command moved back to the tree's HEAD, as data. */
  writeBackHead(): void;
  dispose(): void;
}

const FORMAT_CACHE = new Map<string, RepositoryFormat>();

/** The tree's repository format, read from its config FILE as data
 * (`git config --file … --no-includes`, outside any repository), cached by
 * the file's identity. */
function repositoryFormat(executable: string, commonDir: string): RepositoryFormat {
  const file = join(commonDir, "config");
  let key: string | undefined;
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error("host Git repository configuration is not a regular file");
    key = `${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { version: 0, objectFormat: "sha1", refStorage: "files", filemode: true, symlinks: true, ignorecase: false };
    }
    throw error;
  }
  const cached = FORMAT_CACHE.get(key);
  if (cached !== undefined) return cached;
  const listed = Bun.spawnSync([executable, ...SEALED_GIT_ARGS, "config", "--file", file, "--no-includes", "-z", "--list"], {
    cwd: "/",
    env: { ...SEALED_GIT_ENV, GIT_CEILING_DIRECTORIES: "/" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (listed.exitCode !== 0) {
    throw new Error(`host Git cannot read the repository format: ${listed.stderr.toString().trim().slice(0, 300)}`);
  }
  const values = new Map<string, string>();
  for (const entry of listed.stdout.toString("latin1").split("\0")) {
    const newline = entry.indexOf("\n");
    const name = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    if (name === "core.repositoryformatversion" || name === "extensions.objectformat" || name === "extensions.refstorage"
      || (FS_FLAGS as readonly string[]).includes(name)) {
      values.set(name, newline < 0 ? "true" : entry.slice(newline + 1).trim().toLowerCase());
    }
  }
  const version = values.get("core.repositoryformatversion") ?? "0";
  const objectFormat = values.get("extensions.objectformat") ?? "sha1";
  const refStorage = values.get("extensions.refstorage") ?? "files";
  if ((version !== "0" && version !== "1") || (objectFormat !== "sha1" && objectFormat !== "sha256")
    || (refStorage !== "files" && refStorage !== "reftable")) {
    throw new Error("host Git repository format cannot be sealed");
  }
  const format: RepositoryFormat = {
    version: version === "1" ? 1 : 0,
    objectFormat: objectFormat === "sha256" ? "sha256" : "sha1",
    refStorage: refStorage === "reftable" ? "reftable" : "files",
    filemode: gitBoolean(values.get("core.filemode")) ?? true,
    symlinks: gitBoolean(values.get("core.symlinks")) ?? true,
    ignorecase: gitBoolean(values.get("core.ignorecase")) ?? false,
  };
  if (FORMAT_CACHE.size > 256) FORMAT_CACHE.clear();
  FORMAT_CACHE.set(key, format);
  return format;
}

/** The configuration the host writes for every sealed git: nothing in it
 * names a program, nothing includes anything. */
function hostConfig(format: RepositoryFormat): string {
  return [
    "[core]",
    `\trepositoryformatversion = ${format.version}`,
    "\tbare = false",
    `\tfilemode = ${format.filemode}`,
    `\tsymlinks = ${format.symlinks}`,
    `\tignorecase = ${format.ignorecase}`,
    "\tprecomposeunicode = false",
    "\tlogallrefupdates = false",
    "\tfsmonitor = false",
    "\tuntrackedCache = false",
    "\tsplitIndex = false",
    "\thooksPath = /dev/null",
    "\tattributesFile = /dev/null",
    "\texcludesFile = /dev/null",
    "\taskPass = /bin/false",
    "\tsshCommand = /bin/false",
    "\tpager = cat",
    "\teditor = /bin/false",
    "[diff]",
    "\tignoreSubmodules = all",
    "[status]",
    "\tsubmoduleSummary = false",
    "[submodule]",
    "\trecurse = false",
    "[fetch]",
    "\trecurseSubmodules = false",
    "[push]",
    "\trecurseSubmodules = no",
    "[commit]",
    "\tgpgSign = false",
    "[tag]",
    "\tgpgSign = false",
    "[gpg]",
    "\tprogram = /bin/false",
    "[log]",
    "\tshowSignature = false",
    "[sequence]",
    "\teditor = /bin/false",
    "[gc]",
    "\tauto = 0",
    "[maintenance]",
    "\tauto = false",
    "[protocol]",
    "\tallow = never",
    ...(format.version === 1
      ? ["[extensions]", `\tobjectformat = ${format.objectFormat}`, ...(format.refStorage === "reftable" ? ["\trefstorage = reftable"] : [])]
      : []),
    "",
  ].join("\n");
}

/** A regular file of the tree's git directory, read as data: never through
 * a link, never blocking on a FIFO, at most `limit` bytes; undefined when it
 * is absent or not a regular file. */
function readGitDataFile(path: string, limit: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
    const out = Buffer.alloc(stat.size);
    let read = 0;
    while (read < out.length) {
      const got = readSync(fd, out, read, out.length - read, read);
      if (got === 0) break;
      read += got;
    }
    return out.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

const HEAD_SYMREF = /^ref: refs\/[\x21-\x7e]{1,1000}\n?$/u;
const HEAD_DETACHED = /^[0-9a-f]{40}(?:[0-9a-f]{24})?\n?$/u;
/** What HEAD reads as when the tree's cannot be taken as data: an unborn
 * branch, so a command that needs HEAD fails the ordinary way. */
const PLACEHOLDER_HEAD = "ref: refs/heads/dokkabi-unreadable-head\n";

/**
 * A private git directory for one sealed git process on the tree of
 * `metadata`: the host's configuration; the tree's HEAD copied in (and
 * written back as data if the command moves it); the tree's refs, packed
 * refs, shared index files and ignore/attribute data reachable as data;
 * objects and index given by environment. Never a hook, never the tree's
 * configuration, never its `commondir` (which would reach the common
 * configuration).
 */
function buildHostGitDirectory(executable: string, metadata: TrustedGitMetadata): HostGitDirectory {
  const gitDir = realpathSync(metadata.gitDir);
  const commonDir = realpathSync(metadata.commonDir ?? metadata.gitDir);
  const format = repositoryFormat(executable, commonDir);
  const dir = mkdtempSync(join(tmpdir(), "dokkabi-host-git-"));
  let head = PLACEHOLDER_HEAD;
  let done = false;
  const dispose = () => {
    if (done) return;
    done = true;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    writeFileSync(join(dir, "config"), hostConfig(format), { mode: 0o600 });
    const treeHead = readGitDataFile(join(gitDir, "HEAD"), 4096)?.toString("latin1");
    head = treeHead !== undefined && (HEAD_SYMREF.test(treeHead) || HEAD_DETACHED.test(treeHead))
      ? (treeHead.endsWith("\n") ? treeHead : `${treeHead}\n`)
      : PLACEHOLDER_HEAD;
    writeFileSync(join(dir, "HEAD"), head, { mode: 0o600 });
    const link = (name: string, target: string, kind: "dir" | "file") => {
      let stat;
      try {
        stat = lstatSync(target);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink() || (kind === "dir" ? !stat.isDirectory() : !stat.isFile())) return false;
      symlinkSync(target, join(dir, name));
      return true;
    };
    if (!link("refs", join(commonDir, "refs"), "dir")) mkdirSync(join(dir, "refs"), { mode: 0o700 });
    link("packed-refs", join(commonDir, "packed-refs"), "file");
    if (format.refStorage === "reftable") link("reftable", join(commonDir, "reftable"), "dir");
    // Data git reads beside the refs: shallow roots. Never the tree's
    // excludes or attributes (I2, D57g: `info/exclude` and `info/attributes`
    // are the session's to write) and never its index.
    const shallow = readGitDataFile(join(commonDir, "shallow"), 64 * 1024 * 1024);
    if (shallow !== undefined) writeFileSync(join(dir, "shallow"), shallow, { mode: 0o600 });
    mkdirSync(join(dir, "info"), { mode: 0o700 });
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    dir,
    index: join(dir, "index"),
    treeIndex: join(gitDir, "index"),
    objects: join(commonDir, "objects"),
    writeBackHead: () => writeBackHead(dir, gitDir, head),
    dispose,
  };
}

/** A HEAD the command moved (a detached commit, `update-ref --no-deref
 * HEAD`, a checkout of another branch) is the tree's HEAD afterwards: written
 * back as data, atomically, never through a link. A branch the command moved
 * was written through the refs as git writes them. */
function writeBackHead(dir: string, gitDir: string, copied: string): void {
  let moved: string;
  try {
    moved = readFileSync(join(dir, "HEAD"), "latin1");
  } catch {
    return;
  }
  if (!HEAD_SYMREF.test(moved) && !HEAD_DETACHED.test(moved)) return;
  const normalized = (text: string) => text.endsWith("\n") ? text : `${text}\n`;
  // Only a HEAD this command moved is written: what the tree's HEAD became
  // meanwhile is never overwritten with the copy taken before.
  if (normalized(moved) === normalized(copied) || normalized(moved) === PLACEHOLDER_HEAD) return;
  const temp = join(gitDir, `HEAD.dokkabi-${process.pid}-${randomBytes(6).toString("hex")}`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    writeFileSync(fd, normalized(moved));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, join(gitDir, "HEAD"));
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The rename's error is the one reported.
    }
    throw error;
  }
}

function validateObjectEnvironment(
  metadata: { readonly gitDir: string; readonly commonDir?: string },
  key: string,
  value: string,
): void {
  if (key === "GIT_ALTERNATE_OBJECT_DIRECTORIES") {
    const expected = realpathSync(join(metadata.commonDir ?? metadata.gitDir, "objects"));
    if (value !== expected) throw new Error("untrusted host Git alternate object directory");
    return;
  }
  if (key !== "GIT_OBJECT_DIRECTORY") return;
  const canonical = realpathSync(value);
  const root = dirname(canonical);
  if (canonical !== value || basename(canonical) !== "objects"
    || !basename(root).startsWith("dokkabi-swarm-objects-")
    || realpathSync(dirname(root)) !== realpathSync(tmpdir())
    || !statSync(canonical).isDirectory()) {
    throw new Error("untrusted host Git object directory");
  }
}

/** Host Git is not a filesystem sandbox. Reject metadata indirections that
 * could make object/ref traversal leave the validated repository before any
 * host-side Git command runs. Linked-worktree common metadata is allowed only
 * because trustedGitMetadata already verified its reciprocal backlink. */
function assertGitObjectAuthority(gitDir: string, commonDir?: string): void {
  const roots = [...new Set([gitDir, commonDir ?? gitDir].map((path) => realpathSync(path)))];
  for (const root of roots) {
    for (const relativePath of ["objects/info/alternates", "objects/info/http-alternates"]) {
      const path = join(root, relativePath);
      if (existsSync(path) && readFileSync(path, "utf8").trim().length > 0) {
        throw new Error("host Git object alternates are outside the sealed repository authority");
      }
    }
    for (const relativePath of ["objects", "refs", "info", "reftable"]) {
      const path = join(root, relativePath);
      if (existsSync(path)) assertTreeHasNoSymlinks(root, path);
    }
    for (const relativePath of ["packed-refs", "HEAD", "index", "shallow"]) {
      const path = join(root, relativePath);
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error("host Git metadata symlinks are not trusted");
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") throw error;
      }
    }
  }
}

function assertTreeHasNoSymlinks(root: string, directory: string): void {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const canonical = realpathSync(current);
    const rel = relative(root, canonical);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("host Git metadata leaves the sealed repository authority");
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error("host Git metadata symlinks are not trusted");
      }
      if (entry.isDirectory()) stack.push(join(current, entry.name));
    }
  }
}
