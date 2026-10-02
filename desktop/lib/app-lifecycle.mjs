import { AUTOSTART_FLAG } from "./launch-origin.mjs";

const QUEUED_QUIT_VETO_MS = 2_000;

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

async function stopAndDispose(supervisor, logger) {
  try {
    await supervisor.stop();
  } catch (error) {
    logger.error(`[desktop] server shutdown failed: ${message(error)}`);
  } finally {
    supervisor.dispose();
  }
}

function createQuitCommit({ lifecycle, windows, onQuitCommitted, logger }) {
  return () => {
    if (lifecycle.committed) return;
    lifecycle.committed = true;
    windows.markQuitting?.();
    try {
      onQuitCommitted();
    } catch (error) {
      logger.error(`[desktop] quit cleanup failed: ${message(error)}`);
    }
  };
}

async function prepareForUpdateInstall({ lifecycle, supervisor, settingsStore, logger }) {
  if (lifecycle.state !== "running") return false;
  lifecycle.state = "update-preparing";
  try {
    await supervisor.stop();
    supervisor.dispose();
  } catch (error) {
    lifecycle.state = "running";
    try {
      await supervisor.start(settingsStore.get());
    } catch (restartError) {
      logger.error(`[desktop] server restart after failed update drain: ${message(restartError)}`);
    }
    throw error;
  }
  lifecycle.state = "update-install";
  return true;
}

async function abortUpdateInstall({ lifecycle, supervisor, settingsStore, logger, now, vetoQueuedQuit }) {
  if (lifecycle.state !== "update-install") return;
  lifecycle.state = "running";
  if (vetoQueuedQuit) lifecycle.quitVetoUntil = now() + QUEUED_QUIT_VETO_MS;
  try {
    await supervisor.start(settingsStore.get());
  } catch (error) {
    logger.error(`[desktop] server restart after aborted install failed: ${message(error)}`);
  }
}

export function wireAppLifecycle(options) {
  const {
    app, supervisor, windows, settingsStore, applyDockVisibility,
    onQuitCommitted = () => {}, logger = console, now = Date.now,
  } = options;
  const lifecycle = { state: "running", committed: false, quitVetoUntil: 0 };
  const commitQuit = createQuitCommit({ lifecycle, windows, onQuitCommitted, logger });

  // A login relaunch (the OS fires the login item again while ima2 already runs)
  // carries --autostart; only a manual relaunch asks for the window.
  app.on("second-instance", (_event, argv) => {
    if (!Array.isArray(argv) || !argv.includes(AUTOSTART_FLAG)) windows.showMain();
  });
  app.on("activate", () => windows.showMain());
  app.on("window-all-closed", () => {
    if (lifecycle.state !== "running") return;
    if (!settingsStore.get().keepRunningOnClose) app.quit();
    else applyDockVisibility(settingsStore.get(), windows);
  });
  app.on("before-quit", (event) => {
    if (lifecycle.state === "update-install") { commitQuit(); return; }
    event.preventDefault();
    if (lifecycle.quitVetoUntil > now()) { lifecycle.quitVetoUntil = 0; return; }
    if (lifecycle.state !== "running") return;
    lifecycle.state = "normal-quit";
    commitQuit();
    windows.closeAllForQuit();
    void stopAndDispose(supervisor, logger).finally(() => app.exit(0));
  });

  return {
    prepareForUpdateInstall: () => prepareForUpdateInstall({ lifecycle, supervisor, settingsStore, logger }),
    // The opencodex rule: an install that does not happen must not leave the app
    // drained — go back to running and bring the server the update stopped back.
    abortUpdateInstall: ({ vetoQueuedQuit = false } = {}) => abortUpdateInstall({
      lifecycle, supervisor, settingsStore, logger, now, vetoQueuedQuit,
    }),
  };
}
