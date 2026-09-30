import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { initialUpdateState, reduceUpdateState, UPDATE_PHASES, trayUpdateItem, tooltipSuffix, updatePending } from "../desktop/lib/update-state.mjs";
import { compareVersions, evaluateLaunchVersion } from "../desktop/lib/update-receipt.mjs";
import { isLocalServerUrl } from "../desktop/lib/window-open.mjs";
import { sanitizeSettings } from "../desktop/lib/settings.mjs";

const idle = () => initialUpdateState({ active: true, currentVersion: "3.16.1" });
const available = () => reduceUpdateState(idle(), { type: "available", version: "3.17.0" });

describe("desktop update state", () => {
  it("starts with the complete bridge snapshot in supported and unsupported installs", () => {
    assert.deepEqual(idle(), { active: true, currentVersion: "3.16.1", phase: "idle", availableVersion: null, progress: null, error: null, updatedTo: null, checkedAt: null });
    const inactive = initialUpdateState({ active: false, currentVersion: "3.16.1" });
    assert.equal(inactive.phase, "unsupported");
    assert.equal(reduceUpdateState(inactive, { type: "checking" }), inactive);
  });

  it("reduces every event without mutating the previous state", () => {
    const state = available();
    for (const [event, expected] of [
      [{ type: "checking" }, { phase: "checking" }],
      [{ type: "not-available", at: 123 }, { phase: "current", checkedAt: 123, availableVersion: null, progress: null }],
      [{ type: "available", version: "3.18.0" }, { phase: "available", availableVersion: "3.18.0", progress: null }],
      [{ type: "progress", percent: 41.7 }, { phase: "downloading", progress: 42 }],
      [{ type: "downloaded", version: "3.17.0" }, { phase: "downloaded", progress: 100 }],
      [{ type: "installing" }, { phase: "installing" }],
      [{ type: "install-cancelled" }, { phase: "downloaded" }],
      [{ type: "error", message: "offline" }, { phase: "error", error: "offline", availableVersion: "3.17.0" }],
      [{ type: "updated", version: "3.16.1" }, { phase: "available", updatedTo: "3.16.1" }],
      [{ type: "notice-claimed" }, { phase: "available", updatedTo: null }],
    ] as const) {
      const next = reduceUpdateState(state, event);
      for (const [key, value] of Object.entries(expected)) assert.equal(next[key], value, `${event.type}:${key}`);
    }
    assert.equal(state.phase, "available");
    assert.equal(state.progress, null);
    assert.equal(reduceUpdateState(state, { type: "unknown" }), state);
  });

  it("clamps progress and clears errors on retries", () => {
    for (const [percent, expected] of [[-5, 0], [110, 100], [50.4, 50], [NaN, 0]]) {
      assert.equal(reduceUpdateState(available(), { type: "progress", percent }).progress, expected);
    }
    const failed = reduceUpdateState(available(), { type: "error", message: "offline" });
    assert.equal(reduceUpdateState(failed, { type: "progress", percent: 0 }).error, null);
  });

  it("keeps sticky phases for checking, current, same and older releases; advances only for newer releases", () => {
    for (const phase of ["downloading", "downloaded", "installing"]) {
      const state = { ...available(), phase };
      for (const event of [
        { type: "checking" }, { type: "not-available", at: 123 },
        { type: "available", version: "3.17.0" }, { type: "available", version: "3.16.9" },
        { type: "available", version: "3.17.0-preview.1" },
      ]) assert.equal(reduceUpdateState(state, event), state, `${phase}:${event.type}`);
      const newer = reduceUpdateState(state, { type: "available", version: "3.18.0" });
      assert.equal(newer.phase, "available");
      assert.equal(newer.availableVersion, "3.18.0");
    }
  });

  it("maps every phase to native menu labels, actions and tooltips", () => {
    const rows = [
      ["unsupported", null, null], ["idle", "Check for Updates…", "check"],
      ["checking", "Checking for Updates…", null], ["current", "Up to date (v3.16.1)", "check"],
      ["available", "Download Update v3.17.0", "download"], ["downloading", "Downloading Update v3.17.0… 42%", null],
      ["downloaded", "Restart to Update (v3.17.0)", "install"], ["installing", "Installing Update v3.17.0…", null],
      ["error", "Retry Update v3.17.0", "download"],
    ];
    assert.deepEqual(rows.map(([phase]) => phase), UPDATE_PHASES);
    for (const [phase, label, action] of rows) {
      const state = { ...available(), phase, progress: 42 };
      assert.deepEqual(trayUpdateItem(state), label ? { label, action, enabled: action !== null } : null);
      assert.equal(updatePending(state), ["available", "downloading", "downloaded"].includes(phase));
      const suffix = phase === "downloaded" ? " — Update v3.17.0 ready" : ["available", "downloading"].includes(phase) ? " — Update v3.17.0 available" : "";
      assert.equal(tooltipSuffix(state), suffix);
    }
    assert.equal(trayUpdateItem({ ...idle(), phase: "error" }).action, "check");
  });
});

