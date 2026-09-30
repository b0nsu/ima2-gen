import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, FsLike, RuntimeSnapshot } from "../bin/lib/npmUpdate.js";
import type { UpdateDeps } from "../bin/commands/update.js";
import type { VersionCache } from "../lib/updateCache.js";

const root = mkdtempSync(join(tmpdir(), "ima2-update-tests-"));
process.env.IMA2_CONFIG_DIR = root;
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const { classifyInstall, defaultExec, globalRoot, installGlobal, npmInvocation, planRestart,
  readInstalledVersion, runNewCli, runtimeSnapshot, serviceArtifactPath, serviceOwned } = await import("../bin/lib/npmUpdate.js");
const { runUpdate } = await import("../bin/commands/update.js");
const { printUpdateNotice, updateNoticeLine } = await import("../bin/lib/updateNotice.js");
const { claimUpdatedNotice, markSeen, readVersionCache, versionCachePath } = await import("../lib/updateCache.js");
const { renderLaunchdPlist, renderSystemdUnit } = await import("../bin/lib/serviceTemplates.js");
const cache = (latest = "2.0.0", tag: "latest" | "preview" = "latest"): VersionCache => ({
  latest_version: latest, tag, last_checked_at: 1, last_seen_version: null, dismissed_version: null,
});
const runtime = (patch: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  live: true, launcher: "background", url: "http://localhost:3333", version: "2.0.0", managed: false, ...patch,
});
const fakeFs: FsLike = { exists: () => false, realpath: (p) => p, readFile: () => JSON.stringify({ version: "2.0.0" }) };
const noExec: Exec = () => { throw new Error("Unexpected subprocess"); };
function fixture(overrides: Partial<UpdateDeps> = {}) {
  let elapsed = 0;
  const lines: string[] = [], errors: string[] = [], order: string[] = [];
  const calls: Array<{ cmd: string; args: string[]; opts: Parameters<Exec>[2] }> = [];
  const deps: UpdateDeps = {
    current: "1.0.0", pkgDir: "/global/ima2-gen", fs: { ...fakeFs, readFile: () => { order.push("verify"); return '{"version":"2.0.0"}'; } },
    exec: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (args.includes("root")) return { status: 0, stdout: "/global\n", stderr: "" };
      order.push(args.includes("install") ? "install" : "restart");
      return { status: 0, stdout: "captured", stderr: "" };
    },
    check: async () => { order.push("check"); return cache(); }, isTTY: true,
    confirm: async () => { order.push("confirm"); return true; }, serviceOwned: () => true,
    runtime: async () => { order.push("runtime"); return runtime(); },
    markSeen: (v) => { order.push(`seen:${v}`); }, log: (line) => lines.push(line), error: (line) => errors.push(line),
    now: () => elapsed, ...overrides,
    sleep: async (ms) => { elapsed += ms; await overrides.sleep?.(ms); },
  };
  // With an owned service, the live server in these fixtures is that service (launcher
  // "service"), since a service restart is only planned over its own server (review F1).
  const snapshot = deps.runtime;
  deps.runtime = async () => {
    const current = await snapshot();
    return deps.serviceOwned(deps.pkgDir) && current.launcher === "background" ? { ...current, launcher: "service", managed: true } : current;
  };
  return { deps, lines, errors, calls, order };
}

