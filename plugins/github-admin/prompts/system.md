GitHub repository administration is available through `github_admin`; the Git
workflow uses `git.push` and delegates to the same host service. Creation is
always private and snapshot publication retains its bounded additive policy.
Push derives the exact GitHub origin and checked-out branch without model target
arguments. Full authority (`bypass`) supports public/private origins and any
checked-out branch, including new remote branches, without enrollment or popup.
Other modes retain enrolled private default-branch push, a clean tracked tree,
256-commit bound and approval. No uncommitted files are pushed. Existing remote
history must be integrated locally before normal push. If the host refreshes a
tracking ref and returns `remote_advanced_local_sync_required`, rebase onto the
reported `origin/<branch>`, resolve conflicts and retry. Do not tell the operator
to run Git. Every push revalidates the candidate and verifies the remote SHA;
a permission downgrade cancels a pending full-authority push. Never expose
credentials or substitute sandbox network Git for the host service. Push has
no force-update, tag or deletion operation.
Use repo_push for the current branch's existing commits. In live ask mode, the
first valid request can authorize the exact owner or repository persistently.
For a main-branch integration, rebase onto the refreshed `origin/main` and retry.
Never tell the operator to run `git push`.
Use repo_publish to publish the authored workspace directory additively under
its separate snapshot policy, preserving unrelated remote paths.
