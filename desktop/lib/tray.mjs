import { Menu, Tray, nativeImage } from "electron";
import { initialUpdateState, updatePending, trayUpdateItem, tooltipSuffix } from "./update-state.mjs";
import { describeLauncher } from "./takeover-prompt.mjs";

const STATE_LABEL = {
  starting: "Starting server…",
  running: "Server running",
  stopped: "Server stopped",
  error: "Server error",
};

function loadTrayIcon(iconPath, platform) {
  const img = nativeImage.createFromPath(iconPath);
  if (platform === "darwin") img.setTemplateImage(true);
  return img;
}

/**
 * Tray gestures follow the opencodex desktop shell:
 *   Windows  left click toggles the status popup, double click opens the window, right click the menu.
 *   Linux    StatusNotifier hosts rarely deliver clicks, so the menu is the whole interaction and
 *            carries a "Show Status" entry for the popup.
 *   macOS    the menu opens on click (NSStatusItem), also with a "Show Status" entry.
 */
export class TrayController {
  constructor({ iconPath, updateIconPath, actions, platform = process.platform }) {
    this.iconPath = iconPath;
    this.updateIconPath = updateIconPath ?? iconPath;
    this.actions = actions;
    this.platform = platform;
    this.tray = null;
    this.status = { state: "stopped", url: null, external: false };
    this.settings = {};
    this.updateState = initialUpdateState({ active: Boolean(actions.updaterActive), currentVersion: "" });
    this.whatsNew = null;
  }

  create() {
    if (this.tray) return this.tray;
    this.tray = new Tray(loadTrayIcon(updatePending(this.updateState) ? this.updateIconPath : this.iconPath, this.platform));
    this.tray.setToolTip("ima2");
    if (this.platform === "win32") {
      this.tray.on("click", () => this.actions.toggleTrayPopup?.(this.bounds()));
      this.tray.on("double-click", () => {
        this.actions.hideTrayPopup?.();
        this.actions.openApp();
      });
    } else if (this.platform === "linux") {
      this.tray.on("click", () => this.actions.openApp());
    }
    this.render();
    return this.tray;
  }

  bounds() {
    try {
      return this.tray?.getBounds() ?? null;
    } catch {
      return null;
    }
  }

  update({ status, settings }) {
    if (status) this.status = status;
    if (settings) this.settings = settings;
    this.render();
  }

  setUpdateState(state) {
    const changed = updatePending(this.updateState) !== updatePending(state);
    this.updateState = { ...state };
    if (state.updatedTo) this.whatsNew = state.updatedTo;
    if (this.tray && changed) {
      this.tray.setImage(loadTrayIcon(updatePending(state) ? this.updateIconPath : this.iconPath, this.platform));
    }
    this.render();
  }

  updateMenuItems() {
    const item = trayUpdateItem(this.updateState);
    const actionMap = {
      check: () => this.actions.checkForUpdates(),
      download: () => this.actions.downloadUpdate(),
      install: () => this.actions.installUpdate({ confirm: false }),
    };
    const version = this.updateState.updatedTo || this.whatsNew;
    return [
      ...(item ? [{ label: item.label, enabled: item.enabled, click: actionMap[item.action] }] : []),
      ...(version ? [{ label: `What's New in v${version}`, click: () => this.actions.openReleaseNotes(version) }] : []),
    ];
  }

  statusLine() {
    const { state, url, guest, lastError, stoppedBy } = this.status;
    if (state === "running" && url) {
      const owner = guest ? ` (${describeLauncher(guest.launcher, guest.serviceManaged).toLowerCase()})` : "";
      return `${STATE_LABEL.running} · ${url.replace(/^https?:\/\//, "")}${owner}`;
    }
    if (state === "error" && lastError) return `${STATE_LABEL.error}: ${lastError}`;
    if (state === "stopped" && stoppedBy === "cli") return "Server stopped (ima2 stop)";
    return STATE_LABEL[state] ?? state;
  }

  menuTemplate() {
    const running = this.status.state === "running";
    const guest = this.status.ownership === "guest" ? this.status.guest : null;
    return [
      { label: this.statusLine(), enabled: false },
      { type: "separator" },
      { label: "Show Status", click: () => this.actions.showTrayPopup?.(this.bounds()) },
      { label: "Open ima2", click: () => this.actions.openApp(), enabled: running || this.status.state === "starting" },
      { label: "Open in Browser", click: () => this.actions.openInBrowser(), enabled: running },
      { label: "Open Generated Folder", click: () => this.actions.openGenerated() },
      { type: "separator" },
      { label: "Start at Login", type: "checkbox", checked: Boolean(this.settings.openAtLogin), click: (item) => this.actions.setOpenAtLogin?.(item.checked) },
      { label: "Use Bundled Server", visible: Boolean(guest), enabled: Boolean(guest && !guest.takeoverBlocker), click: () => this.actions.useBundledServer?.() },
      { label: this.status.state === "stopped" ? "Start Server" : "Restart Server", click: () => this.actions.restartServer(), enabled: !guest },
      { label: "Open Server Log", click: () => this.actions.openLogs() },
      { type: "separator" },
      ...this.updateMenuItems(),
      { label: "Settings…", click: () => this.actions.openSettings() },
      { type: "separator" },
      { label: "Quit ima2", click: () => this.actions.quit() },
    ];
  }

  render() {
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate(this.menuTemplate()));
    this.tray.setToolTip(`ima2 — ${this.statusLine()}${tooltipSuffix(this.updateState)}`.slice(0, 127));
  }

  /** One-time Windows balloon explaining that closing the window keeps ima2 in the tray. */
  notifyStillRunning() {
    if (!this.tray || this.platform !== "win32") return;
    this.tray.displayBalloon({
      iconType: "info",
      title: "ima2 is still running",
      content: "The local server keeps running in the notification area. Right-click the tray icon to quit.",
    });
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
}
