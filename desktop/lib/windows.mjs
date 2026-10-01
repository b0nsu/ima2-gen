import { BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isExternalWebUrl, isLocalServerUrl, resolveWindowOpen } from "./window-open.mjs";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const PRELOAD = join(desktopDir, "preload.cjs");
const LOADING_PAGE = join(desktopDir, "pages", "loading.html");
const SETTINGS_PAGE = join(desktopDir, "pages", "settings.html");

// The web UI draws the title row itself (ui/src/styles/top-strip.css, --chrome-top-h).
// The traffic lights sit inside it: x clears the toggle-left air, y centers the
// ~14px-tall cluster in the 40px row. Pinned by tests/desktop-titlebar-contract.test.ts.
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 13 };

// Windows gets min/max/close painted into the same 40px row via the Window
// Controls Overlay: a transparent background lets the web strip show through,
// symbols match --text-muted. autoHideMenuBar hides the native menu row (bare
// Alt doesn't reveal it on frameless windows — Electron #9990); menu commands
// remain reachable via accelerators.
const TITLE_BAR_OVERLAY = { height: 40, color: "#00000000", symbolColor: "#90909d" };

// A crashed renderer gets a bounded reload instead of a dead window; the
// loading page (not a server URL) is what needs recovering after a crash.
const RELOAD_BUDGET = { count: 3, windowMs: 60_000, delayMs: 250 };

export class WindowManager {
  constructor({ getServerUrl, getSettings, iconPath, onVisibilityChange, onHiddenToTray }) {
    this.getServerUrl = getServerUrl;
    this.getSettings = getSettings;
    this.iconPath = iconPath;
    this.onVisibilityChange = onVisibilityChange ?? (() => {});
    this.onHiddenToTray = onHiddenToTray ?? (() => {});
    this.main = null;
    this.settings = null;
    this.quitting = false;
    this.rendererReloads = [];
  }

  #webPreferences() {
    return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true };
  }

  #baseOptions(extra) {
    return {
      show: false,
      backgroundColor: "#111214",
      icon: this.iconPath,
      webPreferences: this.#webPreferences(),
      ...extra,
    };
  }

  showMain() {
    if (this.main && !this.main.isDestroyed()) {
      if (this.main.isMinimized()) this.main.restore();
      this.main.show();
      this.main.focus();
      return this.main;
    }
    const win = new BrowserWindow(this.#baseOptions({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: "ima2",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : process.platform === "win32" ? "hidden" : "default",
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
      ...(process.platform === "win32" ? { titleBarOverlay: TITLE_BAR_OVERLAY, autoHideMenuBar: true } : {}),
    }));
    this.main = win;
    win.show();
    win.on("close", () => {
      if (this.quitting || !this.getSettings().keepRunningOnClose) return;
      // cli-jaw does the same: the window is destroyed, the server keeps running
      // in the tray, and reopening recreates the window (which re-syncs to the
      // live server) instead of idling a hidden renderer.
      this.onHiddenToTray();
    });
    win.on("closed", () => {
      this.main = null;
      this.onVisibilityChange();
    });
    win.on("hide", () => this.onVisibilityChange());
    win.on("show", () => this.onVisibilityChange());
    const contents = win.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      const outcome = resolveWindowOpen(url, this.getServerUrl());
      if (outcome === "allow") return { action: "allow" };
      if (outcome === "external") void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (e, url) => {
      if (isLocalServerUrl(url, this.getServerUrl()) || url.startsWith("file:")) return;
      e.preventDefault();
      if (isExternalWebUrl(url)) void shell.openExternal(url);
    });
    // A server that is up but fails the page load would otherwise leave Chromium's error
    // page with no way back; show the loading screen (and its restart/log actions) instead.
    contents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || String(url).startsWith("file:")) return;
      void contents.loadFile(LOADING_PAGE);
    });
    contents.on("render-process-gone", (_e, details) => {
      if (details.reason === "clean-exit" || details.reason === "killed") return;
      const now = Date.now();
      this.rendererReloads = this.rendererReloads.filter((t) => now - t < RELOAD_BUDGET.windowMs);
      if (this.rendererReloads.length >= RELOAD_BUDGET.count) return;
      this.rendererReloads.push(now);
      setTimeout(() => { if (!win.isDestroyed()) contents.reload(); }, RELOAD_BUDGET.delayMs);
    });
    this.syncMainContent();
    return win;
  }

  /** Point the main window at the live server once it is up, else the loading page. */
  syncMainContent() {
    const win = this.main;
    if (!win || win.isDestroyed()) return;
    const contents = win.webContents;
    const url = this.getServerUrl();
    const current = contents.getURL();
    if (url) {
      if (!current.startsWith(url)) void contents.loadURL(url);
      return;
    }
    if (!current.startsWith("file:")) void contents.loadFile(LOADING_PAGE);
  }

  #allContents() {
    return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => w.webContents);
  }

  showSettings() {
    if (this.settings && !this.settings.isDestroyed()) {
      this.settings.show();
      this.settings.focus();
      return this.settings;
    }
    const win = new BrowserWindow(this.#baseOptions({
      width: 520,
      height: 780,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "ima2 Settings",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    }));
    this.settings = win;
    win.setMenuBarVisibility(false);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => { this.settings = null; this.onVisibilityChange(); });
    void win.loadFile(SETTINGS_PAGE);
    return win;
  }

  broadcast(channel, payload) {
    for (const contents of this.#allContents()) contents.send(channel, payload);
  }

  hideAll() {
    for (const win of BrowserWindow.getAllWindows()) win.hide();
  }

  hasVisibleWindow() {
    return BrowserWindow.getAllWindows().some((w) => w.isVisible());
  }

  closeAllForQuit() {
    this.quitting = true;
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
  }
}
