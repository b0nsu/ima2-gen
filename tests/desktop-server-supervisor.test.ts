import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessTree, ServerSupervisor } from "../desktop/lib/server.mjs";

// devlog/_plan/260929_background_runtime/030 + 040: the supervisor asks the
// bundled CLI first, and restarts only a bundled child that crashed.

type Child = EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: string | null; kill: (signal?: string) => boolean; env: Record<string, string> };

const SETTINGS = { port: 3333, existingServer: "ask", nodeBinary: "/fake/node", configDir: "", devLogging: false };
const statusRun = (doc: Record<string, unknown>, code: number) => ({ code, stdout: JSON.stringify({ schema: "ima2-status/1", manager: { state: "absent" }, serviceOwnership: "unmanaged", stoppable: false, runtime: null, ...doc }), stderr: "" });
const ABSENT = statusRun({ liveness: "absent-proven" }, 3);
const NATIVE = statusRun({ liveness: "live", stoppable: true, runtime: { pid: 4242, url: "http://127.0.0.1:1", bootId: "native", startedAt: 1, launcher: "foreground", root: "/elsewhere" } }, 0);
const STOPPED = { code: 0, stdout: JSON.stringify({ schema: "ima2-stop/1", ok: true, outcome: "stopped", runtimeDown: true }), stderr: "" };

