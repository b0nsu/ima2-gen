import { AUTOSTART_FLAG } from "./launch-origin.mjs";

async function stopAndDispose(supervisor, logger) {
  try {
    await supervisor.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[desktop] server shutdown failed: ${message}`);
  } finally {
    supervisor.dispose();
  }
}

export function wireAppLifecycle(options) {
  const { app, supervisor, windows, settingsStore, applyDockVisibility, logger = console } = options;
  let state = "running";

  // A login relaunch (the OS fires the login item again while ima2 already runs)
  // carries --autostart; only a manual relaunch asks for the window.
  app.on("second-instance", (_event, argv) => {
    if (!Array.isArray(argv) || !argv.includes(AUTOSTART_FLAG)) windows.showMain();
  });
  app.on("activate", () => windows.showMain());
  app.on("window-all-closed", () => {
    if (state !== "running") return;
    if (!settingsStore.get().keepRunningOnClose) app.quit();
    else applyDockVisibility(settingsStore.get(), windows);
  });
  app.on("before-quit", (event) => {
    if (state === "update-install") return;
    event.preventDefault();
    if (state !== "running") return;
    state = "normal-quit";
    windows.closeAllForQuit();
    void stopAndDispose(supervisor, logger).finally(() => app.exit(0));
  });

  return {
    async prepareForUpdateInstall() {
      if (state !== "running") return false;
      state = "update-preparing";
      try {
        // Unlike the quit drain, an update must never proceed past a failed stop.
        await supervisor.stop();
        supervisor.dispose();
      } catch (error) {
        // "update-preparing" still intercepts before-quit — go back to running
        // and bring back whatever the drain left instead of wedging the app.
        state = "running";
        try {
          await supervisor.start(settingsStore.get());
        } catch (restartError) {
          const message = restartError instanceof Error ? restartError.message : String(restartError);
          logger.error(`[desktop] server restart after failed update drain: ${message}`);
        }
        throw error;
      }
      state = "update-install";
      return true;
    },
    // The opencodex rule: an install that does not happen must not leave the app
    // drained — go back to running and bring the server the update stopped back.
    async abortUpdateInstall() {
      if (state !== "update-install") return;
      state = "running";
      try {
        await supervisor.start(settingsStore.get());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[desktop] server restart after aborted install failed: ${message}`);
      }
    },
  };
}
