# 030 desktop updater states, menu bar dot, post-update notice (wp2 task t3)

## Scope

IN: desktop/lib/update-state.mjs (NEW), desktop/lib/update-receipt.mjs (NEW);
desktop/lib/{updater,tray,menu,ipc,icons,settings}.mjs, desktop/main.mjs, desktop/preload.cjs,
desktop/pages/{tray.html,tray.js,tray.css,settings.html,settings.js}, desktop/scripts/make-icons.mjs (MODIFY);
tests/desktop-updater.test.ts, tests/desktop-tray.test.ts (MODIFY), tests/desktop-update-state.test.ts (NEW).
OUT: lib/, routes/, bin/, ui/ (ui consumes the bridge contract below).

## desktop/lib/update-state.mjs (NEW, pure)

```js
export const UPDATE_PHASES = ["unsupported", "idle", "checking", "current", "available", "downloading", "downloaded", "installing", "error"];
export function initialUpdateState({ active, currentVersion }) // { active, currentVersion, phase: active ? "idle" : "unsupported", availableVersion: null, progress: null, error: null, updatedTo: null, checkedAt: null }
export function reduceUpdateState(state, event)
//  {type:"checking"}                       -> phase checking (unless downloading/downloaded/installing: unchanged)
//  {type:"not-available", at}              -> phase current, checkedAt at, availableVersion null
//  {type:"available", version}             -> phase available, availableVersion version, progress null
//  {type:"progress", percent}              -> phase downloading, progress clamp 0..100 rounded
//  {type:"downloaded", version}            -> phase downloaded, availableVersion version, progress 100
//  {type:"installing"}                     -> phase installing
//  {type:"install-cancelled"}              -> back to downloaded
//  {type:"error", message}                 -> phase error, error message; keeps availableVersion (a failed download of a known version shows "Retry")
//  {type:"updated", version}               -> updatedTo version (phase unchanged)
//  {type:"notice-claimed"}                 -> updatedTo null
export function updatePending(state)        // phase is available | downloading | downloaded
export function trayUpdateItem(state)       // { label, enabled, action: "check"|"download"|"install"|null }
//  unsupported -> null (hidden)
//  idle/error-without-version -> "Check for Updates…", check
//  checking -> "Checking for Updates…", disabled
//  current -> "Up to date (v<current>)", check (click re-checks)
//  available -> "Download Update v<X>", download
//  downloading -> "Downloading Update v<X>… <n>%", disabled
//  downloaded -> "Restart to Update (v<X>)", install
//  installing -> "Installing Update v<X>…", disabled
//  error with version -> "Retry Update v<X>", download
export function tooltipSuffix(state)        // " — Update v<X> ready" when downloaded, " — Update v<X> available" when available/downloading, "" otherwise
```

## desktop/lib/updater.mjs (MODIFY)

Keep updaterSupported, resolveAutoUpdater and the two consent dialogs. Controller gains a state
store and listeners; the inactive controller exposes the same surface.

```js
// returned controller
{
  active,
  snapshot(),                    // current state object (copy)
  onState(fn) -> unsubscribe,
  checkForUpdates({ manual }),   // as today, plus state events; manual + current => "ima2 is up to date." dialog as today
  downloadUpdate(),              // no-op unless phase available|error-with-version; dedupes an in-flight download
  installUpdate(),               // no-op unless downloaded; installing -> prepareForInstall() -> quitAndInstall(); prepare false -> install-cancelled
  setAutoDownload(enabled),
  markUpdated(version),          // dispatch {type:"updated"}
  claimNotice(),                 // returns updatedTo and dispatches notice-claimed
  dispose(),                     // removes autoUpdater listeners, clears listeners
}
```

autoUpdater events: "checking-for-update" -> checking; "update-available"(info) -> available(info.version);
"update-not-available" -> not-available(now); "download-progress"(p) -> progress(p.percent);
"update-downloaded"(info) -> downloaded(info.version) then the existing Restart-and-Install dialog
(response 0 -> installUpdate()); "error" -> error(message). A manual check that finds an update with
autoDownload off keeps today's Download prompt (response 0 -> downloadUpdate()).
Remove the old onUpdateReady option; main.mjs subscribes through onState instead.
The existing tests (tests/desktop-updater.test.ts) keep passing after replacing onUpdateReady
expectations with state assertions.

## desktop/lib/update-receipt.mjs (NEW)

```js
export function evaluateLaunchVersion({ lastRunVersion, currentVersion, compare })
// -> { updatedTo: string | null, nextLastRunVersion: currentVersion }
// lastRunVersion "" (first launch) -> updatedTo null; compare(current, last) > 0 -> updatedTo current; else null
export function compareVersions(a, b) // small semver compare in plain JS (desktop cannot import TS lib/)
```

desktop/lib/settings.mjs: add `lastRunVersion: ""` to DEFAULT_SETTINGS and "lastRunVersion" to STR_KEYS.

## Menu bar and tray (desktop/lib/tray.mjs, icons.mjs, make-icons.mjs)

- make-icons.mjs: after the trayTemplate loop add trayUpdateTemplate.png (22) and
  trayUpdateTemplate@2x.png (44): the same black glyph resized into the frame, composited with a
  black template dot. Render the glyph, composite a clearing circle of radius r + ring with blend "dest-out" so the dot stands apart from the glyph, then composite the solid black dot with blend "over". r = round(size*0.18), ring = max(1, round(size*0.06)), centre (size - r - 1, r + 1): top-right, like opencodex's dot.
