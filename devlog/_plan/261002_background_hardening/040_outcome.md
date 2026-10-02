# 040 outcome — v3.26.1

PR #365 and the review fixes are merged and released as ima2-gen 3.26.1 (npm latest,
`v3.26.1`, `desktop-v3.26.1`). The background-mode repairs from #365 now hold in the
real Electron and electron-updater 6.8.9 event order, and the Windows admin stop runs the
server's own teardown. What remains unverified is the packaged behavior a CI runner
cannot reach: a real NSIS install, a real Squirrel.Mac handoff and a Task Manager
renderer kill.

## What shipped

| Decision | Change | Commit |
|---|---|---|
| D4 | `/api/admin/stop` requests the shutdown coordinator instead of a self-SIGTERM | ec74c67f |
| D5 | one shared, bounded `stop()` per child; rejects "server did not exit" | d891d652 |
| D6, D8 | per-window renderer recovery in `desktop/lib/window-lifecycle.mjs`; Start hidden copy | abd5c995 |
| D1-D3 | quit cleanup registry, handoff error recovery with queued-quit veto, no macOS watchdog | c138e5cc |
| C gate fix | live child kept on a kill error; `restart()` absorbs a failed stop | 6c0de807 |
| Release | CHANGELOG 3.26.1 (#366), promotion #367, release commit | 25c4454d, e71b0e66, 8c27479c |

## Evidence

- Local at 6c0de807: 280/280 focused desktop + stop-contract tests with `test -f` guards,
  `typecheck`, `typecheck:tests`, `lint` (0 errors), `test:inventory`, line counts;
  full `npm test` after a build: 4122 tests, 4119 pass, 0 fail, 3 skipped. Every new test
  failed on the previous code.
- Reviews (gpt-5.6-sol): four PR lanes (001), architect reflection ALIGNED in round 3,
  plan audit PASS in round 3, C gate FAIL → fixed → PASS.
- PR #365: PR Fast Gate 36942161192 (pull_request, attempt 1, head 6c0de807) success;
  merged as 62aa648b with `--match-head-commit`.
- dev push for 62aa648b: CI 36943594915 (ubuntu ×2, windows ×2, macOS native install,
  frontend e2e, aggregate), Agy 36943594922, CodeQL 36943594921, Desktop Build 36943594954, all success.
- Release: release.yml 36945334318 success; preview publish 36946654079; stable publish
  36948216389; desktop.yml 36948231910 success (5 platform builds, verified draft,
  approved publication, manifest mirror); Pages 36949053175 success.
- npm: `latest` 3.26.1 (gitHead 8c27479c), `preview` 3.26.1-preview.261002.36946654079.1.
- GitHub: `v3.26.1` is Latest; `desktop-v3.26.1` has 17 assets; `latest-mac.yml`,
  `latest.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` under `v3.26.1` answer 200
  and point at `../desktop-v3.26.1/`.

## What did not improve, and what would prove this wrong

- A native Squirrel error on macOS also arms the 2 s queued-quit veto, so a user quit in
  that window is swallowed once. Bounded, accepted.
- After a stop that cannot end the server, the tray shows the error state while the old
  server still runs; `start()` refuses a second spawn by design.
- If an installed 3.26.0 app on Windows fails to update to 3.26.1 and is left without a
  server, the handoff recovery is wrong; if a desktop stop on Windows leaves an advertise
  file or an OAuth child behind, D4 did not take effect in the packaged build.

## Follow-ups

- `scripts/release.mjs` runs `ensurePromoted` before it reads `--dry-run`, so
  `--promote --dry-run` performs a real promotion (audit B5). Make dry runs skip the merge.
- Packaged checks: Windows NSIS update from 3.26.0, macOS update from 3.26.0, renderer kill
  in Task Manager.
