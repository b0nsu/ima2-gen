// Main-window event wiring, kept free of electron imports so tests can drive it
// with a fake window. A crashed or killed renderer gets a bounded reload per
// window instead of a dead window; a recreated window starts a fresh budget.
export const RELOAD_BUDGET = { count: 3, windowMs: 60_000, delayMs: 250 };

export function wireMainWindow(win, {
  manager,
  now = Date.now,
  schedule,
  budget = RELOAD_BUDGET,
}) {
  const scheduleReload = schedule ?? setTimeout;
  const reloads = [];
  win.on("close", () => {
    // The window is destroyed (cli-jaw does the same); the server keeps running in
    // the tray and reopening recreates a window that re-syncs to the live server.
    if (manager.quitting || !manager.getSettings().keepRunningOnClose) return;
    manager.onHiddenToTray();
  });
  win.on("closed", () => {
    if (manager.main === win) manager.main = null;
    manager.onVisibilityChange();
  });
  win.on("hide", () => manager.onVisibilityChange());
  win.on("show", () => manager.onVisibilityChange());
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details?.reason === "clean-exit" || manager.quitting || win.isDestroyed()) return;
    const time = now();
    while (reloads.length && time - reloads[0] >= budget.windowMs) reloads.shift();
    if (reloads.length >= budget.count) return;
    reloads.push(time);
    scheduleReload(() => {
      if (!win.isDestroyed() && !manager.quitting) win.webContents.reload();
    }, budget.delayMs);
  });
}
