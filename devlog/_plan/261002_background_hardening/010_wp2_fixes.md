# 010 wp2 — fixes on the PR branch (diff-level)

Branch: `devin/1790865725-background-mode` (local `codex/261002-background-hardening`),
pushed as additional commits on top of 1e528690. One commit per decision group.

## D1/F1/F12 — quit commit boundary

MODIFY desktop/lib/app-lifecycle.mjs
```diff
-export function wireAppLifecycle(options) {
-  const { app, supervisor, windows, settingsStore, applyDockVisibility, logger = console } = options;
-  let state = "running";
+export function wireAppLifecycle(options) {
+  const { app, supervisor, windows, settingsStore, applyDockVisibility, onQuitCommitted = () => {}, logger = console, now = Date.now } = options;
+  let state = "running";
+  let committed = false;
+  let quitVetoUntil = 0;
+  const commitQuit = () => {
+    if (committed) return;
+    committed = true;
+    windows.markQuitting?.();
+    try { onQuitCommitted(); } catch (error) { logger.error(`[desktop] quit cleanup failed: ${message(error)}`); }
+  };
 ...
   app.on("before-quit", (event) => {
-    if (state === "update-install") return;
+    if (state === "update-install") { commitQuit(); return; }
     event.preventDefault();
+    if (quitVetoUntil > now()) { quitVetoUntil = 0; return; }   // D2: the updater's queued quit after an aborted handoff
     if (state !== "running") return;
     state = "normal-quit";
+    commitQuit();
     windows.closeAllForQuit();
```
MODIFY desktop/lib/windows.mjs: add `markQuitting() { this.quitting = true; }`; `closeAllForQuit` keeps setting it.
MODIFY desktop/main.mjs: delete the `app.on("before-quit", ...)` block in wireDesktop.
All quit cleanup goes through one registry (architect gap 1 and audit B2): NEW
electron-free desktop/lib/quit-cleanup.mjs:
```js
export function createQuitCleanup({ logger = console } = {}) {
  const tasks = new Map(); let committed = false;
  const runOne = (name, fn) => { try { fn(); } catch (e) { logger.error(`[desktop] quit cleanup ${name} failed: ${e?.message ?? e}`); } };
  return {
    get committed() { return committed; },
    register(name, fn) { if (committed) runOne(name, fn); else tasks.set(name, fn); },
    run() { if (committed) return; committed = true; for (const [n, fn] of tasks) runOne(n, fn); tasks.clear(); },
  };
}
```
boot(): `const quitCleanup = createQuitCleanup();` → `wireAppLifecycle({ ..., onQuitCommitted: () => quitCleanup.run() })`;
after createUpdaterController: `quitCleanup.register("updater", () => updater.dispose())`;
`if (quitCleanup.committed) return;` before tray/menu/supervisor.start wiring; wireDesktop
registers "background-checks" and "popup" instead of its own before-quit listener.
Tests (NEW tests/desktop-quit-cleanup.test.ts): a vetoed quit (lifecycle in
update-preparing) runs no task; a committed quit runs each task once; a task registered
after commit runs immediately (the deferred-updater boot race); one throwing task does
not skip the others. Contract test: desktop/main.mjs contains no `app.on("before-quit"`
(the lifecycle is the only listener), so the old disposing listener cannot survive.

Activation tests (tests/desktop-app-lifecycle.test.ts): (a) vetoed quit during
update-preparing does not call onQuitCommitted; (b) update-install pass-through calls it
once and markQuitting first; (c) normal quit calls it once even if before-quit fires twice.

## D2/F2 — handoff error recovery

MODIFY desktop/lib/updater.mjs
- constructor: `this.handoff = false`.
- installUpdate: set `this.handoff = true` before `quitAndInstall()`; on synchronous throw:
  `this.#endHandoff(); await this.#abortInstall({ vetoQueuedQuit: false })`.
- after `quitAndInstall()` returns: `if (!this.handoff) return false;` then arm the watchdog: the
  updater may emit `error` synchronously inside the call, which already ended the
  handoff and started recovery (reflection gap 2). Test: fake `quitAndInstall` emits
  `error` synchronously → installUpdate resolves false, exactly one revert, no watchdog armed, phase error.