test("classify source before querying npm (server.ts or .git)", () => {
  for (const name of ["server.ts", ".git"]) {
    assert.equal(classifyInstall("/src", noExec, { ...fakeFs, exists: (p) => p === `/src/${name}` }).kind, "source");
  }
});
test("classify global by canonical path, then npx/local/unknown", () => {
  const exec: Exec = () => ({ status: 0, stdout: "/global\n", stderr: "" });
  assert.equal(classifyInstall("/link", exec, { ...fakeFs, realpath: () => "/canonical" }).kind, "global");
  for (const [path, reason] of [["/cache/_npx/a/node_modules/ima2-gen", "npx"], ["C:\\cache\\_npx\\a\\ima2-gen", "npx"],
    ["/project/node_modules/ima2-gen", "local"], ["/unknown", "unknown"]]) {
    assert.deepEqual(classifyInstall(path!, exec, fakeFs), { kind: "other", pkgDir: path, reason });
  }
  assert.equal(globalRoot(() => ({ status: 1, stdout: "", stderr: "failed" }), "linux", fakeFs), null);
});
test("npm invocation covers POSIX, adjacent Windows npm CLI, and cmd fallback", () => {
  assert.deepEqual(npmInvocation("linux", "/node", fakeFs), { command: "npm", args: [], shell: false });
  assert.deepEqual(npmInvocation("win32", "C:\\node\\node.exe", { ...fakeFs, exists: () => true }), {
    command: "C:\\node\\node.exe", args: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js"], shell: false,
  });
  assert.deepEqual(npmInvocation("win32", "C:\\node\\node.exe", fakeFs), { command: "npm.cmd", args: [], shell: true });
  for (const exists of [false, true]) {
    const calls: Array<{ cmd: string; args: string[]; opts: Parameters<Exec>[2] }> = [];
    const exec: Exec = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: "/global", stderr: "" }; };
    const fs = { ...fakeFs, exists: () => exists };
    globalRoot(exec, "win32", fs);
    installGlobal("2.0.0", exec, "win32", fs);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.cmd, exists ? process.execPath : "npm.cmd");
      assert.equal(call.opts?.shell, !exists);
    }
    assert.equal(calls[0]?.opts?.inherit, false);
  }
});
test("install uses fixed argv, rejects invalid versions before exec, and surfaces errors", () => {
  let called = false;
  installGlobal("2.0.0", (cmd, args, opts) => {
    called = true;
    assert.equal(cmd, "npm");
    assert.deepEqual(args, ["install", "--global", "ima2-gen@2.0.0", "--no-fund", "--no-audit"]);
    assert.deepEqual(opts, { inherit: true, shell: false });
    return { status: 0, stdout: "", stderr: "" };
  }, "linux", fakeFs);
  assert.equal(called, true);
  for (const invalid of ["latest", "2.0.0;echo bad", "$(bad)", "2.0.0\n"]) assert.throws(() => installGlobal(invalid, noExec), /Invalid/);
  for (const stderr of ["EACCES", "EPERM"]) assert.throws(() => installGlobal("2.0.0", () => ({ status: 1, stdout: "", stderr })), /sudo npm i -g ima2-gen@2.0.0/);
  assert.throws(() => installGlobal("2.0.0", () => ({ status: 7, stdout: "", stderr: "offline" })), /exit 7/);
});
test("manifest verification handles invalid/missing metadata and new CLI execution uses node", () => {
  assert.equal(readInstalledVersion("/pkg", fakeFs), "2.0.0");
  for (const text of ["bad", "null", '{}', '{"version":"bad"}']) assert.equal(readInstalledVersion("/pkg", { ...fakeFs, readFile: () => text }), null);
  assert.equal(runNewCli("/pkg", ["restart"], (cmd, args, opts) => {
    assert.equal(cmd, process.execPath); assert.deepEqual(args, ["/pkg/bin/ima2.js", "restart"]);
    assert.equal(opts?.inherit, true); return { status: null, stdout: "", stderr: "" };
  }), 1);
  assert.equal(defaultExec(process.execPath, ["-e", 'process.stdout.write("ok")']).stdout, "ok");
});
test("restart plans prioritize owned service and preserve foreground/desktop/non-live runtimes", () => {
  assert.deepEqual(planRestart({ ...runtime({ live: false }), serviceOwned: true }), { kind: "service" });
  assert.deepEqual(planRestart({ ...runtime({ launcher: "service", managed: true }), serviceOwned: true }), { kind: "service" });
  // An owned but stopped service must not restart over a live server that someone else runs:
  // service restart stops whatever answers first (review F1).
  assert.deepEqual(planRestart({ ...runtime({ launcher: "desktop" }), serviceOwned: true }), { kind: "desktop" });
  assert.deepEqual(planRestart({ ...runtime({ launcher: "foreground" }), serviceOwned: true }), { kind: "foreground", url: "http://localhost:3333" });
  assert.deepEqual(planRestart({ ...runtime(), serviceOwned: true }), { kind: "background" });
  assert.deepEqual(planRestart({ ...runtime(), serviceOwned: false }), { kind: "background" });
  assert.deepEqual(planRestart({ ...runtime({ launcher: "foreground" }), serviceOwned: false }), { kind: "foreground", url: "http://localhost:3333" });
  assert.deepEqual(planRestart({ ...runtime({ launcher: "desktop" }), serviceOwned: false }), { kind: "desktop" });
  for (const patch of [{ live: false }, { managed: true }, { launcher: null }, { launcher: "foreground", url: null }]) {
    assert.deepEqual(planRestart({ ...runtime(patch), serviceOwned: false }), { kind: "none" });
  }
});
test("runtimeSnapshot adapts live health and manager ownership without probing the host", async () => {
  const stub = mock.module("../bin/commands/runtimeStatus.js", {
    namedExports: { collectRuntimeStatus: async () => ({ liveness: "live", serviceOwnership: "managed",
      runtime: { launcher: "service", url: "http://test:3333", version: "2.0.0" } }) },
  });
  try {
    assert.deepEqual(await runtimeSnapshot(), { live: true, managed: true, launcher: "service", url: "http://test:3333", version: "2.0.0" });
  } finally { stub.restore(); }
});
function artifactFixture(platform: "darwin" | "linux", serverJs = "/pkg/server.js", configDir = "/cfg") {
  const render = platform === "darwin" ? renderLaunchdPlist : renderSystemdUnit;
  const text = render({ nodePath: "/node", serverJs, rootDir: "/pkg", pathEnv: "/bin", logDir: "/logs", configDir });
  const reads: string[] = [], lines: string[] = [];
  const fs: FsLike = { ...fakeFs, exists: () => true, readFile: (p) => { reads.push(p); return text; } };
  return { fs, reads, lines, opts: { fs, platform, log: (line: string) => lines.push(line) } };
}
test("service ownership reads plist/unit and canonicalizes package and config paths", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const f = artifactFixture(platform);
    f.fs.realpath = (p) => p === "/pkg-alias" ? "/pkg" : p === "/cfg-alias" ? "/cfg" : p;
    assert.equal(serviceOwned("/pkg-alias", "/cfg-alias", f.opts), true);
    assert.deepEqual(f.reads, [serviceArtifactPath(platform)]);
    assert.deepEqual(f.lines, []);
    for (const [server, cfg] of [["/pkg-other/server.js", "/cfg"], ["/pkg/server.js", "/other"], ["/pkg/not-server.js", "/cfg"]]) {
      const other = artifactFixture(platform, server, cfg);
      assert.equal(serviceOwned("/pkg", "/cfg", other.opts), false);
      assert.match(other.lines[0]!, /belongs to another install/);
    }
  }
});
test("missing/unreadable/malformed service artifacts never consult service-state.json", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const f = artifactFixture(platform);
    f.fs.readFile = () => { throw new Error("unreadable"); };
    assert.equal(serviceOwned("/pkg", "/cfg", f.opts), false);
    f.fs.readFile = () => "malformed";
    assert.equal(serviceOwned("/pkg", "/cfg", f.opts), false);
    f.fs.exists = () => false;
    assert.equal(serviceOwned("/pkg", "/cfg", f.opts), false);
  }
  assert.equal(serviceOwned("/pkg", "/cfg", { platform: "win32", fs: fakeFs }), false);
});
test("an unreadable config declaration fails ownership closed instead of defaulting to ~/.ima2", () => {
  const f = artifactFixture("linux");
  const home = process.env.HOME ?? "/home";
  const quoted = ["[Service]", "ExecStart=/node /pkg/server.js", 'Environment="IMA2_CONFIG_DIR=/other-config"'].join("\n");
  f.fs.readFile = () => quoted;
  assert.equal(serviceOwned("/pkg", home + "/.ima2", f.opts), false);
  f.fs.readFile = () => ["[Service]", "ExecStart=/node /pkg/server.js"].join("\n");
  assert.equal(serviceOwned("/pkg", home + "/.ima2", f.opts), true);
});
const notice = () => ({ command: "status", args: [], isTTY: true, env: {}, current: "1.0.0", cache: cache() });
test("cached notices include preview command and suppress every ineligible context", () => {
  assert.equal(updateNoticeLine(notice()), "Update available: v2.0.0 (current v1.0.0). Run: ima2 update");
  assert.match(updateNoticeLine({ ...notice(), current: "1.0.0-preview.1", cache: cache("2.0.0-preview.1", "preview") })!, /--tag preview$/);
  for (const patch of [{ isTTY: false }, { env: { IMA2_DISABLE_UPDATE_CHECK: "1" } }, { env: { IMA2_DESKTOP: "1" } },
    { command: "update" }, { command: undefined }, { cache: cache("1.0.0") }, { cache: cache("bad") },
    { cache: { ...cache(), dismissed_version: "2.0.0" } }, { cache: cache("2.0.0-preview.1", "preview") },
    { current: "1.0.0-preview.1", cache: cache("2.0.0", "latest") }]) assert.equal(updateNoticeLine({ ...notice(), ...patch }), null);
  for (const flag of ["--json", "--quiet", "-q", "-h", "--help", "-v", "--version"]) assert.equal(updateNoticeLine({ ...notice(), args: [flag] }), null);
});
test("notice eligibility precedes cache/claim; claims share one-time version markers", () => {
  for (const flag of ["--json", "--quiet", "-q", "-h", "--help", "-v", "--version"]) {
    let reads = 0, claims = 0, writes = 0;
    printUpdateNotice("status", [flag], "2.0.0", { isTTY: true, env: {}, readCache: () => { reads++; return cache(); },
      claim: () => { claims++; return "2.0.0"; }, write: () => { writes++; } });
    assert.deepEqual([reads, claims, writes], [0, 0, 0]);
  }
  const path = versionCachePath(join(root, "notice"));
  markSeen("1.0.0", path);
  const lines: string[] = [];
  const deps = { isTTY: true, env: {}, readCache: () => readVersionCache(path), claim: (v: string) => claimUpdatedNotice(v, path), write: (line: string) => lines.push(line) };
  printUpdateNotice("start", [], "2.0.0", deps);
  printUpdateNotice("start", [], "2.0.0", deps);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "ima2 updated to v2.0.0 — what's new: https://github.com/lidge-ai/ima2-gen/releases/tag/v2.0.0");
  assert.equal(claimUpdatedNotice("2.0.0", path), null);
});
test("check-only reports up-to-date/available and preview selection without npm or runtime", async () => {
  for (const latest of ["1.0.0", "2.0.0"]) {
    const f = fixture({ exec: noExec, runtime: async () => assert.fail("runtime queried"), check: async (tag) => { assert.equal(tag, "latest"); return cache(latest); } });
    assert.equal(await runUpdate(["--check"], f.deps), 0);
    assert.match(f.lines[0]!, latest === "1.0.0" ? /Up to date \(v1.0.0\)/ : /Update available: v2.0.0/);
  }
  const f = fixture({ exec: noExec, current: "1.0.0-preview.1", check: async (tag) => { assert.equal(tag, "preview"); return cache("2.0.0-preview.1", tag); } });
  assert.equal(await runUpdate(["--check"], f.deps), 0); assert.match(f.lines[0]!, /--tag preview/);
});
test("flag errors and unsupported installs exit 2; help has no side effects", async () => {
  for (const args of [["--bad"], ["--tag", "bad"], ["--tag"]]) {
    const f = fixture({ exec: noExec }); assert.equal(await runUpdate(args, f.deps), 2); assert.match(f.errors[0]!, /Usage:/);
  }
  for (const marker of ["server.ts", ".git"]) {
    const f = fixture({ exec: noExec, fs: { ...fakeFs, exists: (p) => p.endsWith(marker) } });
    assert.equal(await runUpdate([], f.deps), 2); assert.match(f.errors[0]!, /source checkout/); assert.deepEqual(f.order, []);
  }
  const local = fixture({ pkgDir: "/project/node_modules/ima2-gen" });
  assert.equal(await runUpdate([], local.deps), 2); assert.match(local.errors[0]!, /not a global npm install \(local\)/);
  const help = fixture({ exec: noExec });
  assert.equal(await runUpdate(["--help", "--bad"], help.deps), 0); assert.match(help.lines[0]!, /Usage: ima2 update/); assert.deepEqual(help.order, []);
});
test("non-TTY and JSON require --yes; declining never installs", async () => {
  for (const args of [[], ["--json"]]) {
    const f = fixture({ isTTY: false }); assert.equal(await runUpdate(args, f.deps), 2);
    assert.equal(f.calls.length, 1); assert.equal(f.order.includes("install"), false);
  }
  const f = fixture({ confirm: async () => false });
  assert.equal(await runUpdate([], f.deps), 0); assert.equal(f.order.includes("install"), false);
});
test("install verifies, marks seen in isolated cache, and invokes the new service CLI", async () => {
  const path = versionCachePath(join(root, "install"));
  const f = fixture({ markSeen: (v) => { f.order.push(`seen:${v}`); markSeen(v, path); } });
  assert.equal(await runUpdate(["--yes"], f.deps), 0);
  assert.deepEqual(f.order, ["check", "runtime", "install", "verify", "seen:2.0.0", "restart", "runtime"]);
  assert.deepEqual(f.calls.at(-1)?.args, ["/global/ima2-gen/bin/ima2.js", "service", "restart"]);
  assert.equal(readVersionCache(path).last_seen_version, "2.0.0");
});
test("check/installation/mismatch failures stop before restart and do not mark seen", async () => {
  const checks = fixture({ check: async () => { throw new Error("registry offline"); } });
  assert.equal(await runUpdate(["--check"], checks.deps), 1); assert.match(checks.errors[0]!, /registry offline/);
  const mismatch = fixture({ fs: { ...fakeFs, readFile: () => '{"version":"1.0.0"}' } });
  assert.equal(await runUpdate(["--yes"], mismatch.deps), 1); assert.match(mismatch.errors[0]!, /still v1.0.0/);
  assert.equal(mismatch.order.some((v) => v.startsWith("seen:")), false); assert.equal(mismatch.order.includes("restart"), false);
  const f = fixture(); const original = f.deps.exec;
  f.deps.exec = (cmd, args, opts) => args.includes("install") ? { status: 1, stdout: "", stderr: "EACCES" } : original(cmd, args, opts);
  assert.equal(await runUpdate(["--yes"], f.deps), 1); assert.match(f.errors[0]!, /sudo npm/);
});
test("restart requires live latest version and polls deterministically for up to 20 seconds", async () => {
  let probes = 0, sleeps = 0;
  const f = fixture({ runtime: async () => runtime({ version: ++probes < 3 ? "1.0.0" : "2.0.0" }),
    sleep: async (ms) => { assert.equal(ms, 500); sleeps++; } });
  assert.equal(await runUpdate(["--yes"], f.deps), 0); assert.equal(sleeps, 1);
  for (const patch of [{ version: "1.0.0" }, { live: false }]) {
    let ticks = 0;
    const bad = fixture({ runtime: async () => runtime(patch), sleep: async () => { ticks++; } });
    assert.equal(await runUpdate(["--yes"], bad.deps), 1); assert.equal(ticks, 40); assert.match(bad.errors[0]!, /ima2 service restart/);
  }
});
test("failed restart returns 1 after installation with the correct recovery command", async () => {
  for (const owned of [true, false]) {
    const f = fixture({ serviceOwned: () => owned }); const original = f.deps.exec;
    f.deps.exec = (cmd, args, opts) => args.includes("restart") ? { status: 9, stdout: "", stderr: "failed" } : original(cmd, args, opts);
    assert.equal(await runUpdate(["--yes"], f.deps), 1); assert.match(f.errors[0]!, owned ? /Run: ima2 service restart/ : /Run: ima2 restart/);
    assert.equal(f.order.includes("seen:2.0.0"), true);
  }
});
test("foreground emits manual restart hint; desktop/no runtime needs no restart", async () => {
  const foreground = fixture({ serviceOwned: () => false, runtime: async () => runtime({ launcher: "foreground" }) });
  assert.equal(await runUpdate(["--yes"], foreground.deps), 0); assert.match(foreground.lines.at(-1)!, /Restart your running 'ima2 serve'/);
  for (const patch of [{ launcher: "desktop" }, { live: false }]) {
    const f = fixture({ serviceOwned: () => false, runtime: async () => runtime(patch) });
    assert.equal(await runUpdate(["--yes"], f.deps), 0); assert.equal(f.order.includes("restart"), false);
  }
});
test("JSON emits exactly one document, captures every subprocess, and carries failure state", async () => {
  const f = fixture({ confirm: async () => assert.fail("JSON prompted") });
  assert.equal(await runUpdate(["--json", "--yes"], f.deps), 0); assert.equal(f.lines.length, 1); assert.deepEqual(f.errors, []);
  assert.deepEqual(JSON.parse(f.lines[0]!), { current: "1.0.0", latest: "2.0.0", tag: "latest", available: true, updated: true,
    restart: { kind: "service", ok: true, version: "2.0.0" } });
  for (const call of f.calls) assert.equal(call.opts?.inherit, false);
  const bad = fixture({ runtime: async () => runtime({ version: "1.0.0" }) });
  assert.equal(await runUpdate(["--json", "--yes"], bad.deps), 1);
  assert.equal(bad.lines.length, 1); assert.deepEqual(bad.errors, []);
  const result = JSON.parse(bad.lines[0]!); assert.equal(result.updated, true); assert.equal(result.restart.ok, false); assert.match(result.error, /restart failed/);
  const invalid = fixture({ exec: noExec });
  assert.equal(await runUpdate(["--json", "--tag", "bad"], invalid.deps), 2); assert.equal(invalid.lines.length, 1); assert.deepEqual(invalid.errors, []);
});
test("ima2 update --help exits zero and leaves its temp config directory empty", () => {
  const dir = mkdtempSync(join(root, "help-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "bin/ima2.ts", "update", "--help"], {
    encoding: "utf8", timeout: 20_000, env: { ...process.env, IMA2_CONFIG_DIR: dir },
  });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Usage: ima2 update/); assert.deepEqual(readdirSync(dir), []);
});
