# 060 outcome — auto-update and update indicators

## Result

ima2 now tells users about new releases on every surface and can update itself.

- npm installs: a server-side registry check (20 h freshness, hourly scheduler with backoff,
  off for desktop-launched servers, under node --test and with `IMA2_DISABLE_UPDATE_CHECK=1`)
  caches its answer in `<configDir>/version.json`. Interactive CLI commands print one
  "Update available" line and, once after an upgrade, "ima2 updated to vX". `ima2 update`
  installs the global package, restarts the login service or background server it owns and
  proves the new version answers.
- Desktop: electron-updater events feed one state snapshot that drives the macOS menu bar
  template dot (tray-update icons elsewhere), tray menu, app menu, tray popup banner and the
  served UI; checks every 6 h with Auto-update on; one post-update announcement.
- Web UI: top-strip update button (floating pill on phones) with the command popover, driven by
  an id-less `update` frame on `/api/events` plus a 10-minute re-read after that hint.

## Changes against the audited plan

- Cache lock replaced by single-writer files (audit rounds 3-4, 010 A5c/A5d).
- Service restart only over a server that service runs; unreadable config declarations fail
  closed (code review F1/F2, 2168dbe5).
- Offline e2e fixtures: `IMA2_DISABLE_UPDATE_CHECK=1` in the isolated app environment (CI run
  36712487567 caught a registry TLS connection from the fixture server).
- The UI's update traffic starts from a server hint instead of at mount (CI runs 36713267748 and
  36716926453: journey harnesses reject unlisted /api calls, and a fake-clock test defeated a
  90-second timer).

## Evidence

- Local at 37a9e79f: typecheck, typecheck:tests, lint, test:inventory, build:server, build:cli, ui
  build exit 0; 141 focused tests; full `npm test` 4062 pass (1 known port flake, passes isolated).
- Live smokes: `/api/update/badge` on a seeded temp config, `ima2 update --check --json` against
  npm, `update --help` with an empty config dir; Playwright screenshots in pr-assets 6a2ed061.
- PR #355 (merged b5ea806c): PR fast gate green on afedf266 after two e2e regressions were fixed.
- Post-merge Windows fix: PR #357 (merged f844bf95). The concurrent `version.json` write hit `EPERM` on
  Windows (renames now retry on EPERM/EBUSY/EACCES) and the `ima2 update` tests used POSIX-only paths.
  Proof before merge: dispatched full CI 36723835772 green (both Windows legs); dev CI 36725615431 green.
- Promotion PR #356 (merged b00ad867) carried the screenshots. main CI 36727935796 failed once on the macOS
  package-install smoke with an npm 404 for `ignore-7.0.11.tgz`, published four minutes earlier and not yet on
  the registry CDN. The URL answered 200 afterwards; the failed job was rerun green (attempt 2).
- Release: release.yml 36730401649 success (the first dispatch, 36727946427, stopped at the main-CI reuse gate
  above and changed nothing public). publish.yml 36733462726 and desktop.yml 36733489361 success.
  `npm view ima2-gen dist-tags`: latest 3.26.0, preview 3.26.0-preview.260930. GitHub releases v3.26.0 and
  desktop-v3.26.0 are public; the desktop release has 17 assets including latest-mac.yml, latest.yml,
  latest-linux.yml, latest-linux-arm64.yml and SHA256SUMS.txt. main, dev, preview, v3.26.0 and desktop-v3.26.0
  all point at f7857a52.

## Follow-ups

- `scripts/release.mjs` watched the wrong run: `highWaterMark()` evidently returned 0, so
  `findDispatchedRun` picked the oldest dispatch in the 30-run list (33581258747, 2026-09-02) and exited
  "success" within 30 seconds. The release was finished by hand with the script's own steps (same approvals,
  same run matching). The script should refuse an `afterId` of 0 and match the dispatched run by
  `expected_sha`.
- After the user asked to stop running the local suite, only remote CI and remote release checks were used.

## Not verified

Real macOS menu bar rendering of the template dot, a signed two-version electron-updater
download on a user machine, and `ima2 update` on native Windows.

