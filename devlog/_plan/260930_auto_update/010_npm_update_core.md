# 010 npm update core — lib + routes + server (wp2 task t1)


## Amendments after audit round 1 (override R1 where they differ)

- A5 (lock, replaces the R1 fallback): the lock directory `<path>.lock/` holds `owner.json`
  {pid, at}. Acquisition retries every 25 ms for up to 1 s. A lock is stale only when `at` is older
  than 10 s AND `process.kill(pid, 0)` throws ESRCH; a stale lock is removed once and acquisition
  retried. Failing to acquire never writes unlocked: updateVersionCache returns the unchanged cache
  and logs "[update] cache busy, skipped write"; claimUpdatedNotice returns null (the claim stays
  available for the next start). Test: spawn 4 child processes (node --import tsx -e) that call
  claimUpdatedNotice on one temp cache concurrently; exactly one prints the version. Plus unit
  tests for stale-lock recovery (dead pid) and live-lock skip.

## Scope

IN: lib/updateVersion.ts, lib/updateCache.ts, lib/updateCheck.ts (NEW); routes/update.ts (NEW);
routes/index.ts, server.ts, config.ts (MODIFY); tests/update-core.test.ts, tests/update-routes.test.ts (NEW).
OUT: bin/, desktop/, ui/.

## Contracts (shared by 020, 030, 040)

```ts
// lib/updateVersion.ts (NEW)
export type UpdateTag = "latest" | "preview";
export const PACKAGE_NAME = "ima2-gen";
export function parseVersion(v: string): { core: [number, number, number]; pre: string[] } | null;
export function compareVersions(a: string, b: string): number; // semver precedence; prerelease < release; invalid sorts lowest
export function isNewer(candidate: string | null | undefined, current: string): boolean;
export function defaultTag(current: string): UpdateTag;        // /-preview/ in the version => "preview"
export function isUpdateTag(v: unknown): v is UpdateTag;
export function releaseUrl(version: string): string;           // https://github.com/lidge-ai/ima2-gen/releases/tag/v<version>

// lib/updateCache.ts (NEW)
export interface VersionCache {
  latest_version: string | null;
  last_checked_at: number | null;   // epoch ms of the last SUCCESSFUL check
  dismissed_version: string | null;
  tag: UpdateTag | null;
  last_seen_version: string | null;
}
export function versionCachePath(configDir?: string): string;  // join(configDir ?? config.storage.configDir, "version.json")
export function readVersionCache(path?: string): VersionCache; // missing or corrupt => all null; drops fields of the wrong type
export function updateVersionCache(patch: Partial<VersionCache>, path?: string): VersionCache; // re-read, merge, atomic write
export interface UpdateBadge {
  surface: "npm" | "desktop";
  enabled: boolean;          // false when the env opt-out is set or the launcher is desktop
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;        // isNewer(latest, current) && !dismissed && surface === "npm"
  dismissed: boolean;        // dismissed_version === latest_version
  stale: boolean;            // never checked, other tag, or older than 40 h
  checkedAt: number | null;
  tag: UpdateTag;
  command: string;           // "ima2 update" or "ima2 update --tag preview"
  releaseUrl: string | null; // releaseUrl(latest) when latest is set
}
export function buildBadge(input: { cache: VersionCache; current: string; tag: UpdateTag; enabled: boolean; surface: "npm" | "desktop"; now: number; staleMs?: number }): UpdateBadge;
export function claimUpdatedNotice(current: string, path?: string): string | null;
//  last_seen_version null  -> record current, return null (first run shows nothing)
//  last_seen < current     -> record current, return current (once)
//  last_seen >= current    -> record current if different, return null (downgrade or same)

// lib/updateCheck.ts (NEW)
export interface CheckDeps { fetchImpl?: typeof fetch; now?: () => number; cachePath?: string; registry?: string; timeoutMs?: number; signal?: AbortSignal }
export async function fetchLatestVersion(tag: UpdateTag, deps?: CheckDeps): Promise<string>;
export async function checkForUpdate(tag: UpdateTag, deps?: CheckDeps): Promise<VersionCache>; // writes latest_version, last_checked_at, tag
export function isCacheFresh(cache: VersionCache, tag: UpdateTag, now: number, maxAgeMs?: number): boolean;
export function updateChecksEnabled(env: NodeJS.ProcessEnv, launcher: string): boolean;
export interface SchedulerOptions { tag: UpdateTag; deps?: CheckDeps; tickMs?: number; backoffMinMs?: number; backoffMaxMs?: number; freshMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void; log?: (m: string) => void }
export function startUpdateScheduler(opts: SchedulerOptions): { stop(): void; checkNow(): Promise<VersionCache | null>; nextDelayMs(): number };
```

