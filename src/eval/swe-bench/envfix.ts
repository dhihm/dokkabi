/**
 * Environment-repair orders. When a baseline cannot even collect (exit 4),
 * the harness does NOT abort and the operator does NOT hand-pin
 * dependencies: Dokkabi opens a one-node envfix work graph whose success
 * case is `pytest --collect-only` on the failing target. The model reads
 * the collection error, installs/repairs what the era needs (sandbox grants
 * network ONLY in this phase), and the case goes green only when the suite
 * collects. The bug-fix DAG follows as usual.
 */
export function buildEnvfixOrder(input: {
  instanceId: string;
  collectionError: string;
  python: string;
}): string {
  return [
    `SWE-bench env repair ${input.instanceId}.`,
    `The official suite cannot even collect, so no bug can be scored yet.`,
    `Collection error to fix: ${input.collectionError.slice(0, 2000)}`,
    ``,
    `You must express this as an executable work DAG with ONE todo:`,
    `1) todo-envfix — make the suite collect (ready first)`,
    ``,
    `Rules for todo-envfix — the environment is YOURS to shape:`,
    `- Goal state (the ONLY goal): the suite collects. Whatever gets you`,
    `  there — installs, era pins, rebuilding the venv on a different`,
    `  interpreter (python3.9 and python3.12 exist on this host; other`,
    `  versions may be installable if you need them), removing and`,
    `  recreating .venv, swapping build backends — is a legal move. The`,
    `  interpreter that cannot work is a wrong answer, not a constraint.`,
    `- Starting point: ${input.python} -m pip … (the venv the harness`,
    `  prepared). The network is available ONLY in this phase. Never`,
    `  --user, never the system python.`,
    `- Dependency/era problem, not the product bug: do NOT edit product`,
    `  source or tests. Diagnose what the collection error actually`,
    `  demands (era, ABI, missing module) and choose accordingly — a`,
    `  version-era mismatch usually means the interpreter era is wrong,`,
    `  not that you should keep fighting the current one.`,
    `- Success means collection works: the envfix case command in`,
    `  work/current.json must be the collect-only check scoped to the`,
    `  FAILING TEST FILE ITSELF (sklearn/.../test_*.py from the collection`,
    `  error), run under whatever python you settled on, exiting 0.`,
    `  Collecting conftest.py or __init__.py does NOT count — those are`,
    `  not test files and pass trivially. After the wave the harness`,
    `  re-collects the real FAIL_TO_PASS target; a self-checked lesser`,
    `  scope fails there and the wave restarts.`,
    `- The harness re-runs the official baseline after you finish; it`,
    `  must be red on the REAL bug. A repair that makes it green fails.`,
    `- The environment AS YOU LEAVE IT is what gets scored. Red-first`,
    `  applies to your check command, not to destroying artifacts: never`,
    `  end the session having deleted a built extension or package to`,
    `  "reproduce the original failure" — rebuild it before you stop.`,
    `Do not weaken or edit tests. The product bug fix comes AFTER the suite`,
    `collects — a separate order will follow.`,
  ].join("\n");
}
