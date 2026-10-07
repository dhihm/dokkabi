# Commit and push through Git

1. Read the operator's requested action and repository instructions. Use
   `git status`, `git diff` and `git diff(staged=true)` to inspect the current
   workspace and distinguish existing user changes from the requested work.
2. If a new local branch was requested, use `branch_create(name=...)`; it
   creates and switches without resetting the worktree. `branch_switch` lets
   Git refuse a switch that would overwrite local changes.
3. Run the required project checks through workspace execution. The Git tool
   disables hooks and does not replace lint, tests or repository validation.
4. Use `stage(paths=[...])` for explicit files, including deletions. Directories,
   metadata paths, pathspec patterns and external paths are refused. Review
   `diff(staged=true)` and preserve unrelated pre-existing staged changes.
5. Use `commit(paths=[...], message=...)` with exactly the intended staged
   paths. An extra staged path refuses the commit; never unstage user work just
   to make the call pass. Follow repository commit conventions and do not add
   assistant attribution. The result includes the resulting commit SHA.
6. If push was authorized, use `push` on this same Git tool. Existing host
   GitHub authentication and authorization run internally. Full authority
   (`bypass`) can push public or private GitHub origins on any checked-out branch,
   including a new remote branch, without enrollment or a popup. Other modes
   retain the enrolled private default-branch policy and approvals. Use normal
   Git integration for a divergent existing remote; never substitute credentialed
   bash or request force push.
7. Report the commit SHA, checks and verified remote SHA separately. If push
   refuses or needs local synchronization, report the reason and remaining work
   without claiming success. Finish with `status` so leftover changes are visible.

A successful push returns the full verified remote SHA. The sealed HTTPS push
does not refresh local origin tracking refs, so status may still show ahead.
That is not evidence of failed delivery; do not repeat push solely for that
status. Use the returned verified remote SHA as delivery evidence.
