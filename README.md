# Dokkabi

Dokkabi (돗가비) is a coding agent harness with a macOS desktop application.
The harness/CLI supports macOS and Linux. The desktop source is in [app/](app/);
it derives from [T3 Code](https://github.com/pingdotgg/t3code), with its MIT
license and attribution retained. **0.1.0 is the first unstable source release.**
Download the versioned source archive and SHA256SUMS from
[Releases](https://github.com/dhihm/dokkabi/releases/tag/v0.1.0).
The release includes both workspaces. Official app binaries are not available
in this release; build instructions and qualification limits are in [BUILD.md](BUILD.md).

Dokkabi connects recorded model input, executed actions, verification evidence
and visible progress. Work and Context graphs, retained Record details and
decision checkpoints help you inspect long work while keeping the main
conversation and composer available. Completion requires evidence from the
harness; a model's success statement or UI state alone does not earn acceptance.
Applicable failure observations can enter the next enabled model input.
These mechanisms do not guarantee correctness or establish benchmark superiority.

```sh
bun install --frozen-lockfile
bun run dokkabi --help
bun run dokkabi login
bun run dokkabi models
bun run dokkabi work "your task"
```

Codex GPT-6 Astra/GPT-6.1 Sol, Claude Opus 5.5/Sonnet 5.5 and Z.ai GLM 5.3/GLM
5.3 Flash are catalogued through the harness's Pi provider routes. The app shows
the authenticated catalog and selects an idle
session's model through a recorded handoff. Provider sign-in and entitlement are
required. Native Antigravity is a separate app ACP provider, with its own agent
execution and account discovery.

Use the CLI help for provider authentication, model selection and command syntax.
Do not commit credentials, sessions or local configuration. See [SECURITY.md](SECURITY.md).

For source builds and manual macOS installation, see [BUILD.md](BUILD.md).
Desktop artifacts are unsigned and unnotarized; only Apple Silicon has bounded
installed-app qualification so far. Automatic updates are disabled. Source
availability does not imply every inherited T3 provider, mobile/remote feature
or experimental Dokkabi plugin is a supported release feature.

MIT for Dokkabi and the T3-derived app, with separate dependency terms.
See [LICENSE](LICENSE), [app/LICENSE](app/LICENSE), [app/UPSTREAM.md](app/UPSTREAM.md)
and [app/licenses/](app/licenses/).

Bug reports and contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
