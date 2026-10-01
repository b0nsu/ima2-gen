import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { trayUpdateItem, initialUpdateState } from "../desktop/lib/update-state.mjs";
import { describe, it } from "node:test";
import { createUpdaterController } from "../desktop/lib/updater.mjs";

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkResult: any = { isUpdateAvailable: false, updateInfo: { version: "3.16.1" } };
  calls: string[] = [];

  async checkForUpdates() {
    this.calls.push("check");
    this.emitCheck(this.checkResult);
    return this.checkResult;
  }

  emitCheck(result: typeof this.checkResult) {
    this.emit("checking-for-update");
    this.emit(result.isUpdateAvailable ? "update-available" : "update-not-available", result.updateInfo);
  }

  emitProgress(percent: number) { this.emit("download-progress", { percent }); }
  emitDownloaded(version = "3.17.0") { this.emit("update-downloaded", { version }); }

  async downloadUpdate() {
    this.calls.push("download");
    return ["/tmp/ima2.zip"];
  }

  quitAndInstall() {
    this.calls.push("install");
  }
}

function fixture({ responses = [] as number[] } = {}) {
  const autoUpdater = new FakeAutoUpdater();
  const dialogs: any[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  const dialog = {
    async showMessageBox(options: any) {
      dialogs.push(options);
      return { response: responses.shift() ?? 1 };
    },
  };
  const logger = {
    info: (value: unknown) => logs.push(`info:${String(value)}`),
    error: (value: unknown) => logs.push(`error:${String(value)}`),
  };
  const create = (overrides: Record<string, unknown> = {}) => createUpdaterController({
    app: { isPackaged: true, getVersion: () => "3.16.1" },
    dialog,
    platform: "darwin",
    arch: "arm64",
    env: {},
    logger,
    loadUpdater: async () => ({ autoUpdater }),
    prepareForInstall: async () => { order.push("prepare"); return true; },
    revertInstall: async () => { order.push("revert"); },
    // Large by default so a successful install in a test does not fire mid-suite;
    // watchdog tests override it with a small value.
    installWatchdogMs: 600_000,
    ...overrides,
  });
  return { autoUpdater, dialogs, logs, order, create };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("desktop updater", () => {
  it("never loads or checks on unpackaged apps or unsupported platforms", async () => {
    for (const guard of [
      { app: { isPackaged: false, getVersion: () => "3.16.1" } },
      { platform: "linux", env: {} },            // non-AppImage installs (deb, unpackaged) cannot self-update
      { platform: "linux", env: { APPIMAGE: "" } },
      { platform: "darwin", arch: "x64" },       // only Apple Silicon macOS is shipped
      { platform: "freebsd" },
    ]) {
      let loads = 0;
      const { create } = fixture();
      const controller = await create({
        ...guard,
        loadUpdater: async () => { loads += 1; throw new Error("must not load"); },
      });
      assert.equal(controller.active, false);
      assert.equal(await controller.checkForUpdates({ manual: true }), false);
      assert.equal(loads, 0);
    }
  });

  it("activates on every shipped platform: macOS arm64, Windows, Linux AppImage", async () => {
    for (const guard of [
      {},                                        // darwin arm64
      { platform: "win32", arch: "x64" },
      { platform: "win32", arch: "arm64" },
      { platform: "linux", arch: "x64", env: { APPIMAGE: "/opt/ima2/ima2.AppImage" } },
      { platform: "linux", arch: "arm64", env: { APPIMAGE: "/opt/ima2/ima2.AppImage" } },
    ]) {
      const { autoUpdater, create } = fixture();
      const controller = await create(guard);
      assert.equal(controller.active, true, JSON.stringify(guard));
      assert.equal(autoUpdater.autoDownload, true);
      assert.equal(await controller.checkForUpdates(), true);
    }
  });

  it("auto-downloads by default, keeps install-on-quit off, and follows setAutoDownload", async () => {
    const { autoUpdater, create } = fixture();
    const controller = await create();

    assert.equal(controller.active, true);
    assert.equal(autoUpdater.autoDownload, true);
    assert.equal(autoUpdater.autoInstallOnAppQuit, false);

    controller.setAutoDownload(false);
    assert.equal(autoUpdater.autoDownload, false);
    controller.setAutoDownload(true);
    assert.equal(autoUpdater.autoDownload, true);

    const manual = fixture();
    await manual.create({ autoDownload: false });
    assert.equal(manual.autoUpdater.autoDownload, false);
  });

  it("fails soft when the packaged updater dependency cannot load", async () => {
    const { logs, create } = fixture();
    const controller = await create({ loadUpdater: async () => { throw new Error("missing module"); } });

    assert.equal(controller.active, false);
    assert.ok(logs.some((line) => line.includes("missing module")));
  });

  it("keeps background no-update quiet and reports manual no-update", async () => {
    const { autoUpdater, dialogs, create } = fixture();
    const controller = await create();

    assert.equal(await controller.checkForUpdates(), true);
    assert.equal(dialogs.length, 0);
    assert.equal(await controller.checkForUpdates({ manual: true }), true);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, /up to date/i);
    assert.deepEqual(autoUpdater.calls, ["check", "check"]);
  });

  it("auto-update mode checks without prompting for the download", async () => {
    const { autoUpdater, dialogs, create } = fixture();
    autoUpdater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "3.17.0" } };
    const controller = await create();

    assert.equal(await controller.checkForUpdates(), true);
    assert.equal(dialogs.length, 0);
    assert.deepEqual(autoUpdater.calls, ["check"]);
  });

  it("downloads an available update only after consent when auto-download is off", async () => {
    const accepted = fixture({ responses: [0] });
    accepted.autoUpdater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "3.17.0" } };
    const acceptedController = await accepted.create({ autoDownload: false });
    await acceptedController.checkForUpdates({ manual: true });
    assert.deepEqual(accepted.autoUpdater.calls, ["check", "download"]);
    assert.match(accepted.dialogs[0].message, /3\.17\.0/);

    const declined = fixture({ responses: [1] });
    declined.autoUpdater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "3.17.0" } };
    const declinedController = await declined.create({ autoDownload: false });
    await declinedController.checkForUpdates({ manual: true });
    assert.deepEqual(declined.autoUpdater.calls, ["check"]);
  });

  it("stops the server before installing a downloaded update", async () => {
    const { autoUpdater, order, create } = fixture({ responses: [0] });
    autoUpdater.quitAndInstall = () => { order.push("install"); };
    await create();

    autoUpdater.emit("update-downloaded", { version: "3.17.0" });
    await settle();
    assert.deepEqual(order, ["prepare", "install"]);
  });

  it("does not prepare or install when restart consent is declined", async () => {
    const { autoUpdater, order, create } = fixture({ responses: [1] });
    autoUpdater.quitAndInstall = () => { order.push("install"); };
    await create();

    autoUpdater.emit("update-downloaded", { version: "3.17.0" });
    await settle();
    assert.deepEqual(order, []);
  });

  it("logs background failures but surfaces manual failures", async () => {
    const { autoUpdater, dialogs, logs, create } = fixture();
    autoUpdater.checkForUpdates = async () => { throw new Error("offline"); };
    const controller = await create();

    assert.equal(await controller.checkForUpdates(), false);
    assert.equal(dialogs.length, 0);
    assert.ok(logs.some((line) => line.includes("offline")));

    assert.equal(await controller.checkForUpdates({ manual: true }), false);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, /unable to check/i);
  });

  it("wires the menu action and starts the background check after the server", () => {
    const main = readFileSync("desktop/main.mjs", "utf8");
    const menu = readFileSync("desktop/lib/menu.mjs", "utf8");

    assert.deepEqual(trayUpdateItem(initialUpdateState({ active: true, currentVersion: "3.16.1" })), { label: "Check for Updates…", action: "check", enabled: true });
    for (const source of [menu, readFileSync("desktop/lib/tray.mjs", "utf8")]) {
      assert.match(source, /check: \(\) => (?:this\.)?actions\.checkForUpdates\(\)/);
    }
    assert.ok(main.indexOf("await supervisor.start") < main.indexOf("void updater.checkForUpdates()"));
    assert.match(main, /prepareForInstall: \(\) => lifecycle\.prepareForUpdateInstall\(\)/);
    assert.match(main, /revertInstall: \(\) => lifecycle\.abortUpdateInstall\(\)/);
  });
});


