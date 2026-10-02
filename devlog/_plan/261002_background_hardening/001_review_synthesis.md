# 001 review synthesis (wp1)

Four gpt-5.6-sol reviewers read PR #365 at 1e528690 (lanes: L1 window/launch/tray,
L2 update handoff, L3 server stop, L4 test quality). Verdicts: L1 GO-WITH-FIXES
(blockers=0), L2 FAIL, L3 FAIL, L4 FAIL. Main verified each accepted claim against
code or the pinned electron-updater source.

| ID | Sev | Finding | Source | Disposition |
|---|---|---|---|---|
| F1 | High | main.mjs:145-148 before-quit disposes updater/popup and stops checks even when app-lifecycle vetoes the quit; a recovered install leaves the updater stuck in "installing" | L2 (reproduced) | accept → D1 |
| F2 | High | NSIS spawn error is dispatched after quitAndInstall returned true but before its setImmediate(app.quit); app exits with no installer, no server | L2; main traced BaseUpdater.js:129-146 (nextTick error → reject → dispatchError precedes setImmediate) | accept → D2 |
| F3 | High | 15 s watchdog on macOS misreads the deferred Squirrel handoff; later native quit runs through a normal drain | L2, L4, main (MacUpdater.js:240-255) | accept → D3 |
| F4 | High | routes/admin.ts self-SIGTERM; Node on Windows terminates unconditionally so onShutdown teardown (server.ts:501) never runs | L3; main confirmed platform.ts:84-90 comment | accept (pre-existing, same stop path) → D4 |
| F5 | High | stop() never settles when taskkill and both child.kill calls fail without exit | L3 (reproduced) | accept → D5 |
| F6 | Med | concurrent stop() calls each run admin stop + taskkill for the same pid | L3 (reproduced) | accept → D5 |
| F7 | Med | render-process-gone ignores "killed"; an externally killed renderer stays dead | L1 | accept → D6 |
| F8 | Med | reload budget is manager-wide and poisons a recreated window | L1 (reproduced) | accept → D6 |
| F9 | Med | close/recreate and crash reload covered only by source-text regex | L1, L4 | accept → D7 |
| F10 | Med | default Windows tree-kill wiring only regex-tested | L4 | accept → D7 |
| F11 | Low | Start hidden hint overstates macOS (Dock stays) | L1 | accept → D8 |
| F12 | Low | update-install quit shows the "still running" balloon | main | accept → D1 |

Rebutted: none. L4's claim that macOS/Linux close flows are untested is folded into D7;
its own trace found no live defect there.

Architect (Halley) amended main's draft D2 (veto must be armed synchronously before
the queued quit) and D3 (no macOS watchdog instead of 180 s, because the late
`update-downloaded` listener cannot be cancelled). Both amendments accepted.

## Architect consultation record

- Handle: Halley, agent 01a0f9bc-6c9b-7fe3-a672-a746f89eef68 (gpt-5.6-sol). Proposal D1-D8, PROPOSAL: READY.
- Main dispositions: D1-D5, D8 accepted; D6/D7 amended to an electron-free
  `desktop/lib/window-lifecycle.mjs` (electron absent at repo root, `mock.module("electron")`
  → ERR_MODULE_NOT_FOUND); D4 amended with an injectable `createShutdownCoordinator`.
- Reflection round 1 on 010 rev 1: MISALIGNED — late-bound updater in boot, watchdog
  rearm after a synchronous updater error, double exit in the coordinator. All folded.
- Round 2: MISALIGNED — undefined `quitCommitted`, installUpdate returning true after a
  synchronous error. Both folded.
- Round 3: REFLECTION: ALIGNED.
