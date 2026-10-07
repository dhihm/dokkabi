# GitHub issue maintenance

Use this skill only after the operator explicitly requests an issue/PR mutation.

1. Read the issue with `github` `op=issue` and confirm its current state.
2. Confirm the requested repository matches the current workspace origin. The
   host also requires it in the private `github.write_repositories` allowlist.
3. Use `github_write` `op=issue_comment` with a concise, non-secret body only
   when a comment was requested.
   Omit the canonical URL of the issue/PR receiving the comment. Link-first
   repository style applies to relevant references, not the current thread.
   Preserve source/discussion anchors and links to other issues or PRs.
   If the tool refuses a redundant self-link, remove it and retry.
4. Use `github_write` `op=issue_close` or `op=issue_reopen` only for the exact
   state transition requested by the operator.
5. Report completion only after the tool succeeds. A refusal means the external
   action is not complete; state the authorization or authentication blocker.

Comment JSON travels through stdin, never argv. The EventLog records a digest
and byte count, not the comment body, on the mutation effect.
For explicitly requested PR approval or request changes, use `op=pull_review`,
an explicit `event` and the full reviewed `commit_id`. A general comment with an
APPROVE verdict is not an approval review. The host verifies the current head
before submission and validates GitHub's returned review state and commit.
If both a general comment and a review are requested, perform both operations;
keep the review body short rather than copying the entire comment again.

For `pull_review`, body is optional only for APPROVE. REQUEST_CHANGES and COMMENT
require a non-empty body; `issue_comment` always requires one. Returned
publication metadata includes available id, html_url, state and commit_id in
both model-visible text and structured details. Retain these identities as the
delivery evidence; do not reread a whole thread merely to discover a posted URL.
A same-session duplicate returns the original recorded identity without reposting.

For review follow-up, load github.pr_review and read local repository writing
and review-format instructions before drafting either public body. Both the
general review comment and formal review body must use the repository skeleton.
Internal event/probe numbers are private audit evidence, not developer-accessible
citations. Remove internal refs and reviewer execution chatter before publication.

To correct a delivery, use issue_comment_edit or pull_review_edit with its
publication_id and replacement body. Only same-session verified target deliveries
can be edited; review state and reviewed commit cannot change through a body edit.
Correct existing posts rather than creating duplicate comments or review events.