- error listener (the `error` handler registered in the constructor): if `this.handoff`,
  `const veto = this.handoffReturned; this.#endHandoff(); void this.#abortInstall({ vetoQueuedQuit: veto })` before `fail()`.
  Exact sequence (audit B1 + round 2): installUpdate sets `handoff = true, handoffReturned = false`
  before `quitAndInstall()`; after it returns and `this.handoff` is still true, sets
  `handoffReturned = true` and arms the watchdog; the error handler captures
  `handoffReturned` into a local before `#endHandoff()`, which resets both flags.
  BaseUpdater queues `app.quit()` only when `install()` returned true
  (BaseUpdater.js:16-26); a synchronous dispatchError inside the call means no quit is
  queued, so no veto. Tests: synchronous error → revert({vetoQueuedQuit:false}) and the
  next user quit drains; nextTick error + setImmediate before-quit → veto consumed, no drain.
- watchdog callback: `this.#endHandoff(); void this.#abortInstall({ vetoQueuedQuit: false })`.
- `#endHandoff()` clears `handoff` and the watchdog; `dispose()` calls it.
- `#abortInstall(opts)` passes opts to `revertInstall(opts)`.
MODIFY desktop/lib/app-lifecycle.mjs
```diff
-    async abortUpdateInstall() {
-      if (state !== "update-install") return;
-      state = "running";
+    async abortUpdateInstall({ vetoQueuedQuit = false } = {}) {
+      if (state !== "update-install") return;
+      state = "running";                       // synchronous: runs before the queued setImmediate(app.quit)
+      if (vetoQueuedQuit) quitVetoUntil = now() + QUEUED_QUIT_VETO_MS;   // 2_000
       try { await supervisor.start(settingsStore.get()); } ...
```
MODIFY desktop/main.mjs: `revertInstall: (opts) => lifecycle.abortUpdateInstall(opts)`.

Activation tests: fake autoUpdater whose `quitAndInstall` returns, then emits `error`
on nextTick and schedules `app.emit("before-quit")` via setImmediate (the 6.8.9 order);
assert revert called with veto, the before-quit was prevented and did not drain
(supervisor.stop not called), state retryable error, and a second user quit after the
veto drains normally.

## D3/F3 — no macOS watchdog

MODIFY desktop/lib/updater.mjs `createUpdaterController`: `installWatchdogMs` default
`platform === "darwin" ? 0 : INSTALL_WATCHDOG_MS`; `#armInstallWatchdog` returns
without a timer when `installWatchdogMs <= 0`.
Activation test: darwin controller created without an override, install succeeds
(`quitAndInstall` returns, no quit); with node:test `mock.timers.enable({ apis: ["setTimeout"] })`
tick 60 s → `revertInstall` never called and phase stays "installing". Same setup on
win32 → revert called once after 15 s and phase is error.

## D4/F4 — Windows-safe admin stop

MODIFY bin/lib/platform.ts
```diff
-let shutdownStarted = false;
-export function onShutdown(handler) { ...process.on(sig, async () => { if (shutdownStarted) return; ... }) }
+export function createShutdownCoordinator({ exit = (code: number) => process.exit(code), graceMs = SHUTDOWN_GRACE_MS } = {}) {
+  let handler: ShutdownHandler | null = null;
+  let run: Promise<void> | null = null;
+  return {
+    setHandler(next: ShutdownHandler) { handler = next; },
+    request(reason: ShutdownReason): Promise<void> {
+      if (run) return run;
+      let exited = false;   // reflection gap 3: exit exactly once, clear the force timer
+      const finish = () => { if (exited) return; exited = true; clearTimeout(force); exit(0); };
+      const force = setTimeout(finish, graceMs); force.unref?.();
+      run = (async () => {
+        try { await handler?.(reason); } catch (err) { logWarn("shutdown", "handler_failed", { signal: reason, error: err }); }
+        finish();
+      })();
+      return run;
+    },
+  };
+}
+const shutdown = createShutdownCoordinator();
+export const requestShutdown = (reason: ShutdownReason) => shutdown.request(reason);
+export function onShutdown(handler: ShutdownHandler) {
+  shutdown.setHandler(handler);
+  for (const sig of signals) { try { process.on(sig, () => { void requestShutdown(sig); }); } catch { /* not installable here */ } }
+}
```
`ShutdownReason = NodeJS.Signals | "admin"`; server.ts handler ignores its argument, so no change there.
MODIFY routes/admin.ts: `registerAdminRoutes(app, ctxRaw, { shutdown = requestShutdown } = {})`;
replace `selfSignal` with `() => { void shutdown("admin"); }` after the intent write;
rewrite the doc comment (no self-signal: Node on Windows turns a self SIGTERM into
TerminateProcess, which skipped this teardown).
MODIFY tests/stop-command-contract.test.ts 202 test: inject `shutdown` and assert it is
called once with "admin" after the IMA2_STOP_INTENT write (drop the process.kill stub).
NEW tests/platform-shutdown.test.ts: coordinator with injected exit runs the handler once
for concurrent requests (signal + admin), passes the first reason, calls exit(0) after
the handler, calls exit(0) from the grace timer when the handler hangs (mock timers),
and calls exit exactly once when the handler finishes after the grace timer fired.
Classify the new test files with `npm run test:inventory` expectations (scripts/classify-tests.mjs).

