import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex, Readable } from "node:stream";
import { EventLog } from "../src/host/event-log.ts";
import { workspaceSessionId } from "../src/host/paths.ts";

const launcher = join(import.meta.dir, "../scripts/desktop-child.ts");
const roots: string[] = [];
const children: ChildProcess[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dk-child-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const runtimeDirectory = join(root, "runtime");
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  const pairingToken = randomBytes(32).toString("base64url");
  return { root, home, bootstrap: { schema: 1, workspace, runtimeDirectory, pairingToken } };
}

function launch(home: string, body?: string, readyPipe: boolean | number = true, isolatedKernel = false, preload?: string, ownerPipe = false) {
  const child = spawn(process.execPath, preload ? ["--preload", preload, launcher] : [launcher], {
    cwd: "/",
    env: {
      ...(isolatedKernel ? { PATH: process.env.PATH, HOME: home, DOKKABI_PI_AUTH: join(home, "absent-auth.json"), DOKKABI_ROUTE: "replay" } : process.env),
      DOKKABI_HOME: home, DOKKABI_DESKTOP_HOST: "0.0.0.0", DOKKABI_DESKTOP_PORT: "1",
    },
    stdio: readyPipe === true ? (ownerPipe ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"]) : typeof readyPipe === "number" ? ["pipe", "pipe", "pipe", readyPipe] : ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stdin!.on("error", () => {});
  let stdout = "";
  let stderr = "";
  let ready = "";
  child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  (child.stdio[3] as Readable | null)?.on("data", (chunk) => { ready += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  if (body !== undefined) child.stdin!.end(body);
  return { child, exited, output: () => ({ stdout, stderr, ready }) };
}

async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("child timeout")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function retainEvidence(name: string, content: string) {
  const directory = process.env.DOKKABI_DESKTOP_CHILD_TEST_EVIDENCE;
  if (!directory) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, name), content, { mode: 0o600 });
}

async function waitReady(run: ReturnType<typeof launch>) {
  return await within(new Promise<{ schema: number; httpUrl: string; workspace: string; runtime: { bunVersion: string; platform: string; arch: string } }>((resolve, reject) => {
    const stream = run.child.stdio[3] as Readable;
    const check = () => {
      const line = run.output().ready;
      if (line.includes("\n")) {
        cleanup();
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      }
    };
    const end = () => { cleanup(); reject(new Error("child exited before readiness")); };
    const cleanup = () => { stream.off("data", check); run.child.off("close", end); };
    stream.on("data", check);
    run.child.on("close", end);
    check();
  }));
}

async function rpc<T = { id: string }[]>(socketPath: string, method = "session.list", params: unknown = {}) {
  return await within(new Promise<{ result: T; error?: { message: string } }>((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("gateway closed before reply")));
    socket.on("data", (chunk) => {
      data += String(chunk);
      if (!data.includes("\n")) return;
      socket.destroy();
      try { resolve(JSON.parse(data.split("\n")[0]!)); } catch (error) { reject(error); }
    });
  }));
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await within(exit);
  }));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// BR-01 (host bridge): Given a private bootstrap and retained harness history,