function harness(cliAnswers: Array<{ code: number | null; stdout: string; stderr: string }>, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ima2-supervisor-"));
  const children: Child[] = [];
  const cliCalls: string[][] = [];
  const spawnFn = (_bin: string, _args: string[], opts: { env: Record<string, string> }) => {
    const c = Object.assign(new EventEmitter(), { pid: 9000 + children.length, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true, env: opts.env }) as Child;
    children.push(c);
    return c;
  };
  const runCli = async (args: string[]) => { cliCalls.push(args); return cliAnswers.length > 1 ? cliAnswers.shift()! : cliAnswers[0]!; };
  const sup = new ServerSupervisor({ rootDir: dir, logFile: join(dir, "server.log"), isPackaged: false, spawnFn: spawnFn as never, runCli, probe: async () => "refused", ...extra });
  const cleanup = async () => {
    const stream = (sup as unknown as { logStream: { end: (cb: () => void) => void } | null }).logStream;
    if (stream) await new Promise<void>((r) => stream.end(() => r()));
    sup.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { sup, children, cliCalls, dir, cleanup };
}

function exit(c: Child, code: number | null, signal: string | null = null) {
  c.exitCode = code;
  c.signalCode = signal;
  c.stdout.end();
  c.stderr.end();
  c.emit("exit", code, signal);
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function running(h: ReturnType<typeof harness>) {
  await h.sup.start(SETTINGS);
  const c = h.children[0]!;
  c.stdout.write("Image Gen running at http://127.0.0.1:1\n");
  await tick();
  assert.equal(h.sup.state, "running");
  return c;
}

describe("ServerSupervisor", () => {
  it("does not restart a server stopped on request, even when the marker is split", async () => {
    const h = harness([ABSENT]);
    try {
      const c = await running(h);
      const marker = `IMA2_STOP_INTENT ${c.env.IMA2_BOOT_ID}\n`;
      c.stdout.write(marker.slice(0, 10));
      c.stdout.write(marker.slice(10));
      exit(c, 0);
      await tick(1300);
      assert.equal(h.sup.state, "stopped");
      assert.equal(h.sup.snapshot().stoppedBy, "cli");
      assert.equal(h.children.length, 1, "no respawn");
    } finally {
      await h.cleanup();
    }
  });

  it("restarts after an external SIGTERM (exit 0 without marker), a foreign marker, or a crash", async () => {
    for (const [label, line, code] of [["no marker", "", 0], ["foreign boot", "IMA2_STOP_INTENT 00000000-0000-4000-8000-000000000000\n", 0], ["crash", "", 1]] as const) {
      const h = harness([ABSENT]);
      try {
        const c = await running(h);
        if (line) c.stdout.write(line);
        exit(c, code);
        await tick(1300);
        assert.equal(h.children.length, 2, `${label}: respawned`);
      } finally {
        await h.cleanup();
      }
    }
  });

  it("blocks without spawning when the bundled CLI cannot answer", async () => {
    const h = harness([{ code: null, stdout: "", stderr: "", error: "spawn ENOENT" } as never]);
    try {
      await h.sup.start(SETTINGS);
      assert.equal(h.sup.state, "error");
      assert.equal(h.children.length, 0);
      assert.match(h.sup.lastError, /ENOENT/);
    } finally {
      await h.cleanup();
    }
  });

  it("attaches as a guest when the user keeps the running server", async () => {
    const h = harness([NATIVE], { askTakeover: async () => ({ approve: false }) });
    try {
      await h.sup.start(SETTINGS);
      const snap = h.sup.snapshot();
      assert.equal(snap.state, "running");
      assert.equal(snap.ownership, "guest");
      assert.equal(snap.guest.pid, 4242);
      assert.equal(snap.guest.launcher, "foreground");
      assert.equal(h.children.length, 0);
    } finally {
      await h.cleanup();
    }
  });

  it("takes over after approval: identity-guarded stop, then the bundled spawn", async () => {
    const h = harness([NATIVE, NATIVE, STOPPED], { askTakeover: async () => ({ approve: true }) });
    try {
      await h.sup.start(SETTINGS);
      assert.deepEqual(h.cliCalls[2], ["stop", "--json", "--expect-pid", "4242", "--expect-boot", "native"]);
      assert.equal(h.children.length, 1);
      assert.equal(h.children[0]!.env.IMA2_DESKTOP, "1");
    } finally {
      await h.cleanup();
    }
  });

  it("switches to the bundled server on demand from a guest session", async () => {
    const h = harness([NATIVE, NATIVE, STOPPED], { askTakeover: async () => ({ approve: false }) });
    try {
      await h.sup.start(SETTINGS);
      assert.equal((h.sup as unknown as { ownership: string }).ownership, "guest");
      await h.sup.useBundledServer(SETTINGS);
      assert.equal(h.children.length, 1);
    } finally {
      await h.cleanup();
    }
  });

  it("waits for an active login service instead of racing it", async () => {
    const starting = statusRun({ liveness: "absent-proven", manager: { state: "bound", kind: "launchd", pid: null, active: true } }, 3);
    const h = harness([starting, NATIVE], { askTakeover: async () => ({ approve: false }) });
    try {
      await h.sup.start(SETTINGS);
      assert.equal((h.sup as unknown as { ownership: string }).ownership, "guest");
      assert.equal(h.children.length, 0);
    } finally {
      await h.cleanup();
    }
  });

  it("a stop during a pending prompt retires that startup: nothing is spawned later", async () => {
    let answer!: (v: { approve: boolean }) => void;
    const h = harness([NATIVE, NATIVE, STOPPED], { askTakeover: () => new Promise((r) => { answer = r; }) });
    try {
      const pending = h.sup.start(SETTINGS);
      await tick();
      await h.sup.stop();
      answer({ approve: true });
      await pending;
      await tick();
      assert.equal(h.children.length, 0);
      assert.equal(h.sup.state, "stopped");
    } finally {
      await h.cleanup();
    }
  });

  it("a previous child's delayed exit does not clear its replacement", async () => {
    // (see also: stop during takeover, below)
    const h = harness([ABSENT]);
    try {
      const first = await running(h);
      const stopping = h.sup.stop();
      await tick();
      // Exit without ending stdout: the supervisor waits up to 500 ms for the last chunk.
      first.exitCode = 0;
      first.emit("exit", 0, null);
      await stopping;
      await h.sup.start(SETTINGS);
      const second = h.children[1]!;
      await tick(700);
      assert.equal((h.sup as unknown as { child: unknown }).child, second);
      assert.equal(h.children.length, 2);
    } finally {
      await h.cleanup();
    }
  });

  it("an unterminated stop-intent line at exit is not a stop intent", async () => {
    const h = harness([ABSENT]);
    try {
      const c = await running(h);
      c.stdout.write(`IMA2_STOP_INTENT ${c.env.IMA2_BOOT_ID}`);
      exit(c, 0);
      await tick(1300);
      assert.equal(h.children.length, 2, "treated as an unrequested exit and respawned");
    } finally {
      await h.cleanup();
    }
  });

  it("a stop while takeover re-checks the server never runs the CLI stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let call = 0;
    const h = harness([NATIVE], { askTakeover: async () => ({ approve: true }) });
    (h.sup as unknown as { runCli: unknown }).runCli = async (args: string[]) => {
      h.cliCalls.push(args);
      call += 1;
      if (call === 2) await gate; // the takeover's fresh status check
      return args[0] === "stop" ? STOPPED : NATIVE;
    };
    try {
      const pending = h.sup.start(SETTINGS);
      await tick();
      await h.sup.stop();
      release();
      await pending;
      assert.equal(h.cliCalls.filter((a) => a[0] === "stop").length, 0);
      assert.equal(h.children.length, 0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("windows force-kill", () => {
  it("rejects a stop when the child survives every kill attempt", { timeout: 1_000 }, async () => {
    const graceMs = 20;
    const h = harness([ABSENT], { killTreeFn: () => false, stopGraceMs: graceMs });
    try {
      const c = await running(h);
      c.kill = () => false;
      const startedAt = Date.now();
      await assert.rejects(h.sup.stop(), /server did not exit/);
      assert.ok(Date.now() - startedAt <= graceMs * 2 + 50, "stop is bounded by two grace intervals");
      assert.equal(h.sup.state, "error");
      assert.equal(h.sup.lastError, "server did not exit");
      assert.equal((h.sup as unknown as { child: Child | null }).child, c);
    } finally {
      await h.cleanup();
    }
  });

  it("keeps a child whose kill raised an error while stopping", { timeout: 1_000 }, async () => {
    const h = harness([ABSENT], { killTreeFn: () => false, stopGraceMs: 20 });
    try {
      const c = await running(h);
      c.kill = () => { c.emit("error", new Error("kill EPERM")); return false; };
      await assert.rejects(h.sup.stop(), /server did not exit/);
      assert.equal((h.sup as unknown as { child: Child | null }).child, c, "a live child is not dropped on a kill error");
      assert.equal(h.sup.state, "error");
    } finally {
      await h.cleanup();
    }
  });

  it("restart resolves without spawning when the old child will not exit", { timeout: 1_000 }, async () => {
    const h = harness([ABSENT], { killTreeFn: () => false, stopGraceMs: 20 });
    try {
      const c = await running(h);
      c.kill = () => false;
      const spawned = h.children.length;
      await h.sup.restart(SETTINGS);
      assert.equal(h.children.length, spawned, "no second server next to the surviving one");
      assert.equal(h.sup.state, "error");
      assert.equal(h.sup.lastError, "server did not exit");
    } finally {
      await h.cleanup();
    }
  });

  it("shares the admin request and tree kill between concurrent stops", async (t) => {
    const killed: number[] = [];
    let adminRequests = 0;
    const h = harness([ABSENT], { killTreeFn: (pid: number) => { killed.push(pid); return true; }, stopGraceMs: 20 });
    t.mock.method(globalThis, "fetch", async (_input, init) => {
      if (init?.method === "POST") adminRequests += 1;
      return init?.method === "POST" ? new Response(null, { status: 202 }) : Response.json({ ok: true });
    });
    try {
      const c = await running(h);
      writeFileSync(join(h.dir, "server.json"), JSON.stringify({ pid: c.pid, adminNonce: "nonce", url: "http://127.0.0.1:1" }));
      (h.sup as unknown as { configDir: string }).configDir = h.dir;
      const first = h.sup.stop();
      const second = h.sup.stop();
      await tick(30);
      exit(c, 0);
      await Promise.all([first, second]);
      await tick();
      assert.equal(adminRequests, 1);
      assert.deepEqual(killed, [c.pid]);
    } finally {
      await h.cleanup();
    }
  });

  it("does not resolve early when SIGTERM throws", async () => {
    let settled = false;
    const h = harness([ABSENT], { killTreeFn: () => false, stopGraceMs: 20 });
    try {
      const c = await running(h);
      c.kill = (signal) => { if (signal === "SIGTERM") throw new Error("kill failed"); return false; };
      const stopping = h.sup.stop().finally(() => { settled = true; });
      await tick(5);
      assert.equal(settled, false);
      exit(c, 0);
      await stopping;
      await tick();
    } finally {
      await h.cleanup();
    }
  });

  it("tree-kills a live owned child when the graceful stop is unavailable", async () => {
    const killed: number[] = [];
    const h = harness([ABSENT], { killTreeFn: (pid: number) => { killed.push(pid); return true; } });
    try {
      const c = await running(h);
      const stopping = h.sup.stop();
      await tick();
      assert.deepEqual(killed, [c.pid]);
      exit(c, 0);
      await stopping;
      await tick(); // #afterStdout defers #onExit's log write past stop()'s resolve
      assert.equal(h.sup.state, "stopped");
    } finally {
      await h.cleanup();
    }
  });

  it("never tree-kills a stale pid when the child exits during the admin stop", async () => {
    const killed: number[] = [];
    const h = harness([ABSENT], { killTreeFn: (pid: number) => { killed.push(pid); return true; }, stopGraceMs: 30 });
    try {
      const c = await running(h);
      const stopping = h.sup.stop();
      exit(c, 0); // exits while requestAdminStop is still in flight
      await stopping;
      await tick(80); // the armed force timer must have been disarmed
      assert.deepEqual(killed, [], "no late tree-kill at a possibly reused pid");
      assert.equal(h.sup.state, "stopped");
    } finally {
      await h.cleanup();
    }
  });

  it("runs taskkill for the full Windows process tree", () => {
    const calls: unknown[][] = [];
    const spawnSyncFn = (...args: unknown[]) => { calls.push(args); return { status: 0 }; };
    // This fake implements only the spawnSync overload used by killProcessTree.
    assert.equal(killProcessTree(123, { platform: "win32", spawnSyncFn: spawnSyncFn as never }), true);
    assert.deepEqual(calls, [["taskkill", ["/PID", "123", "/T", "/F"], { stdio: "ignore", windowsHide: true }]]);
  });

  it("reports a non-zero taskkill status as failure", () => {
    assert.equal(killProcessTree(123, { platform: "win32", spawnSyncFn: (() => ({ status: 1 })) as never }), false);
  });

  it("does not spawn taskkill on non-Windows platforms", () => {
    let spawned = false;
    const spawnSyncFn = () => { spawned = true; return { status: 0 }; };
    const result = killProcessTree(123, { platform: "darwin", spawnSyncFn: spawnSyncFn as never });
    assert.equal(result, false);
    assert.equal(spawned, false);
  });
});