## D5/F5/F6 — bounded, shared stop

MODIFY desktop/lib/server.mjs `stop()`:
- if `this.stopRun?.child === this.child` return `this.stopRun.promise`.
- wrap the existing body in `#stopChild(child)`; memo `{ child, promise }`; clear in finally.
- in the wait: after the force attempt (tree kill or SIGKILL) arm a final timer of
  `this.stopGraceMs`; if it fires without exit → reject `new Error("server did not exit")`.
- a throwing `child.kill("SIGTERM")` no longer resolves; it falls through to the force timer.
- on rejection: `#setState("error", { lastError: "server did not exit" })`, keep `this.child`.
- on success: clear `this.child` only if `this.child === child`.
MODIFY desktop/lib/server.mjs: `export function killProcessTree(pid, { platform = process.platform, spawnSyncFn = spawnSync } = {})`.
Activation tests (tests/desktop-server-supervisor.test.ts): never-exiting child with
failing kill → stop rejects within 2×grace and state is error; two concurrent stops →
one admin request and one killTree call; killProcessTree win32 calls
`taskkill ["/PID","123","/T","/F"]` with windowsHide, returns false on status 1 and on
non-win32 without spawning.

Callers: `stopAndDispose` already logs and disposes; `prepareForUpdateInstall` already
treats a rejection as failed drain (restart attempt then throw) — with the child kept,
`start()` returns early (`if (this.child ...) return`), which is correct: the old
server still runs.

## D6/F7/F8 — per-window recovery (electron-free)

NEW desktop/lib/window-lifecycle.mjs
```js
export const RELOAD_BUDGET = { count: 3, windowMs: 60_000, delayMs: 250 };
export function wireMainWindow(win, { manager, now = Date.now, schedule = setTimeout, budget = RELOAD_BUDGET }) {
  const reloads = [];
  win.on("close", () => {
    if (manager.quitting || !manager.getSettings().keepRunningOnClose) return;
    manager.onHiddenToTray();
  });
  win.on("closed", () => { if (manager.main === win) manager.main = null; manager.onVisibilityChange(); });
  win.on("hide", () => manager.onVisibilityChange());
  win.on("show", () => manager.onVisibilityChange());
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details?.reason === "clean-exit" || manager.quitting || win.isDestroyed()) return;
    const t = now();
    while (reloads.length && t - reloads[0] >= budget.windowMs) reloads.shift();
    if (reloads.length >= budget.count) return;
    reloads.push(t);
    schedule(() => { if (!win.isDestroyed() && !manager.quitting) win.webContents.reload(); }, budget.delayMs);
  });
}
```
MODIFY desktop/lib/windows.mjs: remove RELOAD_BUDGET, `rendererReloads`, the
close/closed/hide/show/render-process-gone handlers; call `wireMainWindow(win, { manager: this })`.
NEW tests/desktop-window-lifecycle.test.ts (EventEmitter fake win): close never
preventDefaults and notifies only when keepRunningOnClose and not quitting; closed
clears manager.main; killed reloads; three reloads then stop within 60 s; a new window
gets a fresh budget; quitting suppresses; destroyed-before-timer suppresses.
MODIFY tests/desktop-app-lifecycle.test.ts: drop the regex test "destroys the closed
window ..." (replaced).

## D7/F9/F10 — remaining test replacements

MODIFY tests/desktop-server-supervisor.test.ts: replace the source regex (lines 266-270)
with the killProcessTree behavioral test above.

## D8/F11 — copy

MODIFY desktop/pages/settings.html:44 hint → "Start with the app window hidden when opened at login".

## Accept criteria

All activation tests above fail on 1e528690 semantics and pass after; the verifier
list in 000 exits 0; PR body updated with the new behavior and remaining human checks.
