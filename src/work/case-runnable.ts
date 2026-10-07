/**
 * A case that cannot run at all is not the same as a case that fails.
 *
 * Live, a declared case pointed at a test file the model then reorganised away,
 * deleting the original as an orphan. From that point the case could only exit
 * with a runner usage error, which the harness recorded as an ordinary red. The
 * model read that as "already handled", reported nothing left to do, and the
 * loop handed it the same todo eight times across two waves.
 *
 * "Your product is wrong" and "the file your case names is gone" call for
 * completely different next moves, so the harness has to tell them apart and
 * say which one it is.
 */

/** Paths the runner said it could not find, in the order it named them. */
function missingPaths(output: string): string[] {
  const found: string[] = [];
  const patterns = [
    /file or directory not found:\s*(\S+)/giu,
    /ERROR collecting\s+(\S+)/giu,
    /no tests ran in .*?--\s*(\S+)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const path = match[1]?.trim();
      if (path) found.push(path);
    }
  }
  return found;
}

/**
 * Why this case could not run, or undefined when the run genuinely executed.
 *
 * An assertion failure is a real red and must pass through untouched: the whole
 * point of a case is to fail that way.
 */
/**
 * The remote was never reached.
 *
 * ssh answers 255 when it could not connect at all -- no route, no VPN, host
 * down, key refused. That is not the product failing; the case never ran.
 *
 * Live: a VPN dropped and the board recorded 24 case verdicts as RED over 103
 * minutes, each one an `exit_code=255`, while the run re-tried every thirty
 * seconds without an interrupt or a backoff. A red that the network wrote
 * goes into the ledger as evidence about the product, becomes the next wave's
 * lesson, and is indistinguishable afterwards from a real one.
 */
export function unreachableHostReason(command: string, output: string): string | undefined {
  if (!/\bexit_code=255\b/u.test(output)) return undefined;
  // 255 is also what a remote command returns when it exits 255 itself, so the
  // ssh envelope has to be what carries it: the harness writes `ssh target=…
  // state=… exit_code=…` around every remote run.
  if (!/\bssh target=/u.test(output)) return undefined;
  return `case is unrunnable: ssh could not reach the host at all (exit 255), so this case never ran `
    + `and this is not a verdict about the product. Its command is "${command.slice(0, 120)}". `
    + `Check the link to the host -- a VPN, a route, the box itself -- and let the case run again; `
    + `nothing in the workspace will change this outcome.`;
}

/**
 * The case ran into a shared resource that someone else was holding.
 *
 * A GPU on a shared box, a licence seat, a port: the case's own gate saw it
 * taken and stopped before doing anything. That says nothing about the
 * product, and recording it red puts another person's workload into the
 * ledger as a verdict about this one.
 *
 * The gate has to say so in two ways at once -- exit 75 (EX_TEMPFAIL, "try
 * again later") and a `resource busy:` line naming what was taken -- so that
 * neither an ordinary failure that happens to exit 75 nor a log line that
 * happens to mention a busy resource is read as one.
 */
export function resourceBusyReason(command: string, output: string, exitCode?: number): string | undefined {
  const tempfail = exitCode === 75 || /\bexit_code=75\b/u.test(output);
  if (!tempfail) return undefined;
  const named = /^resource busy:\s*(.+)$/mu.exec(output)?.[1]?.trim();
  if (!named) return undefined;
  return `case is unrunnable: a shared resource was busy (${named.slice(0, 160)}), so this case never ran `
    + `and this is not a verdict about the product. Its command is "${command.slice(0, 120)}". `
    + `Nothing in the workspace will change this outcome; let the case run again once the resource is free.`;
}

export function unrunnableCaseReason(command: string, output: string): string | undefined {
  if (!output.trim()) return undefined;
  // A test that ran and failed is exactly what a red case is for.
  if (/^\s*E\s+\w*(?:AssertionError|Error)|\d+ failed|\d+ passed/mu.test(output)
    && !/file or directory not found|ERROR collecting/iu.test(output)) {
    return undefined;
  }
  const paths = missingPaths(output);
  if (paths.length === 0) return undefined;
  const named = [...new Set(paths)].join(", ");
  return `case is unrunnable: the runner could not find ${named}, so this case does not exist to be failed. `
    + `Its command is "${command.slice(0, 120)}". Either restore that path, or change the case's command to the file that now holds this check — `
    + `a case pointing at a deleted file stays red forever and no amount of product work will move it.`;
}
