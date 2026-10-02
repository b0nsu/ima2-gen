# 261002 background-mode hardening — plan

PR #365 (Devin) repairs the desktop background mode on Windows: start-hidden only at
login, tray Open always reachable, close destroys the window while the server keeps
running, the update-install handoff recovers when the installer never starts, and
Windows stops kill the whole owned process tree. Four independent gpt-5.6-sol reviews
found that several of those recoveries do not hold in the real event order (a vetoed
quit still disposes the updater, a Windows installer spawn error still quits the app,
the macOS handoff is misread as a failure, a stop can hang forever, the admin stop
skips server teardown on Windows). This unit fixes those defects on the PR branch,
merges #365 into dev and ships them in a patch release.

## Loop spec

| Field | Value |
|---|---|
| Loop archetype | satisfy-spec, HOTL cxc-loop, four work-phases |
| Trigger | User 2026-10-02: run cxc-loop on the posted background hardening, fix PRs with their issues, merge and deploy, unlimited sol subagents |
| Goal | #365 plus the fixes in 010 merged to dev and released (expected v3.26.1) |
| Non-goals | #338 job queue (contributor owns it), #351 OAuth deadline, #150 RFC, #364, dependabot #360-#363, macOS Dock/login-item behavior, new dependencies |
| Verifier | see Verifiers below; packaged Windows/macOS installs are human checks |
| Stop condition | c1-c6 in the goalplan met with fresh evidence, or a BLOCKED/NEEDS_HUMAN condition from 030 |
| Memory artifact | this unit; goalplan `.codexclaw/goalplans/hotl-cxc-loop-for-lidge-ai-ima2-gen-finish-merge/` |
| Expected terminal outcomes | DONE (released), BLOCKED (hosted CI/infra), NEEDS_HUMAN (admin approval or signing), UNSAFE (unfixable defect: do not merge) |
| Escalation | admin-only approvals the release script cannot perform; a reviewer FAIL after three audit rounds returns to P |
| Resource bounds | no token/time budget set by the user; tool scope = gh (lidge-ai/ima2-gen), npm registry read, local worktree writes; push to the PR branch and dev/main via the release script are authorized |

## Sources

- PR #365 head 1e528690 on dev c953f854 (`git diff origin/dev...HEAD`).
- electron-updater 6.8.9: `node_modules/electron-updater/out/BaseUpdater.js:13-26` (NSIS quitAndInstall queues `setImmediate(app.quit)`), `:129-146` (spawnLog rejects on child `error`), `NsisUpdater.js:101-147` (`doInstall` returns true before the spawn settles), `MacUpdater.js:231-255` (quitAndInstall waits for native `update-downloaded`).
- Review synthesis: 001_review_synthesis.md.

## Decisions

| ID | Decision | Findings |
|---|---|---|
| D1 | `wireAppLifecycle` owns the irreversible-quit decision and calls `onQuitCommitted()` once (normal-quit drain start, or update-install pass-through) after `windows.markQuitting()`; main.mjs moves stopBackgroundChecks / updater.dispose / popup.destroy there and drops its own before-quit listener | F1, F12 |
| D2 | UpdateController has a handoff flag from just before `quitAndInstall()` until dispose / watchdog / error; an autoUpdater `error` during handoff synchronously calls `revertInstall({ vetoQueuedQuit })`, where the veto is armed only if `quitAndInstall()` had already returned (then electron-updater has queued `app.quit()`); `abortUpdateInstall` sets state running and, when asked, arms a one-use 2 s quit veto before its async server restart | F2 |
| D3 | Install watchdog defaults to 15 s on win32/linux and is off on darwin (explicit option still overrides) | F3 |
| D4 | bin/lib/platform.ts keeps the registered handler and exports `requestShutdown(reason)` (one shared run, same grace timer); signals delegate to it; /api/admin/stop calls it after the stop-intent write instead of self-SIGTERM; registerAdminRoutes takes an optional injected shutdown for tests | F4 |
| D5 | ServerSupervisor.stop() memoizes one in-flight stop per child; after the force attempt it waits one more grace interval, then sets state error and rejects "server did not exit"; `this.child` cleared only when it is still the stopped child | F5, F6 |
| D6 | Main-window event wiring moves to electron-free desktop/lib/window-lifecycle.mjs; reload budget is per window; skip only clean-exit, destroyed window or quitting; "killed" reloads | F7, F8 |
| D7 | Behavioral tests replace the source-regex checks; killProcessTree takes injected platform/spawnSync | F9, F10 |
| D8 | settings.html hint: "Start with the app window hidden when opened at login" | F11 |

Architect consultation: Halley (01a0f9bc-6c9b-7fe3-a672-a746f89eef68) proposal D1-D8 accepted;
main amended D6/D7 to an extracted electron-free module because `electron` is not
installed at the repo root and `mock.module("electron")` fails with ERR_MODULE_NOT_FOUND
(probe 2026-10-02). Reflection: see 001.

## Work-phase map

| Work-phase | Doc | Verifiable close |
|---|---|---|
| wp1 docs-first roadmap | 000, 001, 010, 020, 030 | A audit PASS/near-pass on these docs |
| wp2 fixes on the PR branch | 010 | focused desktop + stop suites, typecheck, typecheck:tests, lint, test:inventory green locally; PR checks green at pushed head |
| wp3 merge | 020 | #365 merged, dev push CI green for the merge sha |
| wp4 release | 030 | npm latest, vX.Y.Z + desktop-vX.Y.Z releases, manifest mirror 200, outcome doc on dev |

## Verifiers (PLAN-VERIFIER-REAL-01)

- `test -f tests/platform-shutdown.test.ts && test -f tests/desktop-window-lifecycle.test.ts && test -f tests/desktop-quit-cleanup.test.ts && node --experimental-test-module-mocks --import tsx --test tests/desktop-*.test.ts tests/stop-command-contract.test.ts tests/platform-shutdown.test.ts` — the `test -f` guards fail the command when a planned suite is missing (node skips a missing explicit path, audit B3); C also confirms each new suite name appears in the output. Baseline at 1e528690: desktop glob 234/234; auditor run with the stop contract 250/250 (exit 0).
- `npm run typecheck` — tsconfig.json includes routes/ and bin/lib (reads admin.ts, platform.ts).
- `npm run typecheck:tests` — reads tests/*.ts.
- `npm run lint` — covers desktop/, routes/, bin/ (AGENTS.md Test Command).
- `npm run test:inventory` — reads the tests/ file list; new test files must be classified.
- Hosted: PR fast gate on the PR head; full CI (Windows/macOS/Ubuntu) on the dev push.
- Not observed by any gate: a real NSIS install, real Squirrel.Mac handoff, Task Manager renderer kill. These stay human checks and are named in the PR body.

## SoT sync

C patches structure/ desktop section if it describes the close/hide model or the admin
stop self-signal (`rg -n "self-signal|hide.*tray|keepRunningOnClose" structure/`), and
`node scripts/refresh-structure-line-counts.mjs` when line counts move. CHANGELOG is
written by the release script.
