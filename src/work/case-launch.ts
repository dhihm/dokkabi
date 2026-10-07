import { join, resolve } from "node:path";

/**
 * A case's working directory is path data, never shell syntax (D49 R4).
 *
 * Every path that runs a recorded case in a directory — the `check` call's own
 * observation, the plan probe, the final observation, the base pass, the
 * verify-rounds recheck, and the graph loop's remote launches (the plain run,
 * the watched launch, the dependency digest) — builds its launch here, so a
 * directory with a space, `$`, `;`, a quote or a leading `-` in its name is
 * entered as that directory, and nothing in it is expanded or run.
 *
 * The one form that is not literal is a leading home anchor: `~` or `$HOME`,
 * alone or followed by `/`. It names the home directory of the machine the
 * command runs on — the spelling a remote case uses, since its home is not
 * known here, and the one the sandbox mirrors home-relative roots under — and
 * the rest of the path after it is literal. The host's remote diff reads a
 * remote workspace the same way (ssh.ts).
 *
 * The launch is built only for execution: the recorded command and dir bytes,
 * and every receipt, keep binding what the session declared.
 */

/** POSIX single-quoting: the text as one shell word, nothing in it expanded. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The path after a leading home anchor (`~`, `$HOME`, alone or followed by
 * `/`), or undefined when the directory does not start with one. */
function homeRelative(dir: string): string | undefined {
  if (dir === "~" || dir === "$HOME") return "";
  if (dir.startsWith("~/")) return dir.slice(2);
  if (dir.startsWith("$HOME/")) return dir.slice("$HOME/".length);
  return undefined;
}

/** The shell word that names `dir` for `cd`: single-quoted, the home anchor
 * as `"$HOME"`, and a bare `-` (which `cd` reads as the previous directory)
 * as `./-`. */
export function caseDirWord(dir: string): string {
  const home = homeRelative(dir);
  if (home !== undefined) return home === "" ? '"$HOME"' : `"$HOME"/${shellQuote(home)}`;
  return shellQuote(dir === "-" ? "./-" : dir);
}

/** The launch of a case: `cd -- <dir> && <command>` when it names a
 * directory, the command alone otherwise. */
export function caseLaunch(dir: string | undefined, command: string): string {
  return dir === undefined || dir === "" ? command : `cd -- ${caseDirWord(dir)} && ${command}`;
}

/** The directory the launch enters, resolved the way the shell will resolve
 * it from `from`: the home anchor against `home` (HOME by default), anything
 * else literally. Undefined for a home-anchored directory when no home is
 * known (an empty one). */
export function caseDirPath(dir: string, from: string, home: string | undefined = process.env.HOME): string | undefined {
  const rest = homeRelative(dir);
  if (rest === undefined) return resolve(from, dir);
  return home === undefined || home === "" ? undefined : resolve(join(home, rest));
}
