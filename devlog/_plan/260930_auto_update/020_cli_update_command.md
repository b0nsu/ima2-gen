# 020 ima2 update CLI (wp2 task t2)


## Amendments after audit round 1 (override R4/R5 where they differ)

- A2 (service ownership from the artifact): serviceOwned(pkgDir, configDir) reads the actual
  artifact — the launchd plist (launchdPlistPath()) or systemd unit (systemdUnitPath()) — and
  requires both: the server.js path in it (plist `<key>ProgramArguments</key>` second `<string>`,
  bin/lib/serviceTemplates.ts:41-44; unit `ExecStart=<node> <serverJs>`, serviceTemplates.ts:67)
  resolves inside realpath(pkgDir), and parseServiceConfigDir(artifact) (serviceManager.ts:70)
  canonicalizes to the current config dir. Unreadable or unparsable artifacts count as not owned
  and print "A login service exists but belongs to another install; not restarting it."
  service-state.json is not consulted.
- A3 (npm on every platform): `npmInvocation(platform, execPath)` returns how to run npm:
  on win32, when `<dirname(execPath)>/node_modules/npm/bin/npm-cli.js` exists, run
  `process.execPath [npm-cli.js, ...args]` with shell:false; otherwise `npm.cmd` with shell:true and
  only fixed arguments plus a parseVersion-validated version. POSIX: `npm` with shell:false.
  globalRoot() and installGlobal() both use it. Tests cover the three shapes.
- A4 (runtime adapter): `runtimeSnapshot()` wraps collectRuntimeStatus() (bin/commands/runtimeStatus.ts:22):
  {live: report.liveness === "live", launcher: report.runtime?.launcher ?? null, url: report.runtime?.url ?? null,
  version: report.runtime?.version ?? null, managed: report.serviceOwnership === "managed"}. planRestart reads it;
  the post-restart proof polls it every 500 ms for up to 20 s and requires live && version === latest.
- A6 (channel in notices): updateNoticeLine also requires `cache.tag === defaultTag(current)`; tests cover
  stable-with-preview-cache and preview-with-latest-cache suppression.
- A8 (help): runUpdate returns 0 after printing usage for `-h`/`--help` before any check, cache access or
  notice. updateNoticeLine and the updated-notice claim are suppressed when args contain -h, --help, -v or
  --version. tests/update-cli.test.ts asserts `ima2 update --help` touches no cache (temp IMA2_CONFIG_DIR stays
  empty); tests/cli-help-safety-contract.test.ts gains "update" if it enumerates help-owning commands.

## Scope

IN: bin/lib/npmUpdate.ts (NEW), bin/lib/updateNotice.ts (NEW), bin/commands/update.ts (NEW);
bin/ima2.ts, bin/lib/helpText.ts (MODIFY); tests/update-cli.test.ts (NEW).
OUT: lib/ (consumed through the 010 contracts only), desktop/, ui/.

## bin/lib/npmUpdate.ts (NEW)

```ts
export interface ExecResult { status: number | null; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], opts?: { inherit?: boolean }) => ExecResult;
export const defaultExec: Exec;                         // spawnSync, shell:false, windowsHide
export function npmCommand(platform?: NodeJS.Platform): string; // "npm.cmd" on win32, else "npm"
export function globalRoot(exec: Exec, platform?: NodeJS.Platform): string | null; // npm root -g
export type InstallKind =
  | { kind: "global"; pkgDir: string; root: string }
  | { kind: "source"; pkgDir: string }
  | { kind: "other"; pkgDir: string; reason: "npx" | "local" | "unknown" };
export interface FsLike { exists(p: string): boolean; realpath(p: string): string }
export function classifyInstall(pkgDir: string, exec: Exec, fs?: FsLike, platform?: NodeJS.Platform): InstallKind;
export function installGlobal(version: string, exec: Exec, platform?: NodeJS.Platform): void;
export function readInstalledVersion(pkgDir: string): string | null;
export type RestartPlan = { kind: "service" } | { kind: "background" } | { kind: "foreground"; url: string } | { kind: "none" };
export function planRestart(input: { serviceInstalled: boolean; launcher: string | null; url: string | null }): RestartPlan;
export function runNewCli(pkgDir: string, args: string[], exec: Exec): number;
```

