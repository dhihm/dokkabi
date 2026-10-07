# GitHub issue triage

Use this skill to understand an issue before proposing or implementing work.

For a standalone issue investigation or implementation-feasibility shortlist,
start `issue_audit op=begin` before evidence collection. Write the substantive
report, get actual result sequences with `op=sources`, and submit `op=check`
before finalizing. Correct rejected evidence/prose and re-audit in the same
turn without operator intervention. This explicit workflow does not activate
for merely reading an issue as context for a PR review or enumerating PRs.

Feasibility requires current code evidence, not only an issue's diagnosis.
Read the actual inputs and consumers: a workflow dispatch example is not the
CHAIN block consumed by a parser. Search known files with blob find_text to
close available gaps. Match current PR overlap to its actual changed files;
an issue reference or unrelated open PR cannot establish same-file collision.
Separate test maintenance from product implementation, and already-fixed
subtasks from unresolved scope. Do not inflate tasks or invent design blockers
to fill or empty the shortlist. Distinguish reported reproduction from a test
actually run. Before editing a local report, copy exact observed old text and
verify ranking, exclusions and final summary agree. Before the first
audit, reconcile all requested dimensions together: current state/activity and
assignees, remaining scope versus merged implementation, actual PR changed
files, actual producer/consumer source (not repeated illustrative values),
reported versus executed validation, concrete prerequisites and inspected scope.
For repeated literals, prefer locating the producer declaration/assignment
instead of a value in an options list; inspect next matches when necessary.

PR queue triage is read-only investigation. A requested local queue/report file
is an observation artifact, not product implementation; write it directly with
mounted file tools, without work/current.json, RED cases or a nested Dokkabi CLI.
For review candidates include both current direct/team requests and PRs previously
reviewed by the operator whose head has changed. A completed review can remove
the request while an author push still requires reassessment. Exclude self-authored
PRs, defer drafts, and separate unchanged-head author-waiting changes requests.

1. If the repository or number is unknown, use `github` `op=search_issues`
   globally and narrow with issue/PR qualifiers. The result is metadata only.
   Once known, read the issue and comments with `op=issue`, owner, repo, and
   number.
2. Extract the requested outcome, observed behavior, reproduction evidence, and
   constraints as separate facts. A comment is evidence of what was reported,
   not proof of the root cause.
3. When the issue names source or tests, use the source-navigation skill and
   inspect them at an explicit ref. Search before guessing paths.
4. State the smallest falsifiable gap between the issue's expected and observed
   behavior. Mark conclusions that combine multiple sources as inference.
5. This provider is read-only. An explicitly requested comment, close, or reopen
   uses the separate `github-write.issue_maintenance` skill and must produce a
   logged mutation effect before you claim it happened.

For a pull-request review queue, start with `github op=pulls` and owner/repo
instead of interpreting `review-requested:` search counts. The result includes
an authenticated viewer, team membership availability, bounded listing
completeness, and per-PR `triage` facts. Separate direct requests, matching team
requests, draft work, and prior reviews that reference an older head. Inspect
selected threads and changed paths with `op=pull` and number. These operations
use the trusted read domain; generic bash does not inherit GitHub credentials.

Follow every `pulls.next_offset` page before claiming an ALL-PR queue. Inspect
advertised retained sources when a detail result is projected. Use the response's
`observed_at` timestamp and never treat a partial page as an empty request list.

For PR comment confirmation or recent-activity tasks, load github.pr_followup
and complete the implied read-only verification/review. Quoting a confirmation
request and delegating the review back to the operator is not completion.

For old or stalled issues, use created_at/updated_at metadata and dated comment
evidence. Search is bounded: complete=false requires narrowing when claiming
full coverage. offset applies only to pulls, not searches. Separate last
GitHub update from actual engineering progress; inspect linked PR merge state
and concrete remaining work before labeling an issue stalled.

Finish readily available verification before reporting a stalled-work shortlist.
Search hits prove existence, not implementation or merge. Read the linked PR
or prerequisite issue when its live status changes the classification. Recover
omitted comment evidence through retained output before relying on last visible
comments. Report a concrete access blocker separately from unperformed reads;
do not delegate those available reads back to the operator.

Keep the shortlist faithful to the requested inactivity window: an old issue
with recent substantive engineering or research progress belongs in a separate
active/decision queue, not the stalled ranking. Older implementation evidence
is not recent activity; verified merged work instead calls for reconciling the
remaining issue scope. Separate completed subtasks from remaining work and
use `state` with `mergedAt`, never approval or successful checks, as merge
proof. An unchecked issue list alone does not prove implementation is absent.

When comments name an implementation branch but omit its PR, perform a bounded
repository PR search for that head or issue reference before leaving delivery
unverified. A zero-result search is limited evidence, not proof that code was
never implemented. A closed prerequisite with unfinished acceptance criteria
needs scope reconciliation; do not declare the prerequisite fully satisfied.

Before finalizing, reconcile the ranking with every exclusion and search-scope
sentence. A stalled candidate needs identifiable remaining work; stale OPEN
state after a matching implementation merged is an issue-cleanup candidate
unless evidence establishes unfinished scope. Age cannot undo completion
proof. Reject contradictory classifications within the report itself.
