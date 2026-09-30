# 260930 auto-update and update indicators — plan

## Objective

Give ima2 the same update experience as opencodex, adapted to ima2's two install
paths. An npm install learns about new releases from a cached registry check,
shows it in the CLI and the web UI, and updates itself with `ima2 update`, which
also restarts the login service or background server. The desktop app keeps
electron-updater (the cli-jaw pattern) but now reports every update state in the
macOS menu bar (a dot on the template icon), the tray menu, the app menu, the tray
popup and the served UI, and says "ima2 updated to vX" once after an update.

## Sources

- opencodex `dev` 9177663665: src/update/{index,notify,async-check,refresh-scheduler}.ts,
  bin/ocx.mjs update path, GET /api/update/badge, sidebar-github-row.tsx badge,
  desktop tray dot (app/Sources/NativeTray/Popover.swift:48, desktop/src-tauri/src/tray.rs:43,294).
- cli-jaw `81251f5d`: electron/src/main/lib/app-updater.ts (consent dialogs, deduped
  checks, prepareForUpdateInstall then quitAndInstall). cli-jaw has no npm updater.
- ima2 today: desktop/lib/updater.mjs (electron-updater, autoDownload setting,
  update-downloaded dialog), desktop/lib/tray.mjs:64-71 (update icon swap skipped on
  macOS), desktop/lib/menu.mjs:40 (static Check for Updates), no npm update code in
  bin/ or lib/ (only lib/codexBackend/client.ts reads the Codex registry).

## Decisions

| ID | Decision |
|---|---|
| D1 | Flat owners: lib/updateVersion.ts (semver + channel), lib/updateCache.ts (version.json), lib/updateCheck.ts (registry + scheduler), routes/update.ts, bin/lib/npmUpdate.ts, bin/commands/update.ts. |
| D2 | Cache `<configDir>/version.json` = {latest_version, last_checked_at (ms), dismissed_version, tag, last_seen_version}. Writes take a short mkdir lock, re-read, merge their own fields, write a pid+random temp file and rename it (010 R1). |
| D3 | Server scheduler starts after listen, checks at once when the cache is older than 20 h or on another tag, then ticks hourly; failures back off from 1 min doubling to 1 h. Off when IMA2_DISABLE_UPDATE_CHECK=1 or the launcher is desktop. Timer unref'd and cleared on shutdown. |
| D4 | GET /api/update/badge (cache only), POST /api/update/check, POST /api/update/dismiss {version}, POST /api/update/notice. No HTTP install endpoint. |
| D5 | `ima2 update [--check] [--tag latest|preview] [--yes] [--json]`. Refuses source checkouts and non-global installs. Runs npm install -g ima2-gen@<version> (argv, no shell), verifies the installed package.json, then restarts the service (new CLI `service restart`) or background runtime (new CLI `restart`); a foreground server gets a restart hint. Prints "Updated to vX". |
| D6 | Desktop updater becomes a state machine with one snapshot {active, currentVersion, phase, availableVersion, progress, error}. autoDownload default stays true (the user asked for auto-update). |
| D7 | One snapshot drives the tray icon, tray menu, app menu, tray popup banner and served UI via IPC `desktop:update:*`. |
| D8 | Web UI: UpdateIndicator in SidebarTopStrip (every mode renders it). Browser/npm surface polls /api/update/badge every 10 min and shows the `ima2 update` command; the desktop surface subscribes to the bridge and triggers download/install. One-time "Updated to vX" toast via POST /api/update/notice (npm) or bridge claimNotice (desktop). |
| D9 | macOS: trayUpdateTemplate.png (+@2x), template glyph plus a dot, so it follows the menu bar tint. Windows/Linux keep tray-update.*. |
| D10 | node:test suites with injected fetch/exec/clock/fs; inventory regenerated. |

Rejected: the architect's change of desktop autoDownload default to false (conflicts with
the requested auto-update) and a detached web-triggered npm installer (opencodex job.ts),
which is out of scope and risky for a server to replace its own package while serving.

## Work-phase map (goalplan)

| Work-phase | Docs | Verifiable close |
|---|---|---|
| wp1 docs-first roadmap | 000, 010-050 | A audit PASS on these docs |
| wp2 implementation | 010 npm core, 020 CLI, 030 desktop, 040 web UI | typecheck, typecheck:tests, lint, test:inventory, npm test, ui build |
| wp3 release | 050 | PR merged, dev CI green, npm latest + desktop release at 3.26.0 |

Inside wp2 the four docs are independent write scopes (lib+routes+server / bin /
desktop / ui) that share the contracts in 010 `Contracts, so Sol workers build them in
parallel and main integrates and verifies.

## Verifiers (PLAN-VERIFIER-REAL-01)

- `npm run typecheck` — reads lib/, routes/, server.ts through tsconfig.json include.
- `npm run typecheck:tests` — reads tests/*.ts.
- `npm run lint` — reads server/lib/routes/bin/scripts/ui/src/desktop (AGENTS.md Test Command).
- `npm run test:inventory` — reads the tests/ file list (scripts/classify-tests.mjs:26).
- `node --import tsx --test tests/update-*.test.ts tests/desktop-update*.test.ts tests/desktop-tray.test.ts` — imports the new modules directly.
- `cd ui && npm run build` — reads ui/src.
- Menu bar rendering on a real macOS display and a real electron-updater download are
  packaged/human checks; no local gate observes them.

Base results are recorded in 001_baseline.md.

## SoT sync

C patches structure/ (routes list and desktop section), README (updating section),
CHANGELOG (Unreleased entry) and skills/ima2/SKILL.md (CLI reference gains `ima2 update`).
