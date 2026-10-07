# Current-branch pushing

Use this skill when the operator requests pushing existing workspace commits.

1. Use `git.push` for the packaged Git workflow or `github_admin op=repo_push`
   for existing administration clients. The host derives origin, branch and SHA;
   neither entry accepts a target, ref or credential.
2. Full authority (`bypass`) permits public/private GitHub origins, any checked-out
   branch and new remote branches without enrollment or popup. It has no 256-commit
   or clean-tracked-tree requirement; uncommitted files are never pushed. Other
   modes retain enrolled private default-branch push, the 256-commit bound, clean
   tracked tree and approval.
3. Existing remote history must be an ancestor of local HEAD. If absent locally,
   the host performs an authenticated tracking-ref fetch and reinspects. A remaining
   `remote_advanced_local_sync_required` means rebase onto the reported tracking
   branch, resolve conflicts and retry `repo_push`. Never substitute sandbox network Git.
4. Ordinary approval binds repository, branch, remote/local SHAs, commit count,
   range digest and excluded-untracked count. Full mode uses session authority
   without persisting policy. Every mode reinspects before dispatch; drift or a
   downgrade from bypass cancels the pending push.
5. The host records the effect before an authenticated HTTPS push of the exact
   SHA. Existing branches use normal non-rewriting push; new branches use an
   empty expected lease to prevent overwriting a racing ref. No tag, deletion,
   redirect, hook or token exposure is permitted. Remote SHA must match for success.
6. Ordinary push enrollment can be managed with `/github-admin allow-push-repo
   OWNER/REPO`, `/github-admin remove-push-repo OWNER/REPO` and `status`. A refusal or failed
   verification is unfinished delivery; report the reason, never success.
