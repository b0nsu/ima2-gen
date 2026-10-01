import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { popupGeometry, trayAnchor, POPUP_WIDTH, POPUP_HEIGHT } from "../desktop/lib/tray-geometry.mjs";
import { createLoginItem, linuxAutostartEntry, linuxAutostartFile } from "../desktop/lib/login-item.mjs";
import { collectTraySnapshot } from "../desktop/lib/tray-data.mjs";
import { trayIconName } from "../desktop/lib/icons.mjs";
import { runInNewContext } from "node:vm";
import { describeLauncher } from "../desktop/lib/takeover-prompt.mjs";
import { updatePending, trayUpdateItem, tooltipSuffix } from "../desktop/lib/update-state.mjs";
import sharp from "sharp";
import { initialUpdateState, reduceUpdateState } from "../desktop/lib/update-state.mjs";
import { encodeIco, generateIcons } from "../desktop/scripts/make-icons.mjs";

const fhd = { x: 0, y: 0, width: 1920, height: 1040 };

describe("tray popup geometry", () => {
  it("opens above a bottom taskbar tray icon, centered and clamped to the right edge", () => {
    const g = popupGeometry({ x: 1800, y: 1060 }, fhd);
    assert.equal(g.width, POPUP_WIDTH);
    assert.equal(g.height, POPUP_HEIGHT);
    assert.equal(g.x, 1920 - 8 - POPUP_WIDTH);
    assert.equal(g.y, 1040 - 8 - POPUP_HEIGHT);
  });

  it("opens below a top panel icon", () => {
    const g = popupGeometry({ x: 900, y: 12 }, { x: 0, y: 28, width: 1920, height: 1052 });
    assert.equal(g.x, 900 - POPUP_WIDTH / 2);
    assert.equal(g.y, 28 + 8);
  });

  it("stays inside a secondary display with negative origin and shrinks on tiny work areas", () => {
    const area = { x: -1280, y: 0, width: 1280, height: 400 };
    const g = popupGeometry({ x: -10, y: 390 }, area);
    assert.ok(g.x >= area.x + 8 && g.x + g.width <= area.x + area.width - 8);
    assert.equal(g.height, 400 - 16);
    assert.equal(g.y, 8);
  });

  it("falls back to the work area's bottom-right corner when the tray host reports no rect", () => {
    assert.deepEqual(trayAnchor({ x: 0, y: 0, width: 0, height: 0 }, fhd), { x: 1920, y: 1040 });
    assert.deepEqual(trayAnchor({ x: 10, y: 20, width: 20, height: 40 }, fhd), { x: 20, y: 40 });
  });
});

describe("login item", () => {
  it("writes and removes an XDG autostart entry on Linux, preferring $APPIMAGE", () => {
    const home = mkdtempSync(join(tmpdir(), "ima2-autostart-"));
    const env = { XDG_CONFIG_HOME: home, APPIMAGE: "/opt/apps/ima2 1.0.AppImage" };
    const item = createLoginItem({ app: {}, platform: "linux", env, execPath: "/tmp/.mount_x/ima2" });
    const file = linuxAutostartFile(env);
    assert.equal(file, join(home, "autostart", "ima2.desktop"));
    assert.equal(item.isEnabled(), false);
    item.set(true);
    assert.equal(item.isEnabled(), true);
    assert.match(readFileSync(file, "utf8"), /^Exec="\/opt\/apps\/ima2 1\.0\.AppImage" --autostart$/m);
    item.set(false);
    assert.equal(existsSync(file), false);
  });

  it("uses Electron login item settings on Windows and macOS", () => {
    const calls: unknown[] = [];
    let open = false;
    const app = {
      getLoginItemSettings: (q?: { args?: string[] }) => ({ openAtLogin: open && q?.args?.[0] === "--autostart" }),
      setLoginItemSettings: (s: { openAtLogin: boolean }) => { calls.push(s); open = s.openAtLogin; },
    };
    const item = createLoginItem({ app, platform: "win32" });
    item.set(true);
    item.set(true);
    assert.deepEqual(calls, [{ openAtLogin: true, args: ["--autostart"] }]);
    assert.equal(item.isEnabled(), true);
  });

  it("passes openAsHidden through on macOS only", () => {
    const calls: unknown[] = [];
    let state = { openAtLogin: false, openAsHidden: false };
    const app = {
      getLoginItemSettings: () => state,
      setLoginItemSettings: (s: { openAtLogin: boolean; openAsHidden: boolean }) => { calls.push(s); state = s; },
    };
    const item = createLoginItem({ app, platform: "darwin" });
    item.set(true, { hidden: true });
    item.set(true, { hidden: true });
    item.set(true, { hidden: false });
    assert.deepEqual(calls, [{ openAtLogin: true, openAsHidden: true }, { openAtLogin: true, openAsHidden: false }]);
  });

  it("leaves plain exec paths unquoted", () => {
    assert.match(linuxAutostartEntry("/usr/bin/ima2"), /^Exec=\/usr\/bin\/ima2 --autostart$/m);
  });
});

describe("tray snapshot", () => {
  it("returns only status when the server is not running", async () => {
    const snap = await collectTraySnapshot({ status: { state: "starting", url: null }, fetchImpl: () => { throw new Error("no fetch"); } });
    assert.deepEqual(snap.jobs, []);
    assert.deepEqual(snap.recent, []);
  });

  it("maps inflight jobs and recent history to absolute loopback URLs", async () => {
    const base = "http://127.0.0.1:3333";
    const fetchImpl = async (url: string) => ({
      ok: true,
      json: async () => url.includes("/api/inflight")
        ? { jobs: [{ requestId: "r1", kind: "classic", prompt: "cat", phase: "streaming", startedAt: 5 }] }
        : { items: [{ filename: "a.png", url: "/generated/a.png", thumb: "/generated/.thumbs/a.jpg", createdAt: 1 }, { filename: "b.mp4", url: "/generated/b.mp4" }] },
    });
    const snap = await collectTraySnapshot({ status: { state: "running", url: base }, fetchImpl });
    assert.equal(snap.jobs[0].phase, "streaming");
    assert.equal(snap.recent[0].thumb, `${base}/generated/.thumbs/a.jpg`);
    assert.equal(snap.recent[1].isVideo, true);
    assert.equal(snap.error, null);
  });
});

