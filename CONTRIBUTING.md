# Contributing

Report reproducible bugs and propose improvements through this repository's
[Issues](https://github.com/dhihm/dokkabi/issues). Include your operating system,
source revision, provider/model identifier, reproduction steps and expected
versus actual behavior. Remove API keys, authorization headers, account details,
private paths and conversation content from attached logs. Never attach a
credential file or your complete session database.

Report vulnerabilities through [private vulnerability reporting](https://github.com/dhihm/dokkabi/security/advisories/new),
as described in [SECURITY.md](SECURITY.md), rather than a public issue.

Public main contains reviewed source snapshots. Pull requests are welcome;
accepted changes are integrated into development and carried into a later
snapshot. Keep a change focused, explain the observed failure and include a
targeted reproduction or regression check. Do not add provider credentials,
machine-specific settings, generated build output or agent session logs.

The harness/CLI supports macOS and Linux; the desktop GUI supports macOS.
Read [BUILD.md](BUILD.md) for the separate Bun and pnpm workspaces. Run the
relevant checks for the component you change. Preserve the MIT licenses,
upstream attribution and third-party notices. A source build or synthetic
provider fixture does not prove account entitlement or live model behavior.

GitHub Actions and automatic updates are disabled. The 0.1.0 source preview
does not include an official binary release. Versioned releases will identify
their exact source snapshot, artifacts and checksums.