describe("desktop update controller state", () => {
  it("publishes checking, available, progress and downloaded snapshots", async () => {
    const f = fixture();
    const controller = await f.create({ now: () => 123 });
    const seen: string[] = [];
    controller.onState((state) => seen.push(`${state.phase}:${state.progress}`));
    f.autoUpdater.emitCheck({ isUpdateAvailable: true, updateInfo: { version: "3.17.0" } });
    f.autoUpdater.emitProgress(41.7);
    f.autoUpdater.emitDownloaded();
    await settle();
    assert.deepEqual(seen, ["checking:null", "available:null", "downloading:42", "downloaded:100"]);
    assert.equal(controller.snapshot().availableVersion, "3.17.0");
    const snapshot = controller.snapshot();
    snapshot.phase = "idle";
    assert.equal(controller.snapshot().phase, "downloaded");
  });

  it("guards checks during downloading, downloaded and installing", async () => {
    const f = fixture();
    const controller = await f.create();
    f.autoUpdater.emitProgress(1);
    assert.equal(await controller.checkForUpdates({ manual: true }), false);
    f.autoUpdater.emitDownloaded();
    await settle();
    assert.equal(await controller.checkForUpdates(), false);
    await controller.installUpdate({ confirm: false });
    assert.equal(controller.snapshot().phase, "installing");
    assert.equal(await controller.checkForUpdates(), false);
    assert.deepEqual(f.autoUpdater.calls, ["install"]);
  });

  it("dedupes downloads and exposes retries after failures", async () => {
    const f = fixture();
    let rejectDownload!: (reason: Error) => void;
    f.autoUpdater.downloadUpdate = () => {
      f.autoUpdater.calls.push("download");
      return new Promise((_resolve, reject) => { rejectDownload = reject; });
    };
    const controller = await f.create({ autoDownload: false });
    f.autoUpdater.emitCheck({ isUpdateAvailable: true, updateInfo: { version: "3.17.0" } });
    const first = controller.downloadUpdate();
    const second = controller.downloadUpdate();
    assert.equal(first, second);
    await settle();
    assert.deepEqual(f.autoUpdater.calls, ["download"]);
    rejectDownload(new Error("download offline"));
    assert.equal(await first, false);
    assert.equal(controller.snapshot().phase, "error");
    assert.equal(controller.snapshot().availableVersion, "3.17.0");
    f.autoUpdater.downloadUpdate = async () => { f.autoUpdater.calls.push("retry"); return []; };
    assert.equal(await controller.downloadUpdate(), true);
    assert.deepEqual(f.autoUpdater.calls, ["download", "retry"]);
  });

  it("dedupes simultaneous checks", async () => {
    const f = fixture();
    let finish!: () => void;
    f.autoUpdater.checkForUpdates = () => new Promise((resolve) => {
      f.autoUpdater.calls.push("check");
      finish = () => { f.autoUpdater.emitCheck(f.autoUpdater.checkResult); resolve(f.autoUpdater.checkResult); };
    });
    const controller = await f.create();
    const first = controller.checkForUpdates();
    assert.equal(await controller.checkForUpdates(), false);
    finish();
    assert.equal(await first, true);
    assert.deepEqual(f.autoUpdater.calls, ["check"]);
  });

  it("renderer consent Later never prepares or installs", async () => {
    const f = fixture({ responses: [1, 1] });
    const controller = await f.create();
    f.autoUpdater.emitDownloaded();
    await settle();
    assert.equal(await controller.installUpdate({ confirm: true }), false);
    assert.equal(f.dialogs.length, 2);
    assert.deepEqual(f.order, []);
    assert.deepEqual(f.autoUpdater.calls, []);
    assert.equal(controller.snapshot().phase, "downloaded");
  });

  it("reverts the drained lifecycle and reports a retryable error when quitAndInstall throws", async () => {
    const f = fixture();
    const controller = await f.create();
    f.autoUpdater.emitDownloaded();
    await settle();
    f.autoUpdater.quitAndInstall = () => { f.order.push("install"); throw new Error("no installer"); };
    assert.equal(await controller.installUpdate({ confirm: false }), false);
    assert.deepEqual(f.order, ["prepare", "install", "revert"]);
    assert.equal(controller.snapshot().phase, "error");
  });

  it("recovers the app when quitAndInstall returns but never exits (silent handoff failure)", async () => {
    const f = fixture();
    const controller = await f.create({ installWatchdogMs: 30 });
    f.autoUpdater.emitDownloaded();
    await settle();
    assert.equal(await controller.installUpdate({ confirm: false }), true);
    assert.equal(controller.snapshot().phase, "installing");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(f.order, ["prepare", "revert"]);
    assert.equal(controller.snapshot().phase, "error");
    assert.match(controller.snapshot().error, /installer did not start/);
  });

  it("disposes the install watchdog so a late quit does not recover", async () => {
    const f = fixture();
    const controller = await f.create({ installWatchdogMs: 30 });
    f.autoUpdater.emitDownloaded();
    await settle();
    await controller.installUpdate({ confirm: false });
    controller.dispose();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(f.order, ["prepare"]);
  });

  it("restores downloaded when preparation refuses and orders native installation", async () => {
    const f = fixture();
    let allow = false;
    const controller = await f.create({ prepareForInstall: async () => { f.order.push("prepare"); return allow; } });
    f.autoUpdater.emitDownloaded();
    await settle();
    assert.equal(await controller.installUpdate({ confirm: false }), false);
    assert.equal(controller.snapshot().phase, "downloaded");
    f.autoUpdater.quitAndInstall = () => { f.order.push("install"); };
    allow = true;
    assert.equal(await controller.installUpdate({ confirm: false }), true);
    assert.deepEqual(f.order, ["prepare", "prepare", "install"]);
  });

  it("claims once, unsubscribes, and removes only its updater listeners", async () => {
    const f = fixture();
    const otherListener = () => {};
    f.autoUpdater.on("error", otherListener);
    const controller = await f.create();
    let changes = 0;
    const unsubscribe = controller.onState(() => { changes++; });
    controller.markUpdated("3.17.0");
    assert.equal(controller.claimNotice(), "3.17.0");
    assert.equal(controller.claimNotice(), null);
    assert.equal(changes, 2);
    unsubscribe();
    controller.markUpdated("3.18.0");
    assert.equal(changes, 2);
    controller.dispose();
    assert.deepEqual(f.autoUpdater.eventNames(), ["error"]);
    assert.equal(f.autoUpdater.listenerCount("error"), 1);
    assert.equal(await controller.checkForUpdates(), false);
  });

  it("inactive controller has the complete bridge surface and notice support", async () => {
    const f = fixture();
    const controller = await f.create({ platform: "freebsd" });
    assert.equal(controller.snapshot().phase, "unsupported");
    assert.equal(await controller.downloadUpdate(), false);
    assert.equal(await controller.installUpdate({ confirm: true }), false);
    controller.setAutoDownload(false);
    controller.markUpdated("3.17.0");
    assert.equal(controller.claimNotice(), "3.17.0");
    assert.equal(controller.claimNotice(), null);
    controller.onState(() => {})();
    controller.dispose();
  });

  it("background checks with auto-download off do not open a consent prompt", async () => {
    const f = fixture({ responses: [0] });
    f.autoUpdater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "3.17.0" } };
    const controller = await f.create({ autoDownload: false });
    await controller.checkForUpdates();
    assert.equal(f.dialogs.length, 0);
    assert.equal(controller.snapshot().phase, "available");
    assert.deepEqual(f.autoUpdater.calls, ["check"]);
  });
});

