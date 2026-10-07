import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

/**
 * What a remote case ran against, read from the host itself.
 *
 * A case on another machine used to be recorded as "remote_reported": the
 * transport brought back an outcome and nothing about the tree it ran on.
 * Strict evidence refused all of it, which is right for an unobserved tree and
 * wrong as the only option -- a whole campaign on a GPU host could never earn
 * a single case, and spun replanning a graph it could not move.
 *
 * The host is a git checkout, so its state is cheap to state exactly: HEAD,
 * plus every path git reports as changed or untracked with its content digest.
 * The checker is the test file, the conftest.py files above it and the root
 * pytest configuration, digested by content. That is the same pair a local workspace case records,
 * and the same comparisons then apply: red before green on the same checker, a
 * tree that changed during the run refused.
 */

export type RemoteFile = { path: string; mode: number; digest: string };
export type RemoteSnapshot = { workspace_files: RemoteFile[]; checker_files: { path: string; digest: string }[] };
export type RemoteExec = (host: string, script: string) => { ok: boolean; stdout: string };

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** `cd` into the case directory, keeping a leading ~ or $HOME expandable. */
function cdInto(dir: string | undefined): string {
  if (!dir || dir === ".") return "";
  const home = /^(?:~|\$HOME|\$\{HOME\})(\/.*)?$/u.exec(dir);
  if (home) return `cd "$HOME"${home[1] ? quote(home[1]) : ""} || exit 3`;
  return `cd ${quote(dir)} || exit 3`;
}

const CHECKER_ROOT_FILES = ["conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"];

/**
 * The test file, the conftest.py of every directory above it, and the root
 * configuration. Not the test's whole directory: a campaign adds the next
 * phase's test file beside this one, and that must not reopen a case whose
 * own bar never moved.
 */
export function remoteCheckerPaths(checkerFile: string): string[] {
  const paths = [checkerFile];
  for (let dir = dirname(checkerFile); dir !== "." && dir !== "/" && dir !== ""; dir = dirname(dir)) paths.push(`${dir}/conftest.py`);
  return [...paths, ...CHECKER_ROOT_FILES];
}

export function remoteSnapshotScript(dir: string | undefined, checkerFile: string): string {
  return [
    "set -u",
    cdInto(dir),
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 4",
    'echo "H $(git rev-parse HEAD)"',
    "git -c core.quotepath=off status --porcelain=v1 -z --untracked-files=all | while IFS= read -r -d '' rec; do",
    '  st="${rec:0:2}"; p="${rec:3}"',
    '  case "$st" in R*|C*) IFS= read -r -d \'\' _orig ;; esac',
    '  if [ -f "$p" ] && [ ! -L "$p" ]; then echo "F $(stat -c %a "$p" 2>/dev/null || echo 0) $(sha256sum < "$p" | cut -c1-64) $p";',
    '  elif [ -L "$p" ]; then echo "L 0 $(readlink "$p" | sha256sum | cut -c1-64) $p";',
    '  elif [ -d "$p" ]; then :;',
    '  else echo "D 0 - $p"; fi',
    "done",
    'echo "--checker--"',
    `git ls-files -co --exclude-standard -z -- ${remoteCheckerPaths(checkerFile).map(quote).join(" ")} | sort -z | while IFS= read -r -d '' p; do`,
    '  [ -f "$p" ] && echo "C $(sha256sum < "$p" | cut -c1-64) $p"',
    "done",
    'echo "--end--"',
  ].filter(Boolean).join("\n");
}

export function parseRemoteSnapshot(stdout: string): RemoteSnapshot | undefined {
  if (!stdout.includes("--end--")) return undefined;
  const workspace_files: RemoteFile[] = [];
  const checker_files: { path: string; digest: string }[] = [];
  let head: string | undefined;
  for (const line of stdout.split("\n")) {
    const m = /^([HFLDC]) (.*)$/u.exec(line);
    if (!m) continue;
    const [, kind, rest] = m as unknown as [string, string, string];
    if (kind === "H") { if (!/^[0-9a-f]{40,64}$/u.test(rest)) return undefined; head = rest; continue; }
    if (kind === "C") {
      const c = /^([0-9a-f]{64}) (.+)$/u.exec(rest);
      if (c) checker_files.push({ path: c[2]!, digest: c[1]! });
      continue;
    }
    const f = /^(\d+) ([0-9a-f]{64}|-) (.+)$/u.exec(rest);
    if (!f) continue;
    const mode = Math.min(0o777, Number.parseInt(f[1]!, 8) || 0);
    workspace_files.push({ path: f[3]!, mode, digest: kind === "D" ? hash("deleted") : kind === "L" ? hash(`link:${f[2]}`) : f[2]! });
  }
  if (!head) return undefined;
  workspace_files.push({ path: ":HEAD", mode: 0, digest: hash(`HEAD ${head}`) });
  workspace_files.sort((a, b) => a.path.localeCompare(b.path));
  checker_files.sort((a, b) => a.path.localeCompare(b.path));
  return { workspace_files, checker_files };
}

const sshExec: RemoteExec = (host, script) => {
  const out = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "RequestTTY=no", "--", host, "bash -s"], {
    input: script, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: out.status === 0, stdout: out.stdout ?? "" };
};

let exec: RemoteExec = sshExec;
/** Tests substitute the transport; production reads the host over ssh. */
export function setRemoteSnapshotExec(next: RemoteExec | undefined): void { exec = next ?? sshExec; }

/** Undefined when the host could not be read: the case then stays remote_reported. */
export function captureRemoteSnapshot(host: string, dir: string | undefined, checkerFile: string): RemoteSnapshot | undefined {
  try {
    const result = exec(host, remoteSnapshotScript(dir, checkerFile));
    return result.ok ? parseRemoteSnapshot(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}
