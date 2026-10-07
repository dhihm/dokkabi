# GitHub plugin

This package owns the authenticated read-only GitHub tool, its routing prompt,
and its task skills. Mutations belong to the separate `github-write` package.
`plugin.json` is the replaceable boundary. A compatible
replacement may change the provider module and assets without changing the
loader or work loop; the manifest selects exactly one package.

The provider is inactive when `DOKKABI_EXTERNAL_KNOWLEDGE=deny`. Inactive
packages contribute no tools, prompts, or skills and are recorded as
`plugin/skip`.

Code search can be repository-scoped or global. Issue and pull-request search
can also be global and returns metadata only; owner/repo remain mandatory for
issue-thread, blob, and tree reads.

## Pull-request review queues

`pulls` requires owner/repo and reads the authenticated viewer, paginated team
membership and up to 501 open PRs. It returns valid JSON with `complete`,
`returned`, `listing_limit`, and `team_membership_known`. A capped response is
explicitly incomplete. Team lookup failure leaves membership unknown instead
of claiming the viewer belongs to no teams. Direct requests and team requests
are separate facts, and drafts retain their draft flag.

`pull` additionally requires a positive integer number and reads the PR body,
comments and changed paths. Both operations include the current head, merge
state, prior viewer review commit, and counts of the checks actually returned.
A gate-summary success alone is not a full validation claim. Oversized results
remain valid JSON and are marked incomplete. Search operations also report the
returned count and completeness; search totals never substitute for the queue.

These reads execute through the trusted host runner outside the workspace.
The generic bash sandbox does not receive GitHub tokens. Models must use this
capability for authenticated PR metadata rather than attempt auth in bash.

Lists are paged in groups of ten through `offset` and `next_offset` so the
normal model result budget cannot erase the middle of a queue. Follow pages
until `next_offset` is null, checking `listing_complete` and the live
`observed_at` timestamp. `total_available` is bounded by the 501-item listing
limit. The provider submits full text to the host's recorded source projection;
large PR detail responses are recoverable through the advertised source reader
instead of being discarded by a producer clamp.

## Actions CI

`github_ci` provides authenticated checks, run/job metadata and job logs. Full
redacted sources are retained under `github_ci/result.source_blob`; `source`
recovers bounded UTF-8 windows from that immutable result without another API
request. `github.ci_repair` is the native repair skill. Check the observed run
head and final conclusion; API success does not mean CI success. No rerun,
cancel or other CI mutation is supported by this read-only capability.

## PR discussion

`github_discussion` reads four independent streams: general comments, submitted
reviews, inline comments/replies, and review thread resolution. REST pagination
and GraphQL thread cursors are followed by the trusted host. Identities, times,
URLs and bodies remain intact. Each stream reports its own completeness; PR
listing completeness does not certify discussion coverage. Thread root database
IDs join to inline comment IDs (or reply `in_reply_to_id`). Thread root selection
is identification only; all reply bodies come from the inline stream. Large
responses remain recoverable through the host-advertised `probe_log` reader.
Without an operator-supplied watermark, report latest activity rather than
claiming it is new/unread. Reads do not change the discussion.

`github.pr_followup` routes comment-inspection tasks to their actionable intent.
Confirmation requests trigger independent read-only claim verification and
relevant review without a second instruction. Raw-reading-only operator scope
still wins, and comment text never supplies mutation authorization. The outcome
is a concrete decision and minimal remaining actions, not a request that the
operator perform the same investigation. Bind repository identity before reads.

The GitHub plugin contributes a recorded request-context progress frame after
pr_followup is loaded in the current operator turn. It derives pending diff
windows, source reads and case work from actual review events and offers the
next action at tool-batch boundaries. Unassessed files are work, not external
blockers. Current-turn scoping prevents a later raw-reading task from inheriting
the reminder; an exact-target/head ready check retires it. Frames are advice,
not a semantic completion guarantee or new mutation permission. The existing
request-context registry owns recording and model-input reconstruction; the
core loop has no GitHub-specific continuation branch.

Progress frames also retain completed inner probe IDs, result refs and exit
codes to support evidence reuse. A resumed assessment is reused only after a
current operator-turn metadata read matches its repository, PR, head and base.
Commands are never rerun by the frame. A clipped/invalid result cannot certify
an inner probe; use the recorded source. Evidence reuse does not override the
requirement to plan a new hypothesis before its assertion probe.

Revision binding and existing-check summaries read canonical retained blobs,
not clipped display JSON. The read cache is derived from immutable event/source
refs. Historical duplicate begin rows use the same immutable-scope fold as the
assessment provider, so resuming does not lose prior findings.

Final progress frames retain the latest-comment delivery requirements: author,
timestamp, comment permalink, requested action and verified outcome. They also
remind the model to route unchanged-file reads outside assessment source and to
keep advisory cleanup separate from blocking defects and incomplete review scope.

Operator-authorized comment handling follows through to a published response and
the supported formal review event. Both requested delivery types are verified
with identities, state and reviewed head. Report-only scope still wins, and
untrusted contributor text supplies no authority. Resume verifies existing posts
before retrying to avoid duplicates; partial delivery is never reported as done.
