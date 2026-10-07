/**
 * A wait should end when the thing it watches ends.
 *
 * A phase's job printed its last line and exited. The wait watching it had a
 * probe returning the log tail and a pattern that never appeared in it, so it
 * polled a finished job for minutes — thirty-five identical probes while no
 * process remained on the host and the accelerator sat idle. A timeout can
 * bound that waste but cannot remove it, because nothing in the wait knew what
 * it was watching.
 *
 * The watched case runner has never had this problem: its poll reports
 * liveness beside the output, so a run that closes without a conclusive line
 * still gets a verdict instead of being waited out. A hand-launched job gets
 * the same instrument here. Name the pid, and every probe carries whether that
 * process is still there; a process that exits without the pattern is an
 * answer — usually the interesting one — rather than a reason to keep polling.
 */

const ALIVE = "__DOKKABI_ALIVE__";
const GONE = "__DOKKABI_GONE__";

/** Append a liveness report to the caller's probe, when it named a process. */
export function probeWithLiveness(probe: string, pid: number | undefined): string {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return probe;
  return `${probe}\nif kill -0 ${pid} 2>/dev/null; then echo ${ALIVE}; else echo ${GONE}; fi`;
}

/**
 * Split the verdict off a probe's output. Only a marker at the very end is the
 * report — one that appears mid-output belongs to the watched job's own log.
 * An absent marker means the wait was never told what to watch.
 */
export function splitLiveness(stdout: string): { output: string; alive: boolean | undefined } {
  const trailing = new RegExp(`(?:${ALIVE}|${GONE})\\s*$`, "u");
  const match = trailing.exec(stdout);
  if (!match) return { output: stdout.trimEnd(), alive: undefined };
  return {
    output: stdout.slice(0, match.index).trimEnd(),
    alive: match[0].trimEnd() === ALIVE,
  };
}