describe("desktop background check wiring", () => {
  it("starts once, unrefs, toggles with autoUpdate and stops", () => {
    const source = readFileSync("desktop/main.mjs", "utf8");
    const functions = source.slice(source.indexOf("function startBackgroundChecks"));
    const timers: { callback: () => void; ms: number; unrefs: number }[] = [];
    const cleared: unknown[] = [];
    const api = runInNewContext(`let updateCheckTimer = null; const UPDATE_CHECK_MS = 21600000; ${functions}; ({startBackgroundChecks, stopBackgroundChecks, onSettingsChanged})`, {
      setInterval: (callback: () => void, ms: number) => {
        const timer = { callback, ms, unrefs: 0, unref() { this.unrefs++; } };
        timers.push(timer);
        return timer;
      },
      clearInterval: (timer: unknown) => cleared.push(timer),
    });
    const modes: boolean[] = [];
    let checks = 0;
    const updater = { active: true, checkForUpdates: () => { checks++; }, setAutoDownload: (enabled: boolean) => modes.push(enabled) };
    const fixture = { changed: ["autoUpdate"], updater, tray: { update() {} }, windows: { broadcast() {} }, supervisor: { snapshot() {} } };
    api.onSettingsChanged({ ...fixture, next: { autoUpdate: true } });
    api.startBackgroundChecks(updater);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 21600000);
    assert.equal(timers[0].unrefs, 1);
    timers[0].callback();
    assert.equal(checks, 1);
    api.onSettingsChanged({ ...fixture, next: { autoUpdate: false } });
    assert.equal(cleared[0], timers[0]);
    api.onSettingsChanged({ ...fixture, next: { autoUpdate: true } });
    assert.equal(timers.length, 2);
    assert.deepEqual(modes, [true, false, true]);
    api.stopBackgroundChecks();
    assert.equal(cleared[1], timers[1]);
  });
});
