# 040 web UI update indicator and updated toast (wp2 task t4)


## Amendments after audit round 1 (override R6 where they differ)

- A7 (mobile, every mode): MobileAppBar is not changed. On mobile (useIsMobile), UpdateNoticeHost
  renders `<UpdateIndicator variant="floating" />`: a fixed pill at the top-right below the safe-area
  inset (z-index under modals), shown in every uiMode while settings are closed, hidden when the view is
  hidden. On wider layouts SidebarTopStrip renders the `variant="strip"` button. IN map (final):
  ui/src/lib/updateStatus.ts, ui/src/lib/updateStore.ts, ui/src/components/UpdateIndicator.tsx,
  ui/src/components/UpdateNoticeHost.tsx, ui/src/styles/update-indicator.css (NEW);
  ui/src/lib/desktopShell.ts, ui/src/components/SidebarTopStrip.tsx, ui/src/App.tsx (mount
  `<UpdateNoticeHost />` next to `<Toast />` and import the stylesheet), four locale files (MODIFY).

## Scope

IN: ui/src/lib/updateStatus.ts (NEW), ui/src/hooks/useUpdateStatus.ts (NEW),
ui/src/components/UpdateIndicator.tsx (NEW), ui/src/styles/update-indicator.css (NEW);
ui/src/lib/desktopShell.ts, ui/src/components/SidebarTopStrip.tsx, ui/src/App.tsx (only if the
stylesheet import lives there), ui/src/i18n/{en,ko,zh-Hans,zh-Hant}.json (MODIFY);
tests/update-ui-contract.test.ts (NEW).
OUT: server, bin, desktop.

## ui/src/lib/updateStatus.ts (NEW, pure + fetchers)

```ts
export interface UpdateBadge { /* mirrors lib/updateCache.ts UpdateBadge */ }
export interface DesktopUpdateState { active: boolean; currentVersion: string; phase: string; availableVersion: string | null; progress: number | null; error: string | null; updatedTo: string | null }
export type UpdateView =
  | { kind: "hidden" }
  | { kind: "npm"; version: string; command: string; releaseUrl: string | null }
  | { kind: "desktop"; version: string; phase: "available" | "downloading" | "downloaded" | "error"; progress: number | null };
export function viewFromBadge(badge: UpdateBadge | null): UpdateView;      // npm + enabled + available -> npm, else hidden
export function viewFromDesktop(state: DesktopUpdateState | null): UpdateView; // pending phases or error-with-version -> desktop, else hidden
export function fetchUpdateBadge(): Promise<UpdateBadge>;                   // jsonFetch("/api/update/badge")
export function dismissUpdate(version: string): Promise<void>;              // POST /api/update/dismiss
export function claimServerNotice(): Promise<string | null>;                // POST /api/update/notice -> updatedTo
export const BADGE_POLL_MS = 10 * 60_000;
```

desktopShell.ts DesktopBridge gains optional `getUpdateState?, checkForUpdates?, downloadUpdate?,
installUpdate?, claimUpdateNotice?, onUpdateState?(cb) => () => void` (keep in sync with preload.cjs).

## ui/src/hooks/useUpdateStatus.ts (NEW)

```ts
export function useUpdateStatus(): { view: UpdateView; dismiss(): void; download(): void; install(): void }
```
- Desktop bridge with getUpdateState: read it once, subscribe with onUpdateState, never poll HTTP.
  Claim the notice once per mount through bridge.claimUpdateNotice; a non-null version shows the toast.
- Otherwise: fetchUpdateBadge on mount and every BADGE_POLL_MS (clearInterval on unmount); failures keep
  the last view. Claim the notice once through claimServerNotice. A LAN 401 from fetchApi is swallowed.
- Toast: useAppStore.getState().showToast(t("update.updatedTo", {version}), false).
- dismiss() (npm view only): dismissUpdate(version) then hide.

## ui/src/components/UpdateIndicator.tsx (NEW)

A `sidebar-top__btn update-indicator` button rendered in SidebarTopStrip before the trailing settings
button (and gets `sidebar-top__btn--trailing` itself when there is no desktop settings button so it
stays right-aligned). Hidden view renders null. Icon: an up-arrow-in-circle SVG with a 7px accent dot
(opencodex dot). aria-label/title: npm "Update available: v<X>"; desktop available "Download update
v<X>", downloading "Downloading update v<X>… n%", downloaded "Restart to update (v<X>)", error "Retry
update v<X>".
Click: desktop available/error -> download(); downloaded -> install(); downloading -> nothing.
npm -> toggles a small popover (role="dialog", aria-labelledby) with the text "ima2 v<X> is available",
a `<code>` line with the command, a Copy button (navigator.clipboard.writeText, toast t("update.copied")),
a "What's new" link (releaseUrl, target _blank rel noopener) and "Dismiss" (dismiss()). Escape and an
outside click close it.

## i18n (all four locales, same keys)

`update.available` "Update available: v{version}", `update.download` "Download update v{version}",
`update.downloading` "Downloading update v{version}… {progress}%", `update.ready` "Restart to update (v{version})",
`update.retry` "Retry update v{version}", `update.popoverTitle` "ima2 v{version} is available",
`update.runCommand` "Run this in a terminal:", `update.copy` "Copy", `update.copied` "Command copied",
`update.whatsNew` "What's new", `update.dismiss` "Dismiss", `update.updatedTo` "ima2 updated to v{version}".
Check the i18n interpolation syntax in ui/src/i18n/index.ts before writing the placeholders.

## Tests (tests/update-ui-contract.test.ts)

viewFromBadge: hidden for null, disabled, desktop surface, not available; npm view carries command.
viewFromDesktop: hidden for idle/current/unsupported/checking; each pending phase; error needs a version.
Source contract: SidebarTopStrip renders `<UpdateIndicator`; useUpdateStatus never calls fetchUpdateBadge
when the bridge has getUpdateState; all four locale files define every `update.*` key.

## Screenshot

C captures the npm popover and the badge in a running dev UI (agbrowse) with a seeded version.json
(latest_version newer than package.json) for the PR description (screenshot gate, AGENTS.md
"Pull requests"). Evidence goes to the pr-assets branch, never the PR branch.

## Amendments after architect reflection

- R6 (mobile and notice host): update state lives in a module singleton
  (`ui/src/lib/updateStore.ts`: subscribe/getSnapshot + one poller or one bridge subscription,
  started on first subscribe and stopped on last unsubscribe) read through useSyncExternalStore, so
  several indicators share one poll. `UpdateIndicator` renders in SidebarTopStrip and in
  MobileAppBar (`variant="mobile"`). A separate `UpdateNoticeHost` component, mounted
  unconditionally in App.tsx next to `<Toast />`, performs the one-time notice claim and toast, so the
  notice fires in every layout even when no indicator is mounted.