describe("platform tray icons", () => {
  it("uses ICO on Windows, PNG on Linux and the template image on macOS", () => {
    assert.equal(trayIconName("win32"), "tray.ico");
    assert.equal(trayIconName("win32", { update: true }), "tray-update.ico");
    assert.equal(trayIconName("linux", { update: true }), "tray-update.png");
    assert.equal(trayIconName("darwin"), "trayTemplate.png");
    assert.equal(trayIconName("darwin", { update: true }), "trayUpdateTemplate.png");
  });

  it("encodes a PNG-framed ICO directory", () => {
    const png = Buffer.from([1, 2, 3]);
    const ico = encodeIco([{ size: 16, png }, { size: 256, png }]);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico.readUInt8(6), 16);
    assert.equal(ico.readUInt8(22), 0);
    assert.equal(ico.readUInt32LE(6 + 12), 6 + 32);
    assert.equal(ico.length, 6 + 32 + 6);
  });
});


it("generates update templates with opaque black dots and a transparent clearance ring", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ima2-update-icons-"));
  try {
    await generateIcons(dir);
    for (const [name, size] of [["trayUpdateTemplate.png", 22], ["trayUpdateTemplate@2x.png", 44]] as const) {
      const file = join(dir, name);
      assert.equal(existsSync(file), true);
      const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, size);
      assert.equal(info.height, size);
      const r = size === 22 ? 4 : 8;
      const cx = size - r - 1;
      const cy = r + 1;
      const pixel = (x: number, y: number) => [...data.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
      assert.deepEqual(pixel(cx, cy), [0, 0, 0, 255]);
      assert.equal(pixel(cx - r - 1, cy + (size === 22 ? 2 : 0))[3], 0, `${name}: transparent gap`);
      // The 1px ring at 22px has antialiased edges; 44px has a fully clear interior.
      assert.ok(pixel(cx - r - 1, cy)[3] <= 16, `${name}: clearing circle separates glyph from dot`);
      assert.ok(data.some((value, i) => i % 4 === 3 && value === 255 && Math.floor(i / 4) % size < cx - r - 2), `${name}: glyph preserved`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

class FakeTray {
  images: unknown[] = [];
  tooltip = "";
  constructor(public image: unknown) {}
  setToolTip(text: string) { this.tooltip = text; }
  setContextMenu() {}
  on() {}
  setImage(image: unknown) { this.images.push(image); }
}
const { TrayController } = runInNewContext(
  readFileSync("desktop/lib/tray.mjs", "utf8").replace(/^import .*;$/gm, "").replace("export class", "class") + "; ({ TrayController })",
  {
    process, describeLauncher, initialUpdateState, updatePending, trayUpdateItem, tooltipSuffix,
    Tray: FakeTray, Menu: { buildFromTemplate: (template: unknown) => template },
    nativeImage: { createFromPath: (path: string) => ({ path, template: false, setTemplateImage(value: boolean) { this.template = value; } }) },
  },
);

it("keeps Open ima2 enabled even when the server is stopped or in error", () => {
  const tray = new TrayController({ iconPath: "i", updateIconPath: "u", actions: { openApp() {} }, platform: "win32" });
  for (const state of ["stopped", "error", "starting", "running"]) {
    tray.status = { state, url: null } as never;
    const open = tray.menuTemplate().find((item: { label?: string }) => item.label === "Open ima2");
    assert.ok(open, `no Open ima2 item for state ${state}`);
    assert.notEqual(open.enabled, false, `Open ima2 must stay enabled in state ${state}`);
  }
});

it("swaps pending icons on every platform and keeps native actions and release notes after notice claim", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const calls: unknown[] = [];
    const actions = {
      updaterActive: true, checkForUpdates: () => calls.push("check"), downloadUpdate: () => calls.push("download"),
      installUpdate: (options: unknown) => calls.push(options), openReleaseNotes: (version: string) => calls.push(version),
    };
    const tray = new TrayController({ iconPath: "normal", updateIconPath: "update", actions, platform });
    const native = tray.create() as FakeTray;
    const state = initialUpdateState({ active: true, currentVersion: "3.16.1" });
    tray.setUpdateState(state);
    tray.updateMenuItems()[0].click();
    const available = reduceUpdateState(state, { type: "available", version: "3.17.0" });
    tray.setUpdateState(available);
    tray.updateMenuItems()[0].click();
    assert.equal(native.images.length, 1);
    assert.equal((native.images[0] as { path: string }).path, "update");
    assert.equal((native.images[0] as { template: boolean }).template, platform === "darwin");
    assert.match(native.tooltip, /Update v3.17.0 available/);
    tray.setUpdateState(reduceUpdateState(available, { type: "downloaded", version: "3.17.0" }));
    assert.equal(native.images.length, 1);
    assert.match(native.tooltip, /Update v3.17.0 ready/);
    tray.updateMenuItems()[0].click();
    tray.setUpdateState({ ...state, updatedTo: "3.17.0" });
    tray.setUpdateState(state);
    tray.updateMenuItems()[1].click();
    assert.equal(JSON.stringify(calls), JSON.stringify(["check", "download", { confirm: false }, "3.17.0"]));
    assert.equal(native.images.length, 2);
  }
});
