import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { wireAppLifecycle } from "../desktop/lib/app-lifecycle.mjs";
import { createQuitCleanup } from "../desktop/lib/quit-cleanup.mjs";

describe("desktop quit cleanup", () => {
  it("does not run cleanup for a vetoed update-preparing quit", async () => {
    const app = new EventEmitter();
    const cleanup = createQuitCleanup();
    const calls: string[] = [];
    let releaseStop!: () => void;
    const lifecycle = wireAppLifecycle({
      app,
      supervisor: {
        stop: () => new Promise<void>((resolve) => { releaseStop = resolve; }),
        start: async () => {},
        dispose() {},
      },
      windows: { showMain() {}, closeAllForQuit() {} },
      settingsStore: { get: () => ({ keepRunningOnClose: true }) },
      applyDockVisibility() {},
      onQuitCommitted: () => cleanup.run(),
    });
    cleanup.register("probe", () => calls.push("cleanup"));

    const preparing = lifecycle.prepareForUpdateInstall();
    app.emit("before-quit", { preventDefault() {} });
    assert.deepEqual(calls, []);

    releaseStop();
    await preparing;
  });

  it("runs every registered task once when committed", () => {
    const cleanup = createQuitCleanup();
    const calls: string[] = [];
    cleanup.register("first", () => calls.push("first"));
    cleanup.register("second", () => calls.push("second"));

    cleanup.run();
    cleanup.run();

    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(cleanup.committed, true);
  });

  it("runs tasks registered after commit immediately", () => {
    const cleanup = createQuitCleanup();
    const calls: string[] = [];
    cleanup.run();

    cleanup.register("late", () => calls.push("late"));

    assert.deepEqual(calls, ["late"]);
  });

  it("continues after one cleanup task throws", () => {
    const logs: string[] = [];
    const logger = { ...console, error: (line: unknown) => { logs.push(String(line)); } };
    const cleanup = createQuitCleanup({ logger });
    const calls: string[] = [];
    cleanup.register("broken", () => { throw new Error("boom"); });
    cleanup.register("healthy", () => calls.push("healthy"));

    cleanup.run();

    assert.deepEqual(calls, ["healthy"]);
    assert.match(logs[0], /quit cleanup broken failed: boom/);
  });

  it("keeps app-lifecycle as the only before-quit owner", () => {
    const main = readFileSync("desktop/main.mjs", "utf8");
    assert.ok(!main.includes('app.on("before-quit"'));
  });
});
