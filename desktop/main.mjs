import { app, clipboard, dialog, Menu, Notification, shell } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSettingsStore } from "./lib/settings.mjs";
import { resolveIconPaths } from "./lib/icons.mjs";
import { ServerSupervisor } from "./lib/server.mjs";
import { WindowManager } from "./lib/windows.mjs";
import { TrayController } from "./lib/tray.mjs";
import { TrayPopup } from "./lib/tray-popup.mjs";
import { collectTraySnapshot } from "./lib/tray-data.mjs";
import { createLoginItem } from "./lib/login-item.mjs";
import { installApplicationMenu } from "./lib/menu.mjs";
import { installContextMenus } from "./lib/context-menu.mjs";
import { installPopupPolicy } from "./lib/window-open.mjs";
import { registerIpc } from "./lib/ipc.mjs";
import { wireAppLifecycle } from "./lib/app-lifecycle.mjs";
import { createUpdaterController } from "./lib/updater.mjs";
import { evaluateLaunchVersion, compareVersions } from "./lib/update-receipt.mjs";
import { launchOrigin } from "./lib/launch-origin.mjs";
import { askTakeover } from "./lib/takeover-prompt.mjs";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(desktopDir, "..");
const isMac = process.platform === "darwin";
const buildDir = join(desktopDir, "build");
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
let updateCheckTimer = null;

app.setName("ima2");
if (process.platform === "win32") app.setAppUserModelId("com.lidge.ima2");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void boot();
}

async function boot() {
  await app.whenReady();
  const icons = await resolveIconPaths({
    buildDir, fallbackDir: join(app.getPath("userData"), "icons"), log: (line) => console.warn(line),
  });
  const settingsStore = createSettingsStore(app.getPath("userData"));
  const settings0 = settingsStore.get();
  const launch = evaluateLaunchVersion({ lastRunVersion: settings0.lastRunVersion, currentVersion: app.getVersion(), compare: compareVersions });
  settingsStore.update({ lastRunVersion: launch.nextLastRunVersion });
  const origin = launchOrigin(process.argv, isMac ? app.getLoginItemSettings() : {});
  // "Start hidden" means "stay in the tray when the OS launches ima2 at login" —
  // a manual launch is an explicit request for the window and always shows it
  // (cli-jaw passes its --background flag only through the login item's args).
  const startHiddenAtLogin = settings0.startHidden && origin === "login";
  const { supervisor, windows, popup } = createRuntime(settingsStore, icons, origin);
  const loginItem = createLoginItem({ app });
  const lifecycle = wireAppLifecycle({ supervisor, windows, settingsStore, applyDockVisibility, app });
  const updater = await createUpdaterController({
    app, dialog, prepareForInstall: () => lifecycle.prepareForUpdateInstall(),
    revertInstall: () => lifecycle.abortUpdateInstall(), autoDownload: settings0.autoUpdate,
  });
  if (launch.updatedTo) updater.markUpdated(launch.updatedTo);
  const actions = createActions({ settingsStore, supervisor, windows, popup, updater });
  const tray = new TrayController({ iconPath: icons.trayIcon, updateIconPath: icons.trayUpdateIcon, actions });
  windows.onHiddenToTray = hiddenTrayNotifier(tray);
  wireDesktop({ settingsStore, supervisor, windows, popup, updater, actions, tray, loginItem });
  // One announcement per update: the app window's toast when it opens, the OS notification when
  // the app starts hidden. Claiming here keeps the toast from repeating it; the tray keeps
  // "What's New" either way.
  if (launch.updatedTo && startHiddenAtLogin) {
    updater.claimNotice();
    showUpdatedNotification(launch.updatedTo, actions);
  }
  if (settings0.openAtLogin) applyLoginItem(loginItem, settingsStore.get());
  applyDockVisibility(settingsStore.get(), windows);
  if (!existsSync(join(rootDir, "server.js"))) {
    dialog.showErrorBox("ima2 server build missing", `server.js not found in ${rootDir}.\nRun: npm run build:server && npm run ui:build`);
  }
  if (!startHiddenAtLogin) windows.showMain();
  await supervisor.start(settingsStore.get());
  if (settingsStore.get().autoUpdate) {
    void updater.checkForUpdates();
    startBackgroundChecks(updater);
  }
}

function createRuntime(settingsStore, icons, origin) {
  let windows;
  const popup = new TrayPopup();
  const supervisor = new ServerSupervisor({
    rootDir, isPackaged: app.isPackaged, logFile: join(app.getPath("logs"), "server.log"),
    origin,
    askTakeover: async (status) => {
      const answer = await askTakeover({ dialog, status, parent: windows?.main ?? null });
      if (answer.remember) settingsStore.update({ existingServer: answer.approve ? "takeover" : "attach" });
      return answer;
    },
  });
  windows = new WindowManager({
    iconPath: icons.appIcon, getServerUrl: () => supervisor.url, getSettings: () => settingsStore.get(),
    onVisibilityChange: () => {
      if (!windows.main && !windows.settings && !settingsStore.get().keepRunningOnClose) popup.release();
      applyDockVisibility(settingsStore.get(), windows);
    },
  });
  return { supervisor, windows, popup };
}

