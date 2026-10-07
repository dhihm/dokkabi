import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { refusedOutcome, type RunnerOutcome, type RunnerResultAdapter } from "./contract.ts";

const source = readFileSync(new URL("./pytest-report.py", import.meta.url), "utf8");
const begin = "[dokkabi pytest-report-v1 begin]";
const end = "[dokkabi pytest-report-v1 end]";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const strings = z.array(z.string().min(1));
const reportSchema = z.object({
  schema: z.literal("pytest-report-v1"), framework_version: z.string().min(1),
  selected: strings, started: strings, finished: strings,
  reports: z.array(z.object({ id: z.string().min(1), phase: z.enum(["setup", "call", "teardown"]),
    outcome: z.enum(["passed", "failed", "skipped"]), diagnostic: z.string(),
    exception: z.object({ type: z.string().min(1), assertion: z.boolean() }).strict().nullable(),
  }).strict()),
  collection_errors: z.array(z.object({ id: z.string(), diagnostic: z.string() }).strict()),
  interrupted: z.boolean(), internal_error: z.boolean(), session_finished: z.boolean(),
  exit_code: z.number().int().nullable(), stopped: z.boolean(),
}).strict();

/** Complete, typed framework reports supply verdicts. Arbitrary terminal
 * prose and counts are not parsed into tests or compared to model prose. */
export function readPytestOutcome(body: string, exitCode: number): RunnerOutcome {
  const missing = (reason: string) => refusedOutcome("incomplete", reason);
  const lines = body.split(/\r?\n/u);
  const starts = lines.flatMap((line, i) => line === begin ? [i] : []);
  const ends = lines.flatMap((line, i) => line === end ? [i] : []);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] !== starts[0]! + 2) {
    return exitCode === 126 || exitCode === 127
      ? refusedOutcome("execution_unavailable", "registered test executable is unavailable")
      : missing("native pytest report is missing, duplicated or incomplete");
  }
  let raw: unknown;
  try { raw = JSON.parse(lines[starts[0]! + 1]!); } catch { return missing("native pytest report is not JSON"); }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return missing("native pytest report contract is invalid");
  const report = parsed.data;
  if (!report.session_finished || report.exit_code !== exitCode) return missing("native pytest session did not finish with the process exit");
  if (report.collection_errors.length) return refusedOutcome("collection_setup_error", "pytest collection failed");
  if (report.interrupted || exitCode === 2) return refusedOutcome("cancelled", "pytest execution was interrupted");
  if (report.internal_error || exitCode === 3 || exitCode === 4) return refusedOutcome("execution_unavailable", "pytest execution or configuration failed");
  if (exitCode !== 0 && exitCode !== 1 && exitCode !== 5) return missing("pytest returned an unsupported exit status");
  const unique = (items: string[]) => new Set(items).size === items.length;
  if (![report.selected, report.started, report.finished].every(unique)
    || report.started.length !== report.finished.length
    || report.started.some((id, index) => id !== report.finished[index] || !report.selected.includes(id))) {
    return missing("pytest test lifecycle is incomplete or inconsistent");
  }
  if (report.started.length !== report.selected.length && !(report.stopped && exitCode === 1)) {
    return missing("pytest did not execute its selected tests");
  }
  if (report.reports.some(row => !report.started.includes(row.id))) return missing("pytest report has no started test");
  let passed = 0, assertions = 0, exceptions = 0;
  for (const id of report.started) {
    const phases = report.reports.filter(row => row.id === id);
    if (phases.some(row => row.phase !== "call" && row.outcome === "failed")) {
      return refusedOutcome("collection_setup_error", "pytest test setup or teardown failed");
    }
    const setup = phases[0], call = phases[1], teardown = phases.at(-1);
    if (setup?.phase !== "setup" || teardown?.phase !== "teardown" || teardown.outcome !== "passed"
      || (setup.outcome === "skipped" ? phases.length !== 2
        : setup.outcome !== "passed" || phases.length !== 3 || call?.phase !== "call")) {
      return missing("pytest report phases are incomplete or inconsistent");
    }
    if (setup.outcome === "skipped" || call?.outcome === "skipped") continue;
    if (call?.outcome === "passed") { passed++; continue; }
    if (call?.outcome !== "failed" || !call.diagnostic) return missing("pytest failure has no native diagnostic");
    // Native framework failures such as strict XPASS have no Python exception.
    // The completed failed call report still carries pytest's assertion verdict.
    if (!call.exception || call.exception.assertion) assertions++; else exceptions++;
  }
  const failures = assertions + exceptions;
  if ((exitCode === 1) !== (failures > 0) || exitCode === 5 && report.started.length > 0) {
    return missing("pytest exit status contradicts its test reports");
  }
  if (!failures && !passed) return missing("pytest executed no passing or failing test calls");
  return { kind: exceptions ? "product_exception" : assertions ? "assertion_failure" : "passed",
    reason: failures ? "native pytest test call failed" : "native pytest test calls passed",
    tests: report.started.length, qualifying_red: failures > 0, green: failures === 0,
    framework_version: report.framework_version };
}

function pytestCommand(original: string): string {
    // The registry accepts simple leading assignments. Keep their exact bytes
    // before the shell function so it observes the declared environment first.
    const assignments = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*/u.exec(original)![0];
    const invocation = `${assignments}dokkabi_case_report_exec ${original.slice(assignments.length)}`;
    // Keep the original shell invocation, including interpreter, assignments,
    // quoting and selectors. The subprocess uses its own installed pytest.
    return `(\ndokkabi_case_report_dir=$(mktemp -d "\${TMPDIR:-/tmp}/dokkabi-report.XXXXXXXX") || exit 125
trap 'rm -rf "$dokkabi_case_report_dir"' EXIT
printf '%s' ${quote(source)} > "$dokkabi_case_report_dir/dokkabi_pytest_report_v1.py" || exit 125
dokkabi_case_report_exec() {
  export DOKKABI_PYTEST_SAVED_PYTHONPATH_SET="\${PYTHONPATH+x}" DOKKABI_PYTEST_SAVED_PYTHONPATH="\${PYTHONPATH-}"
  export DOKKABI_PYTEST_SAVED_PYTEST_PLUGINS_SET="\${PYTEST_PLUGINS+x}" DOKKABI_PYTEST_SAVED_PYTEST_PLUGINS="\${PYTEST_PLUGINS-}"
  export PYTHONPATH="$dokkabi_case_report_dir\${PYTHONPATH:+:$PYTHONPATH}" PYTEST_PLUGINS="dokkabi_pytest_report_v1\${PYTEST_PLUGINS:+,$PYTEST_PLUGINS}" DOKKABI_PYTEST_REPORT="$dokkabi_case_report_dir/result.json"
  "$@"
}
${invocation}
dokkabi_case_exit=$?
printf '\\n%s\\n' ${quote(begin)}
cat "$dokkabi_case_report_dir/result.json" 2>/dev/null
printf '\\n%s\\n' ${quote(end)}
exit "$dokkabi_case_exit"
)`;
}

export const pytestResultAdapter: RunnerResultAdapter = Object.freeze({
  id: "pytest-report-v1",
  digest: createHash("sha256").update(source).update(String(pytestCommand)).update(String(readPytestOutcome)).digest("hex"),
  command: pytestCommand,
  read: readPytestOutcome,
});