config.ts gains `update` inside the exported config object:

```ts
update: {
  registry: (env.IMA2_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, ""),
  freshMs: 20 * 60 * 60_000,
  staleMs: 40 * 60 * 60_000,
  tickMs: 60 * 60_000,
  backoffMinMs: 60_000,
  backoffMaxMs: 60 * 60_000,
  timeoutMs: 8_000,
  disabled: env.IMA2_DISABLE_UPDATE_CHECK === "1",
},
```

## Behaviour

- fetchLatestVersion: GET `<registry>/ima2-gen/<tag>` with headers {accept: "application/json"} and
  AbortSignal.any([timeout, deps.signal]). A non-2xx status, a non-object body or a
  body.version that fails parseVersion throws Error("registry returned ...").
- checkForUpdate: fetch, then updateVersionCache({latest_version, last_checked_at: now(), tag}).
  A failure leaves the cache untouched and rethrows.
- isCacheFresh: cache.tag === tag && last_checked_at !== null && now - last_checked_at < freshMs.
- updateChecksEnabled: env.IMA2_DISABLE_UPDATE_CHECK !== "1" && launcher !== "desktop".
- Scheduler: schedule(0) at start. run(): when the cache is fresh, skip the network;
  otherwise checkNow(). Success or skip => next delay tickMs and backoff reset. Failure =>
  delay = backoff (start backoffMinMs, double each consecutive failure, cap backoffMaxMs),
  log "[update] check failed: <message>". checkNow() coalesces concurrent calls into one
  promise and resolves null on failure. Timer handles get unref() when they have it.
  stop() sets stopped, clears the timer and aborts the controller; later runs no-op.
- updateVersionCache: mkdirSync(dirname, recursive); fresh = readVersionCache(path);
  next = {...fresh, ...patch}; tmp = path + "." + process.pid + "." + random hex + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", {mode: 0o600}); renameSync(tmp, path).
  On error unlink tmp best-effort and rethrow.

## routes/update.ts (NEW)

```ts
export interface UpdateRouteDeps { check?: typeof checkForUpdate; cachePath?: string; now?: () => number; env?: NodeJS.ProcessEnv }
export function registerUpdateRoutes(app: Express, ctxRaw: RouteRuntimeContext, deps: UpdateRouteDeps = {}): void;

GET  /api/update/badge    -> 200 UpdateBadge, read from the cache only
POST /api/update/check    -> 200 UpdateBadge after checkForUpdate
                             503 {ok:false, code:"UPDATE_CHECK_FAILED", message, badge} on failure
                             desktop surface: 200 badge (enabled:false) without network
POST /api/update/dismiss  body {version} -> 400 {ok:false, code:"INVALID_VERSION"} unless parseVersion(version)
                             else write dismissed_version and return 200 badge
POST /api/update/notice   -> 200 {updatedTo: string | null}; desktop surface always null
```

surface = ctx.launcher === "desktop" ? "desktop" : "npm"; current = ctx.packageVersion;
tag = defaultTag(current). An explicit POST /check still works when IMA2_DISABLE_UPDATE_CHECK=1:
the opt-out stops automatic checks only (opencodex refresh-scheduler.ts:6). The badge keeps
enabled:false in that case so the UI does not poll a disabled scheduler's stale data as live.
The global access guard (server.ts:269) already protects /api; these routes need no extra guard
because they never act on the host beyond writing version.json.

## Wiring

- routes/index.ts: `import { registerUpdateRoutes } from "./update.js";` and
  `registerUpdateRoutes(app, ctx);` right after `registerHealthRoutes(app, ctx);`.