describe("desktop launch receipt", () => {
  it("compares semver core, prereleases, build metadata and invalid versions", () => {
    for (const [a, b, expected] of [
      ["3.17.0", "3.16.9", 1], ["3.9.0", "3.10.0", -1], ["4.0.0", "3.99.99", 1],
      ["3.17.0", "3.17.0", 0], ["3.17.0", "3.17.0-preview.2", 1],
      ["3.17.0-preview.9", "3.17.0-preview.10", -1], ["3.17.0-alpha", "3.17.0-beta", -1],
      ["3.17.0-1", "3.17.0-alpha", -1], ["3.17.0-alpha", "3.17.0-alpha.1", -1],
      ["3.17.0+build.1", "3.17.0+build.2", 0], ["v3.17.0", "3.17.0", 0], ["invalid", "3.17.0", 0],
    ] as const) assert.equal(compareVersions(a, b), expected, `${a}:${b}`);
  });

  it("reports upgrade once while recording first run, same version and downgrade quietly", () => {
    for (const [lastRunVersion, updatedTo] of [["", null], ["3.16.0", "3.17.0"], ["3.17.0", null], ["3.18.0", null]]) {
      assert.deepEqual(evaluateLaunchVersion({ lastRunVersion, currentVersion: "3.17.0", compare: compareVersions }), { updatedTo, nextLastRunVersion: "3.17.0" });
    }
    assert.equal(sanitizeSettings({}).lastRunVersion, "");
    assert.equal(sanitizeSettings({ lastRunVersion: " 3.17.0 " }).lastRunVersion, "3.17.0");
  });
});

describe("desktop preload update bridge", () => {
  it("exposes the same six update methods in both branches and unsubscribes events", async () => {
    const source = readFileSync("desktop/preload.cjs", "utf8");
    for (const protocol of ["file:", "http:"]) {
      let bridge: Record<string, (...args: unknown[]) => unknown>;
      const calls: unknown[][] = [];
      const handlers = new Map<string, (...args: unknown[]) => void>();
      runInNewContext(source, {
        window: { location: { protocol } }, process: { platform: "darwin", argv: [] },
        require: () => ({
          contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
          ipcRenderer: {
            invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(null); },
            on: (name: string, fn: (...args: unknown[]) => void) => handlers.set(name, fn),
            removeListener: (name: string, fn: (...args: unknown[]) => void) => { assert.equal(handlers.get(name), fn); handlers.delete(name); },
          },
        }),
      });
      for (const method of ["getUpdateState", "checkForUpdates", "downloadUpdate", "installUpdate", "claimUpdateNotice"]) await bridge![method]();
      assert.deepEqual(calls, [["desktop:update:get"], ["desktop:check-updates"], ["desktop:update:download"], ["desktop:update:install"], ["desktop:update:claim-notice"]]);
      const states: unknown[] = [];
      const unsubscribe = bridge!.onUpdateState((state: unknown) => states.push(state)) as () => void;
      handlers.get("desktop:update:state")!(null, idle());
      assert.equal(states.length, 1);
      unsubscribe();
      assert.equal(handlers.size, 0);
      if (protocol === "http:") {
        for (const name of ["saveSettings", "restartServer", "openLogs", "openConfigDir"]) assert.equal(bridge![name], undefined);
      }
    }
  });
});

