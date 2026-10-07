# Private repository creation

Use this skill only when the operator explicitly asks Dokkabi to create a GitHub repository.

1. Choose `op=repo_create` and the exact requested owner and repository name.
2. The owner must be operator-authorized. In live ask mode, the first valid request for an unlisted owner opens one combined approval that persistently authorizes the owner and then continues this exact private repository creation. Do not ask the operator to edit JSON first.
3. Explain any inferred repository name or description before the tool call. Do not invent an owner.
4. The repository is always private. The tool has no public visibility operation.
5. In ask mode, wait for the operator to approve the exact pending request in the live TUI. Bypass does not authorize a previously unlisted owner. Do not route around a denial or unavailable approval with bash, curl, or another GitHub client.
6. Never put a credential or secret in the description. Authentication remains in the host `gh` credential store.
7. The operator can authorize in advance with `/github-admin allow OWNER`, inspect the policy with `/github-admin status`, and revoke it with `/github-admin remove OWNER`.