- server.ts startServer: declare `let updateScheduler: { stop(): void } | null = null;` next to
  `let reapTimer`, add `updateScheduler?.stop();` as the first line inside onShutdown, and after
  `advertise(ctx);` add:

```ts
if (updateChecksEnabled(process.env, ctx.launcher)) {
  updateScheduler = startUpdateScheduler({ tag: defaultTag(ctx.packageVersion), log: (m) => console.log(m) });
}
```

## Tests

tests/update-core.test.ts (runtime import of lib/): compareVersions table (3.25.0 < 3.26.0,
3.26.0-preview.1 < 3.26.0, 3.10.0 > 3.9.9, invalid lowest); defaultTag; releaseUrl; corrupt and
wrong-typed cache => nulls; updateVersionCache keeps dismissed_version when a check writes
latest; claimUpdatedNotice first run null, upgrade once, repeat null, downgrade null;
buildBadge available/dismissed/stale/desktop; fetchLatestVersion 404 and garbage rejected,
URL and tag used; scheduler with fake timers: immediate check when stale, skip when fresh,
backoff 60s -> 120s -> ... capped, success resets to tickMs, coalesced checkNow, stop()
aborts and prevents further runs; updateChecksEnabled env/desktop false.

tests/update-routes.test.ts: express app with registerUpdateRoutes on an ephemeral port and a
temp cache path; badge shape; dismiss 400 then 200; check success and 503 with an injected
failing check; desktop ctx returns enabled:false and notice null without calling check.

## Amendments after architect reflection

- R1 (cache races): updateVersionCache serializes writers with a lock directory
  `<path>.lock` created by mkdirSync (atomic on every platform). Acquire retries every 25 ms for up
  to 1 s; a lock older than 10 s is treated as abandoned and removed once. Inside the lock:
  re-read, merge the patch, write the temp file, rename, then rmdir the lock in finally. When the
  lock cannot be taken in 1 s the write still happens (re-read + merge + rename) and logs once;
  a rare lost field is better than a wedged CLI. claimUpdatedNotice does its read-compare-write
  inside the same lock so two processes cannot both claim.
- R2 (channel): buildBadge sets available only when `cache.tag === tag`; a cache written for the
  other channel reports stale:true and available:false.
- R3 (coalescing): checkForUpdate keeps a module-level `Map<UpdateTag, Promise<VersionCache>>` of
  in-flight checks, so the scheduler, POST /api/update/check and the CLI (same process) share one
  registry request per tag. The scheduler's checkNow calls checkForUpdate and inherits this.

## Amendments after audit round 2 (override A5 where they differ)

- A5b (lock file with identity-checked reclaim): the lock is a FILE `<path>.lock` created with
  `openSync(lock, "wx", 0o600)`, which is atomic on every platform; the owner JSON {pid, at, token}
  is written to that descriptor. Release: read the file, and unlink only when its token is ours.
  Stale when either (a) the owner parses, is older than 10 s and `process.kill(pid, 0)` throws
  ESRCH, or (b) the owner is missing or malformed and the file mtime is older than 10 s (covers a
  crash between create and write). Reclaim is identity-checked: record the stale file's inode
  (`statSync(lock).ino`), `renameSync(lock, lock + "." + token + ".stale")` (only one reclaimer's
  rename can succeed on a given file), then stat the renamed file; when its inode differs from the
  one observed, we moved someone's fresh lock, so put it back with `linkSync(renamed, lock)` (EEXIST
  means yet another process holds a newer lock: leave it) and unlink the renamed path. Tests: dead
  pid reclaimed; malformed/empty owner with old mtime reclaimed; young malformed owner kept; a
  deterministic two-reaper interleaving (reaper B renames after reaper A reclaimed and re-acquired)
  restores A's fresh lock; the 4-process claim test prints the version exactly once.
- Residual (recorded, accepted): on filesystems without hard links (some network mounts) the restore
  step falls back to leaving the fresh owner's lock renamed; its owner then finds its token missing
  on release and logs it. The worst outcome is one duplicate "updated" toast, never a lost install.