function hiddenTrayNotifier(tray) {
  let shown = false;
  return () => {
    if (shown) return;
    shown = true;
    tray.notifyStillRunning();
  };
}

function createActions({ settingsStore, supervisor, windows, popup, updater }) {
  const configDir = () => settingsStore.get().configDir || process.env.IMA2_CONFIG_DIR || join(homedir(), ".ima2");
  return {
    openApp: () => { if (isMac) app.dock?.show(); windows.showMain(); },
    openInBrowser: () => { if (supervisor.url) void shell.openExternal(supervisor.url); },
    openGenerated: () => shell.openPath(join(configDir(), "generated")),
    openLogs: () => shell.openPath(supervisor.logFile),
    openSettings: () => windows.showSettings(),
    openUrl: (url) => shell.openExternal(url),
    openReleaseNotes: (version) => shell.openExternal(`https://github.com/lidge-ai/ima2-gen/releases/tag/v${version}`),
    restartServer: () => supervisor.restart(settingsStore.get()),
    useBundledServer: () => supervisor.useBundledServer(settingsStore.get()),
    checkForUpdates: () => updater.checkForUpdates({ manual: true }),
    downloadUpdate: () => updater.downloadUpdate(),
    installUpdate: (options) => updater.installUpdate(options),
    updateState: () => updater.snapshot(),
    claimUpdateNotice: () => updater.claimNotice(),
    updaterActive: updater.active,
    configDir, quit: () => app.quit(),
    toggleTrayPopup: (bounds) => popup.toggle(bounds),
    showTrayPopup: (bounds) => popup.show(bounds),
    hideTrayPopup: () => popup.hide(),
    traySnapshot: () => collectTraySnapshot({ status: supervisor.snapshot() }),
    setOpenAtLogin: (enabled) => settingsStore.update({ openAtLogin: enabled === true }),
  };
}

function wireDesktop({ settingsStore, supervisor, windows, popup, updater, actions, tray, loginItem }) {
  app.on("before-quit", () => {
    stopBackgroundChecks();
    updater.dispose();
    popup.destroy();
  });
  tray.create();
  tray.update({ settings: settingsStore.get() });
  const pushUpdateState = (state) => {
    tray.setUpdateState(state);
    installApplicationMenu(actions, state);
    windows.broadcast("desktop:update:state", state);
    popup.win?.webContents.send("desktop:update:state", state);
  };
  updater.onState(pushUpdateState);
  pushUpdateState(updater.snapshot());
  installContextMenus({ app, Menu, clipboard, dialog, shell });
  installPopupPolicy({ app, shell, getServerUrl: () => supervisor.url });
  registerIpc({ settingsStore, supervisor, actions, info: { rootDir, logFile: supervisor.logFile } });
  supervisor.on("status", (status) => {
    tray.update({ status });
    windows.broadcast("desktop:status", status);
    popup.win?.webContents.send("desktop:status", status);
    windows.syncMainContent();
  });
  settingsStore.onChange((next, changed) => onSettingsChanged({ next, changed, supervisor, tray, windows, updater, loginItem }));
}

function startBackgroundChecks(updater) {
  if (updateCheckTimer || !updater.active) return;
  updateCheckTimer = setInterval(() => void updater.checkForUpdates(), UPDATE_CHECK_MS);
  updateCheckTimer.unref();
}

function stopBackgroundChecks() {
  clearInterval(updateCheckTimer);
  updateCheckTimer = null;
}

function showUpdatedNotification(version, actions) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: `ima2 updated to v${version}`, body: "See what's new" });
  notification.on("click", () => actions.openReleaseNotes(version));
  notification.show();
}

function onSettingsChanged({ next, changed, supervisor, tray, windows, updater, loginItem }) {
  tray.update({ settings: next });
  if (changed.includes("autoUpdate")) {
    updater.setAutoDownload(next.autoUpdate);
    if (next.autoUpdate) startBackgroundChecks(updater);
    else stopBackgroundChecks();
  }
  windows.broadcast("desktop:status", supervisor.snapshot());
  if (changed.includes("openAtLogin") || changed.includes("startHidden")) applyLoginItem(loginItem, next);
  if (changed.includes("menubarOnly")) applyDockVisibility(next, windows);
  const needsRestart = ["port", "devLogging", "nodeBinary", "configDir"];
  if (changed.some((k) => needsRestart.includes(k))) void supervisor.restart(next);
}

function applyLoginItem(loginItem, settings) {
  if (!app.isPackaged) return;
  try {
    loginItem.set(settings.openAtLogin, { hidden: settings.startHidden === true });
  } catch (error) {
    console.warn(`[desktop] login item update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function applyDockVisibility(settings, windows) {
  if (!isMac || !app.dock) return;
  if (settings.menubarOnly && !windows.hasVisibleWindow()) app.dock.hide();
  else app.dock.show();
}