// when a real child starts, then only fd3 conveys its loopback endpoint and
// native socket; invalid bootstraps refuse without echoing private input.
// Given two owned children, when A receives a signal, then A disposes its
// server while B and the retained session history remain available.
describe("bundled desktop harness child", () => {
  test("the dedicated launcher exists", () => {
    expect(existsSync(launcher)).toBe(true);
  });

  test("importing the entry for a payload probe has no startup effects", () => {
    const f = fixture();
    const run = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(launcher)}); console.log("entry imported");`], {
      cwd: "/",
      env: { HOME: f.home, DOKKABI_HOME: f.home },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    expect(run.status).toBe(0);
    expect(String(run.stdout)).toBe("entry imported\n");
    expect(String(run.stderr)).toBe("");
    expect(String(run.output[3] ?? "")).toBe("");
    expect(existsSync(join(f.home, "run"))).toBe(false);
  });

  test("real child readies once, preserves harness sessions, and disposes on SIGTERM", async () => {
    const f = fixture();
    const history = join(f.home, "sessions", "retained", "events.jsonl");
    EventLog.create(history).append({ kind: "observe", name: "test/retained", payload: {} });
    const before = readFileSync(history, "utf8");
    const run = launch(f.home, JSON.stringify(f.bootstrap));
    const ready = await waitReady(run);
    expect(ready).toEqual({
      schema: 1, httpUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), workspace: f.bootstrap.workspace,
      runtime: { bunVersion: Bun.version, platform: process.platform, arch: process.arch },
    });
    expect(Buffer.byteLength(run.output().ready)).toBeLessThanOrEqual(4096);
    const readyStream = run.child.stdio[3] as Readable;
    if (!readyStream.readableEnded) await within(new Promise<void>((resolve) => readyStream.once("end", resolve)));
    const socket = join(f.bootstrap.runtimeDirectory, "gateway.sock");
    expect(lstatSync(socket).isSocket()).toBe(true);
    expect((await rpc(socket)).result.map((row) => row.id)).toContain("retained");
    expect((await fetch(ready.httpUrl)).status).toBe(200);
    const audit = readFileSync(join(f.bootstrap.runtimeDirectory, "gateway.jsonl"), "utf8");
    expect(audit).toContain("desktop/started");
    expect(audit).not.toContain(f.bootstrap.pairingToken);
    run.child.kill("SIGTERM");
    expect(await within(run.exited)).toBe(0);
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(join(f.bootstrap.runtimeDirectory, ".desktop-child-owner"))).toBe(false);
    expect(readFileSync(history, "utf8")).toBe(before);
    expect(run.output().ready.split("\n").filter(Boolean)).toHaveLength(1);
    expect(Object.values(run.output()).join("")).not.toContain(f.bootstrap.pairingToken);
  });

  test("stopping A on SIGINT leaves B's actual gateway available", async () => {
    const a = fixture();
    const b = fixture();
    const runA = launch(a.home, JSON.stringify(a.bootstrap));
    const runB = launch(b.home, JSON.stringify(b.bootstrap));
    const [readyA, readyB] = await Promise.all([waitReady(runA), waitReady(runB)]);
    expect(readyA.httpUrl).not.toBe(readyB.httpUrl);
    runA.child.kill("SIGINT");
    expect(await within(runA.exited)).toBe(0);
    expect(existsSync(join(a.bootstrap.runtimeDirectory, "gateway.sock"))).toBe(false);
    expect(runB.child.exitCode).toBeNull();
    expect((await fetch(readyB.httpUrl)).status).toBe(200);
    expect(Array.isArray((await rpc(join(b.bootstrap.runtimeDirectory, "gateway.sock"))).result)).toBe(true);
    runB.child.kill("SIGTERM");
    expect(await within(runB.exited)).toBe(0);
  });

  test("real loopback admissions require the bootstrap credential and keep it out of records", async () => {
    const f = fixture();
    const run = launch(f.home, JSON.stringify(f.bootstrap));
    const ready = await waitReady(run);
    for (const url of ["/api/pairing", "/api/pairing?token=" + f.bootstrap.pairingToken, "/ws"]) {
      const denied = await fetch(ready.httpUrl + url);
      expect(denied.status).toBe(403);
      await denied.text();
    }
    const wrong = await fetch(ready.httpUrl + "/api/pairing", { headers: { authorization: "Bearer " + randomBytes(32).toString("base64url") } });
    expect(wrong.status).toBe(403);
    await wrong.text();
    const paired = await fetch(ready.httpUrl + "/api/pairing", { headers: { authorization: "Bearer " + f.bootstrap.pairingToken } });
    expect(paired.status).toBe(200);
    await paired.text();
    const ws = new WebSocket(ready.httpUrl.replace("http:", "ws:") + "/ws", ["dokkabi.rpc", "dokkabi.auth." + f.bootstrap.pairingToken]);
    await within(new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("authenticated WebSocket unavailable"));
    }));
    expect(ws.protocol).toBe("dokkabi.rpc");
    const result = within(new Promise<{ result: unknown }>((resolve, reject) => {
      ws.onmessage = (event) => { try { resolve(JSON.parse(String(event.data))); } catch (error) { reject(error); } };
      ws.onerror = () => reject(new Error("authenticated RPC failed"));
    }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list" }));
    expect(Array.isArray((await result).result)).toBe(true);
    ws.close();
    run.child.kill("SIGTERM");
    expect(await within(run.exited)).toBe(0);
    const audit = readFileSync(join(f.bootstrap.runtimeDirectory, "gateway.jsonl"), "utf8");
    expect(audit).toContain("desktop/auth_rejected");
    expect(audit).not.toContain(f.bootstrap.pairingToken);
    expect(Object.values(run.output()).join("")).not.toContain(f.bootstrap.pairingToken);
  });

  test("an unavailable fd3 exits promptly and disposes any partial server", async () => {
    const f = fixture();
    const run = launch(f.home, JSON.stringify(f.bootstrap), false);
    expect(await within(run.exited, 3000)).not.toBe(0);
    expect(run.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
    expect(existsSync(join(f.bootstrap.runtimeDirectory, "gateway.sock"))).toBe(false);
    expect(existsSync(join(f.bootstrap.runtimeDirectory, ".desktop-child-owner"))).toBe(false);
  });

  test("the persistent owner lock refuses a live rival and releases after actual SIGKILL", async () => {
    const f = fixture();
    const ledger = join(f.root, "ledger-owner");
    mkdirSync(ledger, { mode: 0o700 });
    const bootstrapA = { ...f.bootstrap, gatewayLedgerDirectory: ledger };
    const runA = launch(f.home, JSON.stringify(bootstrapA));
    const readyA = await waitReady(runA);
    const stable = join(ledger, "gateway.jsonl");
    const before = readFileSync(stable, "utf8");
    const runtimeB = join(f.root, "runtime-rival");
    mkdirSync(runtimeB, { mode: 0o700 });
    const bootstrapB = { ...bootstrapA, runtimeDirectory: runtimeB, pairingToken: randomBytes(32).toString("base64url") };
    const runB = launch(f.home, JSON.stringify(bootstrapB));
    expect(await within(runB.exited)).not.toBe(0);
    expect(runB.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
    expect(readFileSync(stable, "utf8")).toBe(before);
    expect((await fetch(readyA.httpUrl)).status).toBe(200);
    const pidA = runA.child.pid;
    if (pidA === undefined || pidA <= 0) throw new Error("ready child has no process identity");
    expect(Number(readFileSync(join(ledger, "run.lock"), "utf8").split("\n")[0])).toBe(pidA);
    runA.child.kill("SIGKILL");
    expect(await within(runA.exited)).toBeNull();
    expect(existsSync(join(ledger, "run.lock"))).toBe(true);
    const runC = launch(f.home, JSON.stringify({ ...bootstrapB, pairingToken: randomBytes(32).toString("base64url") }));
    await waitReady(runC);
    const pidC = runC.child.pid;
    if (pidC === undefined || pidC <= 0) throw new Error("ready child has no process identity");
    expect(Number(readFileSync(join(ledger, "run.lock"), "utf8").split("\n")[0])).toBe(pidC);
    expect(readFileSync(stable, "utf8").startsWith(before)).toBe(true);
    runC.child.kill("SIGTERM");
    expect(await within(runC.exited)).toBe(0);
    expect(existsSync(join(ledger, "run.lock"))).toBe(false);
    expect(lstatSync(stable).mode & 0o777).toBe(0o600);
    expect(readFileSync(stable, "utf8")).not.toContain(bootstrapA.pairingToken);
    expect(readFileSync(stable, "utf8")).not.toContain(bootstrapB.pairingToken);
  });

  for (const unsafe of ["corrupt chain", "log symlink", "log hardlink", "lock hardlink", "public directory", "aliased ancestor"] as const) {
    test(`a persistent ledger with ${unsafe} fails closed without changing caller data`, async () => {
      const f = fixture();
      let ledger = join(f.root, "ledger-invalid");
      mkdirSync(ledger, { mode: 0o700 });
      const protectedFile = join(f.root, "caller-private");
      writeFileSync(protectedFile, "caller-private-data", { mode: 0o600 });
      if (unsafe === "corrupt chain") writeFileSync(join(ledger, "gateway.jsonl"), "invalid retained chain\n", { mode: 0o600 });
      else if (unsafe === "log symlink") symlinkSync(protectedFile, join(ledger, "gateway.jsonl"));
      else if (unsafe === "log hardlink" || unsafe === "lock hardlink") linkSync(protectedFile, join(ledger, unsafe === "log hardlink" ? "gateway.jsonl" : "run.lock"));
      else if (unsafe === "public directory") chmodSync(ledger, 0o755);
      else {
        const alias = join(f.root, "aliased-parent");
        symlinkSync(f.root, alias);
        ledger = join(alias, "ledger-invalid");
      }
      const run = launch(f.home, JSON.stringify({ ...f.bootstrap, gatewayLedgerDirectory: ledger }));
      expect(await within(run.exited)).not.toBe(0);
      expect(run.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
      expect(readFileSync(protectedFile, "utf8")).toBe("caller-private-data");
      expect(existsSync(join(f.bootstrap.runtimeDirectory, "gateway.sock"))).toBe(false);
      if (unsafe === "corrupt chain") expect(readFileSync(join(ledger, "gateway.jsonl"), "utf8")).toBe("invalid retained chain\n");
    });
  }

  test("competing starts in the same runtime directory admit one owner", async () => {
    const f = fixture();
    const runs = [launch(f.home, JSON.stringify(f.bootstrap)), launch(f.home, JSON.stringify(f.bootstrap))];
    const winner = await within(Promise.any(runs.map(async (run, index) => ({ index, ready: await waitReady(run) }))));
    const refused = runs[1 - winner.index]!;
    expect(await within(refused.exited)).not.toBe(0);
    expect(refused.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
    expect((await fetch(winner.ready.httpUrl)).status).toBe(200);
    expect(Array.isArray((await rpc(join(f.bootstrap.runtimeDirectory, "gateway.sock"))).result)).toBe(true);
    runs[winner.index]!.child.kill("SIGTERM");
    expect(await within(runs[winner.index]!.exited)).toBe(0);
  });

  // Readiness is the transport boundary; the existing kernel takes the writer
  // lease only at explicit bind. Two catalogs may coexist, never two writers.
  for (const stop of ["SIGTERM", "SIGKILL"] as const) {
    test(`same-workspace transports respect the writer lease across ${stop}`, async () => {
      const f = fixture();
      const runtimeB = join(f.root, "runtime-b");
      mkdirSync(runtimeB, { mode: 0o700 });
      const bootstrapB = { ...f.bootstrap, runtimeDirectory: runtimeB, pairingToken: randomBytes(32).toString("base64url") };
      const runA = launch(f.home, JSON.stringify(f.bootstrap), true, true);
      const runB = launch(f.home, JSON.stringify(bootstrapB), true, true);
      const [readyA, readyB] = await Promise.all([waitReady(runA), waitReady(runB)]);
      expect(readyA.workspace).toBe(readyB.workspace);
      expect(readyA.httpUrl).not.toBe(readyB.httpUrl);
      const session = join(f.home, "sessions", workspaceSessionId(f.bootstrap.workspace));
      const ownerPath = join(session, "session.lease", "owner.json");
      expect(existsSync(ownerPath)).toBe(false);
      const socketA = join(f.bootstrap.runtimeDirectory, "gateway.sock");
      const socketB = join(runtimeB, "gateway.sock");
      const binding = { version: 1, clientId: "bundle-owner", threadId: "bundle-thread", workspacePath: f.bootstrap.workspace };
      const first = await rpc<{ ok: boolean; sessionId: string }>(socketA, "workbench.bind", binding);
      expect(first.error).toBeUndefined();
      expect(first.result.ok).toBe(true);
      const originalOwner = readFileSync(ownerPath, "utf8");
      expect(JSON.parse(originalOwner).pid).toBe(runA.child.pid);
      const history = join(session, "events.jsonl");
      const originalHistory = readFileSync(history, "utf8");
      const second = await rpc(socketB, "workbench.bind", binding);
      expect(second.error?.message).toContain("session in use");
      expect(readFileSync(ownerPath, "utf8")).toBe(originalOwner);
      expect(readFileSync(history, "utf8")).toBe(originalHistory);
      expect((await rpc<{ owned: boolean }>(socketA, "chat.state")).result.owned).toBe(true);
      expect((await rpc<{ owned: boolean }>(socketB, "chat.state")).result.owned).toBe(false);
      runA.child.kill(stop);
      expect(await within(runA.exited)).toBe(stop === "SIGTERM" ? 0 : null);
      if (stop === "SIGKILL") expect(readFileSync(ownerPath, "utf8")).toBe(originalOwner);
      else expect(existsSync(ownerPath)).toBe(false);
      const adopted = await rpc<{ ok: boolean; reconnect: boolean }>(socketB, "workbench.bind", binding);
      expect(adopted.error).toBeUndefined();
      expect(adopted.result).toMatchObject({ ok: true, reconnect: true });
      expect(JSON.parse(readFileSync(ownerPath, "utf8")).pid).toBe(runB.child.pid);
      expect(readFileSync(history, "utf8").startsWith(originalHistory)).toBe(true);
      const gatewayB = new EventLog(join(runtimeB, "gateway.jsonl"), { readOnly: true });
      expect(gatewayB.events.filter((row) => row.name === "workbench/bind_failed")).toHaveLength(1);
      expect(gatewayB.events.filter((row) => row.name === "workbench/bound")).toHaveLength(1);
      expect(new EventLog(history, { readOnly: true }).events.some((row) => row.name === "provider/request")).toBe(false);
      expect(runB.child.exitCode).toBeNull();
      runB.child.kill("SIGTERM");
      expect(await within(runB.exited)).toBe(0);
    }, 30_000);
  }

  for (const persistentLedger of [false, true]) {
  test(`${persistentLedger ? "persistent-owner" : "legacy"} gateway refuses resending after a real post-acceptance crash`, async () => {
    const f = fixture();
    const ledgerDirectory = persistentLedger ? join(f.root, "ledger") : undefined;
    if (ledgerDirectory) mkdirSync(ledgerDirectory, { mode: 0o700 });
    const bootstrap = { ...f.bootstrap, ...(ledgerDirectory ? { gatewayLedgerDirectory: ledgerDirectory } : {}) };
    const originalGatewayLog = join(ledgerDirectory ?? f.bootstrap.runtimeDirectory, "gateway.jsonl");
    const barrier = join(f.root, "accepted-barrier");
    const preload = join(f.root, "crash-boundary.ts");
    // Fault injection preserves the actual append and its returned authority.
    // SIGSTOP after acceptance prevents a model request or fake settlement;
    // the parent then SIGKILLs the real production launcher mid-command.
    writeFileSync(preload, `import { EventLog } from ${JSON.stringify(join(import.meta.dir, "../src/host/event-log.ts"))};
import { writeFileSync } from "node:fs";
const append = EventLog.prototype.appendDurable;
EventLog.prototype.appendDurable = function(input) {
  const row = append.call(this, input);
  if (input.name === "chat/turn_accepted") {
    writeFileSync(${JSON.stringify(barrier)}, "accepted\\n");
    process.kill(process.pid, "SIGSTOP");
  }
  return row;
};\n`);
    const binding = { version: 1, clientId: "crash-owner", threadId: "crash-thread", workspacePath: f.bootstrap.workspace };
    const runA = launch(f.home, JSON.stringify(bootstrap), true, true, preload);
    await waitReady(runA);
    const socketA = join(f.bootstrap.runtimeDirectory, "gateway.sock");
    expect((await rpc(socketA, "workbench.bind", binding)).error).toBeUndefined();
    const wireBinding = { clientId: binding.clientId, threadId: binding.threadId };
    const mode = await rpc<{ selection: { revision: string } }>(socketA, "workbench.workMode", { version: 1, binding: wireBinding, operation: "read" });
    expect(mode.error).toBeUndefined();
    expect((await rpc(socketA, "workbench.workMode", {
      version: 1, binding: wireBinding, operation: "set", commandId: "choose-offline-chat", expectedRevision: mode.result.selection.revision, mode: "chat",
    })).error).toBeUndefined();
    const commandId = "accepted-before-crash";
    const text = "Retain this offline accepted command without resending it.";
    const submitParams = { version: 1, binding: wireBinding, commandId, text };
    const initialSubmit = rpc(socketA, "workbench.submit", submitParams).then((value) => {
      retainEvidence("initial-submit-reply.json", JSON.stringify(value, null, 2) + "\n");
      return { value };
    }).catch((error: unknown) => ({ error }));
    try { await within((async () => {
      while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 10));
    })()); } catch (error) {
      retainEvidence("pre-barrier-gateway.jsonl", readFileSync(originalGatewayLog, "utf8"));
      retainEvidence("pre-barrier-diagnostics.json", JSON.stringify(runA.output(), null, 2) + "\n");
      throw error;
    }
    runA.child.kill("SIGKILL");
    expect(await within(runA.exited)).toBeNull();
    void initialSubmit;
    const history = join(f.home, "sessions", workspaceSessionId(f.bootstrap.workspace), "events.jsonl");
    const before = readFileSync(history, "utf8");
    const initialEvents = new EventLog(history, { readOnly: true }).events;
    expect(initialEvents.filter((row) => row.name === "user/message")).toHaveLength(1);
    expect(initialEvents.filter((row) => row.name === "chat/turn_accepted")).toHaveLength(1);
    expect(initialEvents.some((row) => row.name === "chat/turn_settled" || row.name === "provider/request")).toBe(false);
    retainEvidence("crash-session-before.jsonl", before);
    retainEvidence("crash-gateway-before.jsonl", readFileSync(originalGatewayLog, "utf8"));
    const runtimeB = join(f.root, "runtime-reopen");
    mkdirSync(runtimeB, { mode: 0o700 });
    const runB = launch(f.home, JSON.stringify({ ...bootstrap, runtimeDirectory: runtimeB, pairingToken: randomBytes(32).toString("base64url") }), true, true);
    await waitReady(runB);
    const socketB = join(runtimeB, "gateway.sock");
    expect((await rpc(socketB, "workbench.bind", binding)).error).toBeUndefined();
    expect(readFileSync(history, "utf8").startsWith(before)).toBe(true);
    const status = await rpc<{ state: string }>(socketB, "workbench.commandStatus", { version: 1, binding: submitParams.binding, commandId });
    expect(status.result.state).toBe("accepted");
    const duplicate = await rpc<{ duplicate?: boolean; state: string }>(socketB, "workbench.submit", submitParams);
    retainEvidence("crash-reopen-submit.json", JSON.stringify(duplicate, null, 2) + "\n");
    retainEvidence("crash-session-after.jsonl", readFileSync(history, "utf8"));
    retainEvidence("crash-gateway-after.jsonl", readFileSync(join(ledgerDirectory ?? runtimeB, "gateway.jsonl"), "utf8"));
    if (persistentLedger) {
      expect(duplicate.error).toBeUndefined();
      expect(duplicate.result).toMatchObject({ duplicate: true, state: "accepted" });
    } else {
      expect(duplicate.error?.message).toContain("identity unavailable");
    }
    const conflict = await rpc(socketB, "workbench.submit", { ...submitParams, text: text + " Changed payload." });
    expect(conflict.error?.message).toContain(persistentLedger ? "different payload" : "identity unavailable");
    const fresh = await rpc(socketB, "workbench.submit", { ...submitParams, commandId: "new-command-after-crash" });
    expect(fresh.error?.message).toContain("unresolved");
    expect(new EventLog(history, { readOnly: true }).events.filter((row) => row.name === "user/message")).toHaveLength(1);
    expect(new EventLog(history, { readOnly: true }).events.some((row) => row.name === "provider/request" || row.name === "chat/turn_settled")).toBe(false);
    runB.child.kill("SIGTERM");
    expect(await within(runB.exited)).toBe(0);
  }, 30_000);
  }

  test("failed readiness delivery stops the server and retains its audit log", async () => {
    const f = fixture();
    const run = launch(f.home);
    (run.child.stdio[3] as Readable).destroy();
    run.child.stdin!.end(JSON.stringify(f.bootstrap));
    expect(await within(run.exited)).not.toBe(0);
    expect(run.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
    expect(existsSync(join(f.bootstrap.runtimeDirectory, "gateway.sock"))).toBe(false);
    expect(existsSync(join(f.bootstrap.runtimeDirectory, ".desktop-child-owner"))).toBe(false);
    expect(readFileSync(join(f.bootstrap.runtimeDirectory, "gateway.jsonl"), "utf8")).toContain("desktop/started");
  });

  test("an absolute symlinked workspace preserves the caller's ready identity", async () => {
    const f = fixture();
    const link = join(f.root, "workspace-link");
    symlinkSync(f.bootstrap.workspace, link);
    f.bootstrap.workspace = link;
    const run = launch(f.home, JSON.stringify(f.bootstrap));
    expect((await waitReady(run)).workspace).toBe(link);
    run.child.kill("SIGTERM");
    expect(await within(run.exited)).toBe(0);
  });

  test("SIGTERM while waiting for bootstrap EOF exits without readiness", async () => {
    const f = fixture();
    const run = launch(f.home);
    run.child.stdin!.write('{"schema":1,');
    await new Promise((resolve) => setTimeout(resolve, 100));
    run.child.kill("SIGTERM");
    expect(await within(run.exited)).toBe(0);
    expect(run.output()).toEqual({ stdout: "", stderr: "", ready: "" });
    expect(existsSync(join(f.bootstrap.runtimeDirectory, "gateway.jsonl"))).toBe(false);
  });

  test("fd3 must be a private pipe, not an inherited regular file", async () => {
    const f = fixture();
    const file = join(f.root, "unrelated-file");
    const fd = openSync(file, "w", 0o600);
    const run = launch(f.home, JSON.stringify(f.bootstrap), fd);
    closeSync(fd);
    const outcome = await within((async () => {
      while (run.child.exitCode === null) {
        if (readFileSync(file, "utf8").length > 0) return "ready";
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return "refused";
    })());
    expect(outcome).toBe("refused");
    expect(await within(run.exited)).not.toBe(0);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(run.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
    expect(existsSync(join(f.bootstrap.runtimeDirectory, "gateway.sock"))).toBe(false);
  });

  for (const [name, alter] of [
    ["malformed JSON", (f: ReturnType<typeof fixture>) => `{"pairingToken":"${f.bootstrap.pairingToken}",`],
    ["unknown schema", (f: ReturnType<typeof fixture>) => JSON.stringify({ ...f.bootstrap, schema: 2 })],
    ["relative workspace", (f: ReturnType<typeof fixture>) => JSON.stringify({ ...f.bootstrap, workspace: "private-workspace" })],
    ["missing workspace", (f: ReturnType<typeof fixture>) => JSON.stringify({ ...f.bootstrap, workspace: join(f.root, "missing-private-workspace") })],
    ["relative runtime", (f: ReturnType<typeof fixture>) => JSON.stringify({ ...f.bootstrap, runtimeDirectory: "private-runtime" })],
    ["short token", (f: ReturnType<typeof fixture>) => JSON.stringify({ ...f.bootstrap, pairingToken: "private-token" })],
    ["unexpected key", (f: ReturnType<typeof fixture>) => JSON.stringify({ ...f.bootstrap, privateExtra: "private-value" })],
    ["oversized input", (f: ReturnType<typeof fixture>) => JSON.stringify({ ...f.bootstrap, privateExtra: "x".repeat(16 * 1024) })],
  ] as const) {
    test(`refuses ${name} with a generic diagnostic`, async () => {
      const f = fixture();
      const run = launch(f.home, alter(f));
      expect(await within(run.exited)).not.toBe(0);
      expect(run.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
      expect(existsSync(join(f.bootstrap.runtimeDirectory, "gateway.sock"))).toBe(false);
      expect(existsSync(join(f.bootstrap.runtimeDirectory, "gateway.jsonl"))).toBe(false);
    });
  }

  test("oversized stdin refuses before EOF", async () => {
    const f = fixture();
    const run = launch(f.home);
    run.child.stdin!.on("error", () => {});
    run.child.stdin!.write("x".repeat(16 * 1024 + 1));
    expect(await within(run.exited)).not.toBe(0);
    expect(run.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
  });

  test("creates one private runtime directory under an owned parent", async () => {
    const f = fixture();
    rmdirSync(f.bootstrap.runtimeDirectory);
    const run = launch(f.home, JSON.stringify(f.bootstrap));
    await waitReady(run);
    expect(lstatSync(f.bootstrap.runtimeDirectory).mode & 0o777).toBe(0o700);
    run.child.kill("SIGTERM");
    expect(await within(run.exited)).toBe(0);
  });

  test("a trailing slash cannot hide a runtime-directory symlink", async () => {
    const f = fixture();
    rmdirSync(f.bootstrap.runtimeDirectory);
    symlinkSync(f.bootstrap.workspace, f.bootstrap.runtimeDirectory);
    f.bootstrap.runtimeDirectory += "/";
    const run = launch(f.home, JSON.stringify(f.bootstrap));
    const outcome = await within(Promise.race([waitReady(run).then(() => "ready").catch(() => "refused"), run.exited.then(() => "refused")]));
    expect(outcome).toBe("refused");
    expect(await within(run.exited)).not.toBe(0);
    expect(run.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
    expect(existsSync(join(f.bootstrap.workspace, "gateway.jsonl"))).toBe(false);
  });

  for (const unsafe of ["symlink", "public", "existing socket", "existing log", "unrelated file"] as const) {
    test(`refuses runtime directory with ${unsafe} without deleting caller data`, async () => {
      const f = fixture();
      const runtime = f.bootstrap.runtimeDirectory;
      if (unsafe === "symlink") {
        rmdirSync(runtime);
        symlinkSync(f.bootstrap.workspace, runtime);
      } else if (unsafe === "public") {
        chmodSync(runtime, 0o755);
      } else {
        writeFileSync(join(runtime, unsafe === "existing socket" ? "gateway.sock" : unsafe === "existing log" ? "gateway.jsonl" : "keep.txt"), "caller-data");
      }
      const run = launch(f.home, JSON.stringify(f.bootstrap));
      expect(await within(run.exited)).not.toBe(0);
      expect(run.output()).toEqual({ stdout: "", stderr: "Dokkabi desktop child failed.\n", ready: "" });
      if (unsafe === "symlink") expect(lstatSync(runtime).isSymbolicLink()).toBe(true);
      else if (unsafe !== "public") expect(readFileSync(join(runtime, unsafe === "existing socket" ? "gateway.sock" : unsafe === "existing log" ? "gateway.jsonl" : "keep.txt"), "utf8")).toBe("caller-data");
    });
  }
});

// Native owner loss must revoke the process credential and dispose only its child.
test("private owner channel revokes an actual bundled gateway on disconnect", async () => {
  const f=fixture(); const other=fixture();
  const run=launch(f.home, JSON.stringify({...f.bootstrap,ownerChannel:true}),true,false,undefined,true);
  const unaffected=launch(other.home,JSON.stringify(other.bootstrap));
  const [ready,otherReady]=await Promise.all([waitReady(run),waitReady(unaffected)]);
  expect(JSON.parse(run.output().ready).credentialLifetime).toBe("owner-process");
  const ws=new WebSocket(ready.httpUrl.replace("http:","ws:")+"/ws",["dokkabi.rpc","dokkabi.auth."+f.bootstrap.pairingToken]);
  await within(new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(Error("owner connection failed"));}));
  const paired=await fetch(ready.httpUrl+"/api/pairing",{headers:{authorization:"Bearer "+f.bootstrap.pairingToken}});
  expect(paired.status).toBe(403);await paired.text();
  (run.child.stdio[4] as Duplex).destroy();
  expect(await within(run.exited)).toBe(0);
  expect(existsSync(join(f.bootstrap.runtimeDirectory,"gateway.sock"))).toBe(false);
  expect((await fetch(otherReady.httpUrl)).status).toBe(200);
  ws.close();
  const audit=readFileSync(join(f.bootstrap.runtimeDirectory,"gateway.jsonl"),"utf8");
  expect(audit).toContain('"credential_lifetime":"owner-process"');
  expect(audit).toContain('"name":"desktop/owner_revoked"');
  expect(audit).not.toContain(f.bootstrap.pairingToken);
},20000);

test("an owned bootstrap without its private socket refuses readiness", async () => {
  const f=fixture();const run=launch(f.home,JSON.stringify({...f.bootstrap,ownerChannel:true}));
  expect(await within(run.exited)).toBe(1);expect(run.output().ready).toBe("");
});


test("thread-owned gateways isolate conversations in one workspace and retain owner identity", async () => {
  const f = fixture();
  const ownerA = { clientId: "thread-app", threadId: "conversation-a" };
  const ownerB = { clientId: "thread-app", threadId: "conversation-b" };
  const runtimeB = join(f.root, "runtime-b");
  mkdirSync(runtimeB, { mode: 0o700 });
  const bootstrapA = { ...f.bootstrap, ownerChannel: true, threadBinding: ownerA };
  const bootstrapB = { ...f.bootstrap, runtimeDirectory: runtimeB, ownerChannel: true, threadBinding: ownerB };
  const a = launch(f.home, JSON.stringify(bootstrapA), true, true, undefined, true);
  const b = launch(f.home, JSON.stringify(bootstrapB), true, true, undefined, true);
  await Promise.all([waitReady(a), waitReady(b)]);
  const socketA = join(f.bootstrap.runtimeDirectory, "gateway.sock");
  const socketB = join(runtimeB, "gateway.sock");
  const bind = (owner: typeof ownerA) => ({ version: 1, ...owner, workspacePath: f.bootstrap.workspace });
  expect((await rpc(socketA, "chat.open", { resume: false })).error?.message).toContain("workbench");
  const boundA = await rpc<{ sessionId: string }>(socketA, "workbench.bind", bind(ownerA));
  const boundB = await rpc<{ sessionId: string }>(socketB, "workbench.bind", bind(ownerB));
  expect(boundA.error).toBeUndefined();
  expect(boundB.error).toBeUndefined();
  expect(boundA.result.sessionId).not.toBe(boundB.result.sessionId);
  expect(boundA.result.sessionId).not.toBe(workspaceSessionId(f.bootstrap.workspace));
  const retainedA = readFileSync(join(f.home, "sessions", boundA.result.sessionId, "events.jsonl"), "utf8");
  expect((await rpc(socketA, "workbench.bind", bind(ownerB))).error?.message).toContain("recorded owner");
  expect(readFileSync(join(f.home, "sessions", boundA.result.sessionId, "events.jsonl"), "utf8")).toBe(retainedA);
  a.child.kill("SIGTERM");
  expect(await within(a.exited)).toBe(0);
  const runtimeRestart = join(f.root, "r");
  mkdirSync(runtimeRestart, { mode: 0o700 });
  const restarted = launch(f.home, JSON.stringify({ ...bootstrapA, runtimeDirectory: runtimeRestart }), true, true, undefined, true);
  await waitReady(restarted);
  const rebound = await rpc<{ sessionId: string }>(join(runtimeRestart, "gateway.sock"), "workbench.bind", bind(ownerA));
  expect(rebound.error).toBeUndefined();
  expect(rebound.result.sessionId).toBe(boundA.result.sessionId);
  expect(readFileSync(join(f.home, "sessions", boundA.result.sessionId, "events.jsonl"), "utf8").startsWith(retainedA)).toBe(true);
  expect((await rpc<{ owned: boolean }>(socketB, "chat.state")).result.owned).toBe(true);
}, 30000);