- icons.mjs: REQUIRED gains "trayUpdateTemplate.png", "trayUpdateTemplate@2x.png"; trayIconName("darwin",
  {update:true}) returns "trayUpdateTemplate.png".
- tray.mjs: replace setUpdatePending(boolean) with setUpdateState(state). It stores the state, swaps
  the image on every platform when updatePending(state) flips (template flag still set on darwin by
  loadTrayIcon), and re-renders. menuTemplate replaces the old updater item with trayUpdateItem(state)
  (hidden when null; click maps action -> actions.checkForUpdates / downloadUpdate / installUpdate), adds
  "What's New in v<X>" (visible while state.updatedTo or this.whatsNew is set; opens
  actions.openReleaseNotes(version)), and the tooltip appends tooltipSuffix(state). Keep setUpdatePending
  as a thin alias only if an external caller exists (none today: main.mjs:84 is the only caller).
- menu.mjs: installApplicationMenu(actions, updateState) builds the app menu updater item from
  trayUpdateItem(updateState) (macOS app menu; on Windows/Linux the Server menu gains the same item
  above "Open Server Log"); main.mjs re-installs the menu on each state change (Menu.setApplicationMenu
  is cheap and the template is small).

## Tray popup (desktop/pages/tray.*)

tray.html: add `<section id="update" class="tray__update" hidden><span id="update-text"></span><button id="update-action" class="primary"></button></section>`
between the header and the Generating section. tray.js: bridge.getUpdateState() on show and
bridge.onUpdateState(render); render hides the section unless phase is available, downloading,
downloaded or error-with-version; text "Update v<X> available" / "Downloading v<X>… n%" /
"Update v<X> is ready" / "Update failed: <msg>"; button "Download" / disabled / "Restart to Update"
/ "Retry" calling bridge.downloadUpdate / bridge.installUpdate. tray.css: a compact accent row.

## IPC and bridges

ipc.mjs: add handlers
`desktop:update:get` -> actions.updateState(); `desktop:update:download` -> actions.downloadUpdate();
`desktop:update:install` -> actions.installUpdate(); `desktop:update:claim-notice` -> actions.claimUpdateNotice();
all four with {allowServed: true}. They reach only the updater: no settings, files or server process. installUpdate runs only on the user's own click and still goes through prepareForInstall, exactly like the tray item. `desktop:check-updates` also gets allowServed.
Outbound `desktop:update:state` is broadcast by main.mjs to windows (windows.broadcast), the popup and
the main window's served page.

preload.cjs: both branches gain
`getUpdateState, checkForUpdates, downloadUpdate, installUpdate, claimUpdateNotice, onUpdateState(cb) -> unsubscribe`.
The served branch keeps everything else hidden (settings/server/disk stay file:-only).

## main.mjs wiring

```js
const settings0 = settingsStore.get();
const launch = evaluateLaunchVersion({ lastRunVersion: settings0.lastRunVersion, currentVersion: app.getVersion(), compare: compareVersions });
settingsStore.update({ lastRunVersion: launch.nextLastRunVersion });
const updater = await createUpdaterController({ app, dialog, prepareForInstall: () => lifecycle.prepareForUpdateInstall(), autoDownload: settings0.autoUpdate });
if (launch.updatedTo) updater.markUpdated(launch.updatedTo);
// after tray/popup/windows exist:
const pushUpdateState = (state) => {
  tray.setUpdateState(state);
  installApplicationMenu(actions, state);
  windows.broadcast("desktop:update:state", state);
  popup.win?.webContents.send("desktop:update:state", state);
};
updater.onState(pushUpdateState);
pushUpdateState(updater.snapshot());
if (launch.updatedTo) showUpdatedNotification(launch.updatedTo, actions); // Electron Notification "ima2 updated to v<X>", body "See what's new", click -> openReleaseNotes
```
actions gain updateState, downloadUpdate, installUpdate, claimUpdateNotice, openReleaseNotes(version)
(shell.openExternal("https://github.com/lidge-ai/ima2-gen/releases/tag/v" + version)). Background
checks: keep the startup check and add a 6-hour interval (opencodex updater.rs:346) while autoUpdate is
on; unref the timer; clear it in before-quit. The settings page label for Auto-update stays; its small
text becomes "Download new versions in the background and show a dot in the menu bar when ready".

## Tests

tests/desktop-update-state.test.ts (NEW): reducer table for every event; trayUpdateItem labels and
actions per phase; tooltipSuffix; evaluateLaunchVersion first-run/upgrade/same/downgrade; compareVersions.
tests/desktop-updater.test.ts (MODIFY): state sequence checking -> available -> downloading(42) ->
downloaded; download dedupe; installUpdate calls prepare before install and returns to downloaded when
prepare is false; inactive controller has the full surface; claimNotice once; dispose removes listeners.
tests/desktop-tray.test.ts (MODIFY): trayIconName darwin update -> trayUpdateTemplate.png; generated
icon set contains both update templates (existing make-icons test path) and the dot pixel region is
opaque while a pixel between dot and glyph is transparent.

## Amendments after architect reflection

- R7 (sticky states): reduceUpdateState ignores checking, not-available and available events
  while phase is downloading, downloaded or installing, unless an available event carries a
  different, newer version (then it moves to available for that version). checkForUpdates returns
  false without calling electron-updater while phase is downloading, downloaded or installing.
  main.mjs owns a `startBackgroundChecks()`/`stopBackgroundChecks()` pair (6 h interval, unref'd);
  onSettingsChanged starts or stops it when autoUpdate changes, next to the existing
  updater.setAutoDownload call (main.mjs:139). Tests cover the guard table and the toggle.