- classifyInstall: source when `server.ts` or `.git` exists in pkgDir (a published package ships
  server.js and never server.ts — package.json "files"); global when globalRoot() is non-null
  and realpath(pkgDir) === realpath(join(root, "ima2-gen")); other/npx when the path contains
  `/_npx/` (or `\_npx\`); other/local when it sits under a node_modules that is not the global root.
- installGlobal: exec(npmCommand(), ["install", "--global", "ima2-gen@" + version, "--no-fund", "--no-audit"], {inherit:true});
  version must pass parseVersion first. Non-zero status throws an Error whose message
  suggests "sudo npm i -g ima2-gen@<v>" or fixing the npm prefix when stderr matches /EACCES|EPERM/,
  else "npm install failed (exit N)". On win32 the npm.cmd call uses shell:true only for that
  fixed argv (Node refuses .cmd without a shell); the version is validated, so nothing is interpolated.
- planRestart: serviceInstalled -> service; launcher "background" -> background; launcher
  "foreground" with url -> foreground; everything else (desktop, none) -> none.
- runNewCli: exec(process.execPath, [join(pkgDir, "bin", "ima2.js"), ...args], {inherit:true}).status ?? 1.

serviceInstalled: existsSync(launchdPlistPath()) on darwin, existsSync(systemdUnitPath()) on
linux (bin/lib/serviceManager.ts:26,30), false elsewhere. This is an artifact check on purpose:
inspectManager() reports an unloaded plist as absent (serviceManager.ts:102).
Runtime: collectRuntimeStatus() from bin/commands/runtimeStatus.ts supplies launcher and url.

## bin/commands/update.ts (NEW)

```
ima2 update             check (forced), show "vA -> vB", confirm on a TTY (--yes skips; non-TTY without --yes refuses with exit 2), install, verify, restart, "Updated to vB"
ima2 update --check     forced check only: "Up to date (vA)" or "Update available: vB (current vA). Run: ima2 update"
ima2 update --tag latest|preview
ima2 update --json      {current, latest, tag, available, updated?, restart?}
```

`export async function runUpdate(args: string[], deps: UpdateDeps): Promise<number>` returns the exit
code; the default export wires real deps and sets process.exitCode. UpdateDeps = {current, pkgDir,
exec, fs, check(tag), isTTY, confirm(question), serviceInstalled(), runtime(), log, error}.

Flow: parse flags (unknown flag -> usage, exit 2). --check: check and print, exit 0 (check failure exit 1).
Otherwise classifyInstall(pkgDir): source -> exit 2 "This is a source checkout. Update it with:
git pull && npm install && npm run build"; other -> exit 2 "ima2 is not a global npm install (<reason>).
Install globally with: npm i -g ima2-gen@<tag>". Check (failure exit 1). Not newer -> "Up to date (vA)"
exit 0. Confirm. installGlobal(latest). readInstalledVersion(pkgDir) must equal latest, else exit 1
"npm finished but ima2 is still vX". updateVersionCache({last_seen_version: latest}). Print
"Updated to v<latest>". Restart per plan: service -> runNewCli(["service","restart"]); background ->
runNewCli(["restart"]); foreground -> "Restart your running 'ima2 serve' (<url>) to use v<latest>.";
none -> nothing. A non-zero restart -> exit 1 "Updated to vB, but the restart failed. Run: ima2 service restart"
(or "ima2 restart").

## bin/lib/updateNotice.ts (NEW)

```ts
export function updateNoticeLine(input: { command: string | undefined; args: string[]; isTTY: boolean; env: NodeJS.ProcessEnv; current: string; cache: VersionCache }): string | null;
```
Returns "Update available: vB (current vA). Run: ima2 update" (with --tag preview when the tag is
preview) only when isTTY, env.IMA2_DISABLE_UPDATE_CHECK !== "1", env.IMA2_DESKTOP !== "1", command in
["serve","start","status","open","doctor","ls","ps"], args lack --json/--quiet/-q, cache.latest_version
is newer than current and not dismissed. Cache only, never network.

## Wiring

- bin/ima2.ts: add "update" to helpOwningCommands; before `switch (command)` add

```ts
{
  const { printUpdateNotice } = await import("./lib/updateNotice.js");
  printUpdateNotice(command, args, pkg.version);
}
```
  (printUpdateNotice reads the cache, calls updateNoticeLine, writes to stderr, and swallows
  errors) and a switch case:

```ts
case "update": {
  const { default: updateCmd } = await import("./commands/update.js");
  await updateCmd(args.slice(1));
  exitFlushed(Number(process.exitCode ?? 0));
  break;
}
```
- bin/lib/helpText.ts "Server commands": `update         Update ima2 to the latest npm release (--check, --tag preview)`.

## Tests (tests/update-cli.test.ts)

classifyInstall source, global (realpath match), npx, local; installGlobal argv exact and EACCES hint;
invalid version refused before exec; planRestart four cases; updateNoticeLine positive and every
suppression (non-TTY, env opt-out, desktop env, --json, dismissed, same version, other command);
runUpdate with fake deps: --check up to date and available; source refusal exit 2; non-TTY without
--yes exit 2; install -> verify -> cache last_seen -> service restart call order; version mismatch
exit 1; restart failure exit 1 with message; foreground hint.

## Amendments after architect reflection

- R4 (restart ownership and proof): serviceInstalled becomes serviceOwned(pkgDir): the artifact
  exists AND `<configDir>/service-state.json` (written by bin/commands/service.ts writeState) has a
  serverJs whose realpath sits inside realpath(pkgDir) and a configDir equal to the current config
  dir. A service owned by another install or config dir is left alone with a hint. After any
  restart, runUpdate polls the runtime (collectRuntimeStatus / health) for up to 20 s and requires
  `health.version === latest`; a timeout or another version is a restart failure (exit 1 with the
  hint), because `service start` reports failed health without a failing exit code
  (bin/commands/service.ts:308).
- R5 (post-update notice in the CLI): printUpdateNotice also calls claimUpdatedNotice(current) for
  the same eligible interactive commands and prints "ima2 updated to v<current> — what's new:
  <releaseUrl>" when it returns a version. An external `npm i -g` therefore announces itself on the
  next interactive start; `ima2 update` records last_seen_version itself so nothing repeats. The claim
  is shared with the web toast: whichever surface starts first shows it once.
- R8 (JSON): with --json every subprocess runs with inherit:false (output captured), no human line is
  printed, confirmation requires --yes, and exactly one JSON document goes to stdout:
  `{current, latest, tag, available, updated, restart: {kind, ok, version} | null, error?}`.
