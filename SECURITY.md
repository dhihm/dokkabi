# Security

Please report vulnerabilities privately via GitHub security advisories on this repository. Do not file a public issue that includes a working exploit.

Dokkabi 0.x stores session logs and uses Pi credentials in `~/.pi/agent/auth.json`. Those files never belong in git. The operator dashboard listens on 127.0.0.1 only. Writable coding children have network by default; read-only sessions and `DOKKABI_SANDBOX_NET=deny` retain the network fence.
