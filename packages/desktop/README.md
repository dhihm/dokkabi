# Dokkabi Desktop Control Surface (`@dokkabi/desktop`)

Native desktop control surface and Tailscale mobile companion gateway for
Dokkabi, powered by **Tauri v2 (Rust)** with a dependency-free web frontend.

## The console tab

The window's primary surface is the **agent console**: a live projection of
a session's EventLog in the shape of a chat transcript. Transcript cards
(notes, assistant markdown with collapsible thinking, tool cards with
duration and error state, approval lifecycle) arrive from
`transcript.snapshot` / `transcript.append`; the context rail carries the
recorded token usage (or `missing`), the approvals waiting, and the work
plan with RED/GREEN case verdicts from `plan.snapshot` — the same painting
the TUI WORK pane uses. The composer converses through the **embedded chat
kernel**: `chat.open` takes the session's interactive lease (a terminal
`dokkabi chat` on the same session is refused, in both directions) and
`chat.send` runs real model turns whose content reaches the window only as
EventLog surface events. When another process owns the session the composer
falls back to `note.submit`, staging notes into the operator inbox.
`model.candidates` feeds the two-stage `/model` completion (providers
first, then the provider's models — favorites first). The terminal grid
and the diff view remain as tabs.


## Security model (read this first)

- **Plaintext is loopback-only.** Non-loopback `--host` and
  `DOKKABI_DESKTOP_HOST` values are refused. Remote access requires an
  operator-managed HTTPS reverse proxy to loopback and
  `--public-origin https://your-gateway.example`. No proxy or certificate is
  provisioned automatically.
- **Every network method requires a bounded pairing credential.** Tokens have
  256 random bits and an eight-hour default lifetime. Pairing links use
  `/mobile#token=…`; the browser removes the fragment after reading it.
  WebSockets offer `dokkabi.rpc` and `dokkabi.auth.<encoded-token>` protocols;
  the HTTP pairing API uses Bearer authorization. Query-token authentication
  is refused. Browser origins are checked against configured origins, and
  expired sockets close. Old links/clients must be upgraded and re-paired.
  The Unix domain socket remains operator-local (mode `0600`).
- **The gateway never fabricates session EventLogs.** `session.create`
  registers intent in the gateway audit log; real session logs are
  hash-chained and belong to the harness (`dokkabi work --session <id>`).
  `session.delete` refuses a session whose run lock is held by a live pid.
- **Every gateway action is an observe event.** Terminal spawns/kills/exits,
  session operations, approval decisions, auth rejections, and the boot row
  land in a hash-chained EventLog at `~/.dokkabi/run/desktop-gateway.jsonl`.
  Rejections are aggregated and storage-bounded; saturation retains pending
  counts in memory and warns the operator without deleting chained records.
  Commands are recorded redacted; environment values never enter the log
  (keys only).

## Capabilities

1. **Multi-session catalog**: live discovery from the sessions root with
   turn/event counts and goals; intent registration; live-safe deletion.
2. **Terminal grid**: independent terminals with pty allocation (util-linux
   `script` wrapper — TUI agents like `claude`/`codex` render; without
   `script` the spawn honestly reports `pty: false`). `terminal.split`
   creates an additional pane-linked terminal; pane geometry is the client's
   layout. Resize is recorded intent — `TIOCSWINSZ` plumbing is future work.
3. **Universal agent hub**: dokkabi / claude-code / codex / shell profiles
   with availability probing; spawn args are the operator's own command,
   recorded redacted in the audit log.
4. **Git diff inspection**: `diff.get` reuses the host's git view (read-only).
5. **Approvals are real**: `approval.list` surfaces requests parked by the
   harness approval relay (`~/.dokkabi/sessions/<id>/approvals/*.json`);
   `approval.respond` writes the relay decision — the waiting agent unblocks
   on its next poll tick. "modify" is refused: the relay supports
   allow-once/deny only. The mobile card shows kind, summary, and target.
6. **Telemetry is honest**: `speculative.metrics` reports `enabled: false`
   until a speculative-prefetch source exists in the harness (#128 is a
   design, not a shipped source). There is no client-fed metric write path.
7. **Tailscale mobile companion**: tailscale IP/MagicDNS detection, QR pairing
   URL (`https://<configured-origin>/mobile#token=…` for remote access), responsive one-page app with
   approvals, session status, git card, and a live terminal viewer. All field
   interpolation is HTML-escaped; approval cards are built with DOM APIs.

## Known limitations

- The Tauri shell (`send_rpc`) is one-shot request/response over the Unix
  socket; notification streams (terminal output, approval pushes) reach the
  web/mobile UI over the authenticated WebSocket, not the Tauri IPC. A
  persistent subscription in Rust needs a CI with a Rust toolchain. The
  client uses blocking std sockets on `spawn_blocking` — a tokio
  `UnixStream` read deadlocked inside the Tauri command context on macOS 26.
- Unix-socket replies are newline-terminated and written through a drain
  queue: `socket.write()` short-writes past ~8KB and Bun does not retry the
  tail, so the client must never wait for bytes the server already dropped.
- No `TIOCSWINSZ`: terminal size changes do not propagate to the pty yet.
- macOS 26 (Tahoe): tauri 2.11.5 pins tao 0.35.x, whose window creation is
  flaky on Tahoe (upstream tauri-apps/tauri#15517 — a fix needs tao ≥0.37,
  not yet adopted by any tauri release). The window can appear late; if it
  does not, relaunch the binary.
- `dokkabi` profile rows in `session.list` come from the session index; the
  catalog does not yet attribute sessions to external agent profiles.

## Run

```sh
dokkabi desktop                       # localhost gateway + unix socket
dokkabi desktop --host 100.x.y.z     # bind to the tailnet (operator choice)
bun run build                         # frontend bundle (packages/desktop)
cargo build                           # Tauri shell (from packages/desktop/src-tauri)
```

## Verification

- `cargo test` in `packages/desktop/gateway-rs` — the Unix-socket JSON-RPC
  round trip (result passthrough, remote-error surfacing, missing-socket
  message, silent-close) — runs and passes on any machine with a Rust
  toolchain, independent of GUI system libraries.
- The Tauri shell (`src-tauri`) compiles where its system libraries exist
  (verified on the author's macOS). Oracle/RHEL 9 currently cannot build it:
  no `webkit2gtk-4.1` packages and `glib 2.68 < 2.70` — `cargo check` fails in
  the `glib-sys`/`webkit` sys crates before reaching this crate's code. The
  shell is kept minimal (60 lines delegating to `gateway-rs`) so its
  untested-here surface stays tiny.

Tests: `bun test tests/desktop-server.test.ts tests/desktop-server-fix.test.ts
tests/desktop-console-gateway.test.ts tests/desktop-transcript.test.ts
tests/desktop-console-render.test.ts tests/desktop-server-chat.test.ts`.
