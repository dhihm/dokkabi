// bun-types made Server generic over its websocket payload; this server
// serves plain HTTP and upgrades nothing, so there is no payload.
import type { Server } from "bun";
type DashServer = Server<undefined>;
import { SharedDashSnapshot } from "./shared-snapshot.ts";
import { renderDashHtml, renderDashText } from "./render.ts";
import { webState } from "./web-state.ts";
import { dashPage } from "./web-page.ts";

/** How often the stream re-reads the log. Fast enough to feel live, slow
 * enough that a board left open beside a fortnight-long run costs nothing. */
// Frames carry only what is new, so a tick costs the header and nothing else.
// At one second the board arrived in visible one-second steps; four times a
// second it reads as a live view, and an idle tick is now cheap enough to
// afford that.
const STREAM_INTERVAL_MS = 250;

export function listenDash(input: {
  path: string;
  replay: boolean;
  port?: number;
}): { server: DashServer; url: string } {
  const port = input.port ?? Number(process.env.DOKKABI_DASH_PORT ?? 4173);
  // This legacy read-only mirror has no authentication. Remote access belongs
  // to the authenticated gateway, never an ambient bind-address override.
  const requestedHost = process.env.DOKKABI_DASH_HOST ?? "127.0.0.1";
  const hostname = requestedHost === "localhost" ? "127.0.0.1" : requestedHost;
  const ipv4 = hostname.split(".");
  const loopback = hostname === "::1" || (ipv4.length === 4 && ipv4[0] === "127" &&
    ipv4.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255));
  if (!loopback) throw new Error("unauthenticated dashboard requires a literal loopback address");
  const snapshot = new SharedDashSnapshot(input.path);
  let subscribers = 0;
  let server: DashServer;
  try {
    server = Bun.serve({
      hostname,
      port,
      fetch(request) {
        const url = new URL(request.url);
        const read = () => snapshot.read();

        if (url.pathname === "/raw") {
          return new Response(renderDashText(read(), { path: input.path, replay: input.replay }), {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        // The old page, still reachable for anything that scrapes it.
        if (url.pathname === "/legacy") {
          return new Response(
            renderDashHtml(read(), {
              path: input.path,
              replay: input.replay,
              theme: process.env.DOKKABI_THEME,
            }),
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        if (url.pathname === "/api/state") {
          return Response.json(webState(read()));
        }
        if (url.pathname === "/api/stream") {
          if (subscribers >= 8) return new Response("dashboard stream limit reached", { status: 429 });
          subscribers++;
          let timer: ReturnType<typeof setInterval> | undefined;
          let lifetime: ReturnType<typeof setTimeout> | undefined;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            subscribers--;
            request.signal.removeEventListener("abort", release);
            if (timer !== undefined) clearInterval(timer);
            if (lifetime !== undefined) clearTimeout(lifetime);
          };
          request.signal.addEventListener("abort", release, { once: true });
          // Server-sent events rather than a meta refresh. The page keeps its
          // scroll, a growing reply is read as it grows, and nothing flickers.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              let lastSeq = -1;
              // The tail already sent on THIS connection. Turns carry the whole
              // reply and the whole thinking, so a full frame ran to ~100KB and
              // went out every second whether or not anything had happened.
              // Parsing that on the browser's main thread once a second is what
              // made a mouse drag stutter. The page keys both panels by seq and
              // appends what it has not seen, so sending only what is new needs
              // nothing from it; a reconnect starts the tail over.
              let sentTurn = -1;
              let sentEvent = -1;
              // The board is separate panels, so a frame carries the panels
              // that moved and no others. The work panel alone ran to 10KB and
              // went out four times a second to say the goal had not changed.
              const sent = new Map<string, string>();
              const ifChanged = <T>(key: string, value: T): Record<string, T> => {
                const mark = JSON.stringify(value ?? null);
                if (sent.get(key) === mark) return {};
                sent.set(key, mark);
                return { [key]: value } as Record<string, T>;
              };
              const push = () => {
                if (released) return;
                if ((controller.desiredSize ?? 0) <= 0) { release(); controller.close(); return; }
                try {
                  const state = webState(read());
                  // Silence is information too: an unchanged log still ages,
                  // so the age and the activity line have to keep arriving.
                  // These are the frame's floor -- a few hundred bytes, and the
                  // anchor the page's own clock counts from.
                  lastSeq = state.lastSeq;
                  const turns = state.turns.filter((turn) => turn.seq > sentTurn);
                  const events = state.events.filter((event) => event.seq > sentEvent);
                  sentTurn = state.turns.at(-1)?.seq ?? sentTurn;
                  sentEvent = state.events.at(-1)?.seq ?? sentEvent;
                  const frame = {
                    lastSeq: state.lastSeq,
                    generatedAt: state.generatedAt,
                    activity: state.activity,
                    activityKind: state.activityKind,
                    lastEventAgeMs: state.lastEventAgeMs,
                    ...(turns.length > 0 ? { turns } : {}),
                    ...(events.length > 0 ? { events } : {}),
                    ...ifChanged("session", state.session),
                    ...ifChanged("agent", state.agent),
                    ...ifChanged("error", state.error),
                    ...ifChanged("alerts", state.alerts),
                    ...ifChanged("model", state.model),
                    ...ifChanged("work", state.work),
                    ...ifChanged("host", state.host),
                    ...ifChanged("tools", state.tools),
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
                } catch {
                  release();
                  controller.error(new Error("dashboard log unavailable or refused"));
                  void lastSeq;
                }
              };
              push();
              if (!released) {
                timer = setInterval(push, STREAM_INTERVAL_MS);
                timer.unref();
                // EventSource reconnects. Bound capacity even when a platform
                // does not promptly report a disconnected response reader.
                lifetime = setTimeout(() => { release(); controller.close(); }, 60000);
                lifetime.unref();
              }
            },
            cancel() {
              release();
            },
          });
          return new Response(body, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }
        return new Response(dashPage(sessionNameOf(input.path)), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
  } catch {
    // Port taken by another board (a stale dash from an earlier code
    // generation). The TUI is the operator surface; the HTTP mirror is
    // optional. Serve on an ephemeral port instead of dying with EADDRINUSE
    // and leaving the operator with a dead terminal.
    server = Bun.serve({
      hostname,
      port: 0,
      fetch: () => new Response("primary board port busy", { status: 503 }),
    });
  }
  return { server, url: `http://${hostname}:${server.port}` };
}

/** The session a log path belongs to, for the page title and header. */
function sessionNameOf(path: string): string {
  const parts = path.split("/");
  return parts.at(-2) ?? parts.at(-1) ?? "session";
}
