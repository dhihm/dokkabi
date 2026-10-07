# CI failure repair

This is Dokkabi's native skill. Load it when the operator asks to diagnose or fix
GitHub Actions CI. An explicit repair request authorizes a scoped implementation,
commit and push to the existing PR branch; do not ask again. Diagnosis alone does
not authorize changes. Do not post comments, submit reviews or create another PR
unless requested. Non-Actions providers are reported by URL, not guessed at.

1. Read github pull metadata and github_ci checks. Record the exact PR head,
   branch, run/job IDs and conclusions. A successful read is not a passing job.
2. Use github_ci run and jobs, then job_log. Inspect the failed step; recover
   every needed omitted interval with source_ref/next_offset, without refetching
   the producer. Preserve the original full log. Wrong/stale head runs do not
   establish current-head failure. Check existing fixes and PR intent first.
3. Read-only CI diagnosis and artifact preparation do not require an implementation
   work graph. Require planning/RED only when making source changes; do not stop
   log/resource investigation because graph tools are absent.
   Read repository AGENTS and relevant build/test/writing instructions. Work in
   an isolated checkout of the existing PR branch. Before implementation record
   a goal, classified TODO, scenario and meaningful RED reproducer. Do not spawn
   a nested Dokkabi to satisfy planning. Use structured graph/work tools available
   in this session; keep test artifacts separate from delivered source.
4. Disk/network/package-server failures do not by themselves justify code changes.
   Investigate resource/dependency evidence first and prefer one failed-job retry
   when a transient runner failure is plausible. Do not weaken gates or change
   dependencies merely to make a red badge disappear. A workflow/dependency repair
   requires evidence of a repeatable/configuration-driven failure.
   Separate product defects from runner/dependency/workflow failures. Derive the
   smallest repair from actual logs and imports. Do not weaken a failing gate,
   skip tests, replace errors with unconditional success, or alter unrelated
   behavior. A schema-only gate should not implicitly bootstrap an inference
   GPU stack; inspect requirements and the real schema/test import paths.
5. Match CI's Python/platform and dependency source. Run meaningful focused
   reproduction and GREEN, required lint/gates and the actual gate commands.
   A mocked schema or fake runtime does not verify production imports. Record
   unverified host/platform scope explicitly in private evidence.
6. Review the diff, stage only intended files, commit conventionally and push the
   existing branch using structured git. Verify remote SHA equals the commit.
   Re-read github_ci checks for that new head and preserve run URLs. Wait for the
   affected check's final conclusion before claiming CI fixed; do not equate a
   local test pass, pushed SHA, advisory green summary or pending CI with success.
7. Write an artifact with original failure, root cause, exact change, executed
   validation and current delivery/CI state. No assistant commit attribution.

Before finishing, audit your actual calls/results and artifacts. Correct stale
SHA references, unsupported claims, hidden batch failures, discarded truncation,
repeated reads/tests and incomplete delivery. Reuse already-passing evidence.
If the tool capability is missing, report it instead of repeatedly trying shell
gh or inventing results. Supervisor permission for a repair remains in force.
