import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { wireMainWindow } from "../desktop/lib/window-lifecycle.mjs";

class FakeWebContents extends EventEmitter {
  reloads = 0;

  reload() {
    this.reloads += 1;
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  webContents = new FakeWebContents();

  isDestroyed() {
    return this.destroyed;
  }
}

function fixture() {
  const win = new FakeWindow();
  const calls: string[] = [];
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let currentTime = 0;
  let keepRunningOnClose = true;
  const manager = {
    quitting: false,
    main: win as FakeWindow | null,
    getSettings: () => ({ keepRunningOnClose }),
    onHiddenToTray: () => calls.push("hidden"),
    onVisibilityChange: () => calls.push("visibility"),
  };
  const wire = (target = win) => wireMainWindow(target, {
    manager,
    now: () => currentTime,
    schedule: (callback: () => void, delay: number) => scheduled.push({ callback, delay }),
  });
  return {
    win,
    calls,
    manager,
    scheduled,
    wire,
    setKeepRunning: (value: boolean) => { keepRunningOnClose = value; },
    setTime: (value: number) => { currentTime = value; },
  };
}

describe("desktop main-window lifecycle", () => {
  it("lets close destroy the window and reports tray backgrounding only when enabled", () => {
    const { win, calls, manager, setKeepRunning, wire } = fixture();
    let prevented = 0;
    wire();

    win.emit("close", { preventDefault: () => { prevented += 1; } });
    setKeepRunning(false);
    win.emit("close", { preventDefault: () => { prevented += 1; } });
    setKeepRunning(true);
    manager.quitting = true;
    win.emit("close", { preventDefault: () => { prevented += 1; } });

    assert.equal(prevented, 0, "close must never be intercepted");
    assert.deepEqual(calls, ["hidden"]);
  });

  it("tracks close, hide, and show visibility without clearing a replacement window", () => {
    const { win, calls, manager, wire } = fixture();
    wire();

    win.emit("hide");
    win.emit("show");
    win.emit("closed");
    assert.equal(manager.main, null);
    assert.deepEqual(calls, ["visibility", "visibility", "visibility"]);

    const replacement = new FakeWindow();
    manager.main = replacement;
    win.emit("closed");
    assert.equal(manager.main, replacement);
  });

  it("reloads a killed renderer after the configured delay", () => {
    const { win, scheduled, wire } = fixture();
    wire();

    win.webContents.emit("render-process-gone", {}, { reason: "killed" });

    assert.equal(scheduled.length, 1, "a killed renderer must be recoverable");
    assert.equal(scheduled[0]?.delay, 250);
    scheduled[0]?.callback();
    assert.equal(win.webContents.reloads, 1);
  });

  it("allows only three reloads inside one minute", () => {
    const { win, scheduled, wire } = fixture();
    wire();

    for (let count = 0; count < 4; count += 1) {
      win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    }
    for (const task of scheduled) task.callback();

    assert.equal(scheduled.length, 3);
    assert.equal(win.webContents.reloads, 3);
  });

  it("gives each recreated window a fresh reload budget", () => {
    const { win, manager, scheduled, wire } = fixture();
    wire();
    for (let count = 0; count < 3; count += 1) {
      win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    }

    const replacement = new FakeWindow();
    manager.main = replacement;
    wire(replacement);
    replacement.webContents.emit("render-process-gone", {}, { reason: "crashed" });

    assert.equal(scheduled.length, 4, "a replacement window must not inherit the old reload count");
  });

  it("expires reload attempts at the budget window boundary", () => {
    const { win, scheduled, setTime, wire } = fixture();
    wire();
    for (let count = 0; count < 3; count += 1) {
      win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    }

    setTime(60_000);
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });

    assert.equal(scheduled.length, 4);
  });

  it("suppresses clean exits and reloads once quitting starts", () => {
    const { win, manager, scheduled, wire } = fixture();
    wire();

    win.webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
    manager.quitting = true;
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });

    assert.equal(scheduled.length, 0);
  });

  it("rechecks quitting and window destruction before a scheduled reload", () => {
    const first = fixture();
    first.wire();
    first.win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    first.manager.quitting = true;
    first.scheduled[0]?.callback();
    assert.equal(first.win.webContents.reloads, 0);

    const second = fixture();
    second.wire();
    second.win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    second.win.destroyed = true;
    second.scheduled[0]?.callback();
    assert.equal(second.win.webContents.reloads, 0);
  });
});