const ipcHandlers = new Map<string, (event: unknown) => unknown>();
const { registerIpc } = runInNewContext(
  readFileSync("desktop/lib/ipc.mjs", "utf8").replace(/^import .*;$/gm, "").replace("export function", "function") + "; ({ registerIpc })",
  { BrowserWindow: {}, app: {}, shell: {}, isLocalServerUrl, ipcMain: { handle: (name: string, fn: (event: unknown) => unknown) => ipcHandlers.set(name, fn) } },
);

describe("desktop update IPC trust and install consent", () => {
  it("allows file and served origins, rejects remote senders and always requests install confirmation", () => {
    const calls: unknown[] = [];
    registerIpc({
      settingsStore: {}, supervisor: { url: "http://127.0.0.1:3333" }, info: {},
      actions: {
        updateState: () => idle(), downloadUpdate: () => true, claimUpdateNotice: () => null,
        checkForUpdates: () => true, installUpdate: (options: unknown) => { calls.push(options); return false; },
      },
    });
    for (const channel of ["desktop:update:get", "desktop:update:download", "desktop:update:install", "desktop:update:claim-notice", "desktop:check-updates"]) {
      const handle = ipcHandlers.get(channel)!;
      for (const url of ["file:///desktop/pages/tray.html", "http://127.0.0.1:3333/"]) handle({ senderFrame: { url } });
      assert.throws(() => handle({ senderFrame: { url: "https://example.com" } }), /untrusted sender/);
      assert.throws(() => handle({ senderFrame: { url: "http://127.0.0.1:4444/" } }), /untrusted sender/);
    }
    assert.equal(JSON.stringify(calls), JSON.stringify([{ confirm: true }, { confirm: true }]));
  });
});


describe("desktop application menu updates", () => {
  it("routes install from each platform's native menu without renderer confirmation", () => {
    const source = readFileSync("desktop/lib/menu.mjs", "utf8");
    for (const platform of ["darwin", "win32", "linux"]) {
      let template: { label: string; submenu: { label: string; click: () => void }[] }[] = [];
      const { installApplicationMenu } = runInNewContext(
        source.replace(/^import .*;$/gm, "").replace("export function", "function") + "; ({ installApplicationMenu })",
        {
          process: { platform }, app: { name: "ima2" }, webContents: {}, trayUpdateItem,
          editMenu: () => ({ label: "Edit", submenu: [] }),
          Menu: { buildFromTemplate: (value: typeof template) => value, setApplicationMenu: (value: typeof template) => { template = value; } },
        },
      );
      const calls: unknown[] = [];
      installApplicationMenu({ installUpdate: (options: unknown) => calls.push(options) }, { ...available(), phase: "downloaded" });
      const items = template.find((item) => item.label === (platform === "darwin" ? "ima2" : "Server"))!.submenu;
      const updateIndex = items.findIndex((item) => item.label === "Restart to Update (v3.17.0)");
      assert.ok(updateIndex >= 0);
      if (platform !== "darwin") assert.equal(items[updateIndex + 1].label, "Open Server Log");
      items[updateIndex].click();
      assert.equal(JSON.stringify(calls), JSON.stringify([{ confirm: false }]));
      installApplicationMenu({}, initialUpdateState({ active: false, currentVersion: "3.16.1" }));
      assert.equal(template.flatMap((item) => item.submenu ?? []).some((item) => item.label?.includes("Update")), false);
    }
  });
});
