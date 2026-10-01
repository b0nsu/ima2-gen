import { initialUpdateState, reduceUpdateState } from "./update-state.mjs";

const UPDATE_DOWNLOAD_BUTTON = 0;
const UPDATE_INSTALL_BUTTON = 0;

// quitAndInstall hands off to the OS installer and should end the process within
// seconds; if the app is still alive past this the handoff silently failed.
const INSTALL_WATCHDOG_MS = 15_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveAutoUpdater(module) {
  return module?.autoUpdater ?? module?.default?.autoUpdater;
}

function updateAvailableDialog(version) {
  return {
    type: "info",
    buttons: ["Download Update", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "ima2 Update",
    message: `ima2 ${version} is available.`,
    detail: "Download the update now?",
  };
}

function updateDownloadedDialog(version) {
  return {
    type: "info",
    buttons: ["Restart and Install", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "ima2 Update Ready",
    message: `ima2 ${version} is ready to install.`,
    detail: "ima2 will stop its local server and restart to finish the update.",
  };
}

/**
 * Self-update coverage matches what the release publishes: signed+notarized
 * Apple Silicon macOS, NSIS-installed Windows (every shipped Windows package
 * is an installer; a zip is never published), and Linux only when running from
 * an AppImage — a deb install has no writable self-update path and must stay
 * inactive.
 */
function updaterSupported({ platform, arch, env }) {
  if (platform === "darwin") return arch === "arm64";
  if (platform === "win32") return true;
  if (platform === "linux") return Boolean(env.APPIMAGE);
  return false;
}

class UpdateController {
  constructor({ app, dialog, prepareForInstall, revertInstall = null, installWatchdogMs = INSTALL_WATCHDOG_MS, logger, now }, autoUpdater) {
    this.active = Boolean(autoUpdater);
    this.state = initialUpdateState({ active: this.active, currentVersion: app.getVersion() });
    this.dialog = dialog;
    this.prepareForInstall = prepareForInstall;
    this.revertInstall = revertInstall;
    this.installWatchdogMs = installWatchdogMs;
    this.installWatchdog = null;
    this.logger = logger;
    this.now = now;
    this.autoUpdater = autoUpdater;
    this.listeners = new Set();
    this.handlers = new Map();
    this.checking = false;
    this.downloading = null;
    this.installing = false;
    this.handoff = false;
    this.handoffReturned = false;
    this.disposed = false;
    if (autoUpdater) this.listen();
  }

  snapshot() { return { ...this.state }; }

  onState(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispatch(event) {
    if (this.disposed) return;
    const next = reduceUpdateState(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const fn of this.listeners) fn(this.snapshot());
  }

  fail(error, operation) {
    const message = errorMessage(error);
    this.logger.error(`[desktop:update] ${operation}: ${message}`);
    this.dispatch({ type: "error", message });
    return false;
  }

  listen() {
    const handlers = {
      "checking-for-update": () => this.dispatch({ type: "checking" }),
      "update-available": (info) => this.dispatch({ type: "available", version: info.version }),
      "update-not-available": () => this.dispatch({ type: "not-available", at: this.now() }),
      "download-progress": (p) => this.dispatch({ type: "progress", percent: p.percent }),
      "update-downloaded": (info) => {
        this.dispatch({ type: "downloaded", version: info.version });
        void this.installUpdate({ confirm: true });
      },
      error: (error) => {
        if (this.handoff) {
          const vetoQueuedQuit = this.handoffReturned;
          this.#endHandoff();
          void this.#abortInstall({ vetoQueuedQuit });
        }
        this.fail(error, "updater error");
      },
    };
    for (const [name, fn] of Object.entries(handlers)) {
      this.handlers.set(name, fn);
      this.autoUpdater.on(name, fn);
    }
  }

  async checkForUpdates({ manual = false } = {}) {
    if (!this.active || this.disposed || this.checking || ["downloading", "downloaded", "installing"].includes(this.state.phase)) return false;
    this.checking = true;
    try {
      const result = await this.autoUpdater.checkForUpdates();
      if (!result || this.disposed) return false;
      if (result.downloadPromise) void result.downloadPromise.catch((error) => this.fail(error, "download failed"));
      if (!result.isUpdateAvailable) {
        if (manual) await this.dialog.showMessageBox({ type: "info", title: "ima2 Update", message: "ima2 is up to date." });
      } else if (manual && !this.autoUpdater.autoDownload) {
        const prompt = await this.dialog.showMessageBox(updateAvailableDialog(result.updateInfo.version));
        if (prompt.response === UPDATE_DOWNLOAD_BUTTON) await this.downloadUpdate();
      }
      return true;
    } catch (error) {
      this.fail(error, "check failed");
      if (manual) await this.dialog.showMessageBox({ type: "error", title: "ima2 Update", message: "Unable to check for updates.", detail: errorMessage(error) });
      return false;
    } finally {
      this.checking = false;
    }
  }

  downloadUpdate() {
    if (this.downloading) return this.downloading;
    if (!this.active || this.disposed || !(this.state.phase === "available" || (this.state.phase === "error" && this.state.availableVersion))) return Promise.resolve(false);
    this.dispatch({ type: "progress", percent: 0 });
    this.downloading = Promise.resolve().then(() => this.autoUpdater.downloadUpdate())
      .then(() => true).catch((error) => this.fail(error, "download failed"))
      .finally(() => { this.downloading = null; });
    return this.downloading;
  }

  async installUpdate({ confirm = false } = {}) {
    if (!this.active || this.disposed || this.installing || this.state.phase !== "downloaded") return false;
    this.installing = true;
    const version = this.state.availableVersion;
    try {
      if (confirm) {
        const prompt = await this.dialog.showMessageBox(updateDownloadedDialog(version));
        if (prompt.response !== UPDATE_INSTALL_BUTTON) return false;
      }
      if (this.disposed || this.state.phase !== "downloaded" || this.state.availableVersion !== version) return false;
      this.dispatch({ type: "installing" });
      if (!await this.prepareForInstall()) {
        this.dispatch({ type: "install-cancelled" });
        return false;
      }
      this.handoff = true;
      this.handoffReturned = false;
      try {
        this.autoUpdater.quitAndInstall();
        if (!this.handoff) return false;
        this.handoffReturned = true;
        this.#armInstallWatchdog();
      } catch (error) {
        // The install prep already stopped the owned server; undo it the way
        // opencodex aborts a coordinated restart instead of staying drained.
        this.#endHandoff();
        await this.#abortInstall({ vetoQueuedQuit: false });
        return this.fail(error, "install failed");
      }
      return true;
    } catch (error) {
      return this.fail(error, "install preparation failed");
    } finally {
      this.installing = false;
    }
  }

  #armInstallWatchdog() {
    this.#clearInstallWatchdog();
    if (this.installWatchdogMs <= 0) return;
    this.installWatchdog = setTimeout(() => {
      this.installWatchdog = null;
      // Reaching this callback means quitAndInstall never ended the app — a
      // silent handoff failure. Recover the server it stopped (opencodex calls
      // this recover_after_failed_install) and surface a retryable error.
      this.#endHandoff();
      void this.#abortInstall({ vetoQueuedQuit: false });
      this.fail(new Error("the update installer did not start"), "install failed");
    }, this.installWatchdogMs);
    if (typeof this.installWatchdog.unref === "function") this.installWatchdog.unref();
  }

  #clearInstallWatchdog() {
    if (this.installWatchdog === null) return;
    clearTimeout(this.installWatchdog);
    this.installWatchdog = null;
  }

  #endHandoff() {
    this.handoff = false;
    this.handoffReturned = false;
    this.#clearInstallWatchdog();
  }

  async #abortInstall(options) {
    if (!this.revertInstall) return;
    try {
      await this.revertInstall(options);
    } catch (error) {
      this.logger.error(`[desktop:update] install abort failed: ${errorMessage(error)}`);
    }
  }

  setAutoDownload(enabled) {
    if (this.autoUpdater) this.autoUpdater.autoDownload = enabled === true;
  }

  markUpdated(version) { this.dispatch({ type: "updated", version }); }

  claimNotice() {
    const version = this.state.updatedTo;
    if (version) this.dispatch({ type: "notice-claimed" });
    return version;
  }

  dispose() {
    this.disposed = true;
    this.#endHandoff();
    for (const [name, fn] of this.handlers) this.autoUpdater.removeListener(name, fn);
    this.handlers.clear();
    this.listeners.clear();
  }
}

export async function createUpdaterController(options) {
  const {
    app, dialog, prepareForInstall,
    platform = process.platform, arch = process.arch, env = process.env,
    revertInstall = null, installWatchdogMs = platform === "darwin" ? 0 : INSTALL_WATCHDOG_MS,
    logger = console, now = Date.now,
    loadUpdater = () => import("electron-updater"), autoDownload = true,
  } = options;
  let autoUpdater = null;
  if (app.isPackaged && updaterSupported({ platform, arch, env })) {
    try {
      autoUpdater = resolveAutoUpdater(await loadUpdater());
      if (!autoUpdater) throw new Error("electron-updater did not export autoUpdater");
      autoUpdater.autoDownload = autoDownload;
      autoUpdater.autoInstallOnAppQuit = false;
    } catch (error) {
      logger.error(`[desktop:update] updater unavailable: ${errorMessage(error)}`);
      autoUpdater = null;
    }
  }
  return new UpdateController({ app, dialog, prepareForInstall, revertInstall, installWatchdogMs, logger, now }, autoUpdater);
}
