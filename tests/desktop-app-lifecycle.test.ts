import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { wireAppLifecycle } from "../desktop/lib/app-lifecycle.mjs";

class FakeApp extends EventEmitter {
  calls: string[] = [];
  quit() { this.calls.push("quit"); }
  exit(code: number) { this.calls.push(`exit:${code}`); }
}

function fixture() {
  const app = new FakeApp();
  const calls: string[] = [];
  let releaseStop: (() => void) | null = null;
  const supervisor = {
    start: async () => { calls.push("start"); },
    stop: () => new Promise<void>((resolve) => { calls.push("stop"); releaseStop = resolve; }),
    dispose: () => calls.push("dispose"),
  };
  const windows = {
    showMain: () => calls.push("show"),
    closeAllForQuit: () => calls.push("close"),
  };
  const settingsStore = { get: () => ({ keepRunningOnClose: false }) };
  const coordinator = wireAppLifecycle({
    app,
    supervisor,
    windows,
    settingsStore,
    applyDockVisibility: () => calls.push("dock"),
    logger: { error: (value: unknown) => calls.push(`error:${String(value)}`) },
  });
  return { app, calls, coordinator, supervisor, releaseStop: () => releaseStop?.() };
}

describe("desktop app lifecycle", () => {
  it("prevents normal quit until the server has stopped", async () => {
    const { app, calls, releaseStop } = fixture();
    let prevented = 0;
    app.emit("before-quit", { preventDefault: () => { prevented += 1; } });

    assert.equal(prevented, 1);
    assert.deepEqual(calls, ["close", "stop"]);
    assert.deepEqual(app.calls, []);

    releaseStop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["close", "stop", "dispose"]);
    assert.deepEqual(app.calls, ["exit:0"]);
  });

  it("blocks incidental quit while preparing an update then allows updater quit", async () => {
    const { app, calls, coordinator, releaseStop } = fixture();
    const preparing = coordinator.prepareForUpdateInstall();
    let prevented = 0;

    app.emit("before-quit", { preventDefault: () => { prevented += 1; } });
    app.emit("window-all-closed");
    assert.equal(prevented, 1);
    assert.deepEqual(app.calls, []);

    releaseStop();
    assert.equal(await preparing, true);
    assert.deepEqual(calls, ["stop", "dispose"]);

    app.emit("before-quit", { preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1, "updater-owned quit must not be intercepted");
    assert.deepEqual(app.calls, []);
  });

  it("runs the existing window-close policy while idle", () => {
    const { app } = fixture();
    app.emit("window-all-closed");
    assert.deepEqual(app.calls, ["quit"]);
  });

  it("opens the window on a manual relaunch but not on a login relaunch", () => {
    const { app, calls } = fixture();
    app.emit("second-instance", {}, ["ima2", "--autostart"]);
    assert.deepEqual(calls, []);
    app.emit("second-instance", {}, ["ima2"]);
    assert.deepEqual(calls, ["show"]);
  });

  it("recovers to running when an update install is aborted", async () => {
    const { app, calls, coordinator, releaseStop } = fixture();
    const preparing = coordinator.prepareForUpdateInstall();
    releaseStop();
    assert.equal(await preparing, true);
    // The installer handoff never happened: the app must come back with its
    // server instead of sitting drained (opencodex's abort_restart).
    await coordinator.abortUpdateInstall();
    assert.deepEqual(calls, ["stop", "dispose", "start"]);
    let prevented = 0;
    app.emit("before-quit", { preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1, "lifecycle is running again and intercepts quit");
    await coordinator.abortUpdateInstall();
    assert.deepEqual(calls, ["stop", "dispose", "start", "close", "stop"], "second abort is a no-op");
    releaseStop();
  });

  it("a failed install drain does not wedge the app between quit-able states", async () => {
    const { app, calls, coordinator, supervisor, releaseStop } = fixture();
    let boom = true;
    (supervisor as { dispose: () => void }).dispose = () => {
      calls.push("dispose");
      if (boom) { boom = false; throw new Error("boom"); }
    };
    const preparing = coordinator.prepareForUpdateInstall();
    releaseStop();
    await assert.rejects(preparing, /boom/);
    assert.deepEqual(calls, ["stop", "dispose", "start"], "failed drain recovers the server");
    let prevented = 0;
    app.emit("before-quit", { preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1, "back to running: a normal quit drains the server again");
    releaseStop();
  });

  it("a rejected server stop aborts the install and recovers the server", async () => {
    const { app, calls, coordinator, supervisor } = fixture();
    (supervisor as { stop: () => Promise<void> }).stop = async () => {
      calls.push("stop");
      throw new Error("drain failed");
    };
    await assert.rejects(coordinator.prepareForUpdateInstall(), /drain failed/);
    assert.deepEqual(calls, ["stop", "start"], "no dispose, no install path — the server comes back");
    let prevented = 0;
    app.emit("before-quit", { preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1, "lifecycle is running again, not stuck in update states");
  });
});

describe("desktop background-mode wiring", () => {
  it("scopes startHidden to login launches only", () => {
    const main = readFileSync("desktop/main.mjs", "utf8");
    assert.match(main, /startHiddenAtLogin = \w+\.startHidden && origin === "login"/);
    assert.match(main, /if \(!startHiddenAtLogin\) windows\.showMain\(\)/);
    assert.ok(!main.includes("!settingsStore.get().startHidden) windows.showMain"));
  });

  it("destroys the closed window instead of parking a hidden renderer", () => {
    const source = readFileSync("desktop/lib/windows.mjs", "utf8");
    const closeHandler = source.slice(source.indexOf('win.on("close"'));
    const closeBody = closeHandler.slice(0, closeHandler.indexOf("});"));
    assert.ok(!closeBody.includes("preventDefault"), "close is no longer intercepted");
    assert.ok(!closeBody.includes(".hide()"), "window is destroyed, not hidden");
    assert.match(source, /render-process-gone/);
  });

  it("keeps the tray Open action reachable when the server is down", () => {
    const tray = readFileSync("desktop/lib/tray.mjs", "utf8");
    assert.match(tray, /label: "Open ima2", click: \(\) => this\.actions\.openApp\(\) \}/);
    const popup = readFileSync("desktop/pages/tray.js", "utf8");
    assert.ok(!popup.includes('$("open").disabled'));
  });
});
