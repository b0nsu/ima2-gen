import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { config } from "../config.js";
import { buildBadge, claimUpdatedNotice, markSeen, readVersionCache, updateVersionCache, versionCachePath } from "../lib/updateCache.js";
import { checkForUpdate, fetchLatestVersion, isCacheFresh, startUpdateScheduler, updateChecksEnabled, type SchedulerOptions } from "../lib/updateCheck.js";
import { compareVersions, defaultTag, isNewer, isUpdateTag, parseVersion, releaseUrl } from "../lib/updateVersion.js";

const runFile = promisify(execFile);
const cacheModule = new URL("../lib/updateCache.ts", import.meta.url).href;
const emptyCache = { latest_version: null, last_checked_at: null, tag: null, dismissed_version: null, last_seen_version: null };

function tempCache(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ima2-update-core-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return versionCachePath(dir);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeTimers() {
  type Timer = { fn: () => void; ms: number; unref(): void };
  const queue: Timer[] = [];
  const cleared: unknown[] = [];
  let unrefs = 0;
  let scheduled: (() => void) | undefined;
  return {
    queue, cleared, unrefs: () => unrefs,
    setTimer(fn: () => void, ms: number): Timer {
      const timer = { fn, ms, unref() { unrefs++; } };
      queue.push(timer);
      scheduled?.();
      scheduled = undefined;
      return timer;
    },
    clearTimer(timer: unknown) {
      cleared.push(timer);
      const index = queue.findIndex((item) => item === timer);
      if (index >= 0) queue.splice(index, 1);
    },
    async fire() {
      const timer = queue.shift();
      assert.ok(timer, "a timer must have been scheduled");
      const next = new Promise<void>((resolve) => { scheduled = resolve; });
      timer.fn();
      await next;
    },
  };
}

function schedulerFixture(t: TestContext, fetchImpl: typeof fetch, options: Partial<SchedulerOptions> = {}) {
  const path = tempCache(t);
  const timers = fakeTimers();
  const logs: string[] = [];
  const scheduler = startUpdateScheduler({
    tag: "latest", deps: { cachePath: path, now: () => 1_000_000, fetchImpl },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: (m) => logs.push(m), ...options,
  });
  t.after(() => scheduler.stop());
  return { path, timers, logs, scheduler };
}

async function child(code: string): Promise<string> {
  const { stdout } = await runFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code]);
  return stdout.trim();
}

describe("update version precedence", () => {
  it("compares core versions, prereleases, invalid input and ignored build metadata", () => {
    const pairs: Array<[string, string, number]> = [
      ["3.25.0", "3.26.0", -1], ["3.26.0-preview.1", "3.26.0", -1], ["3.10.0", "3.9.9", 1],
      ["bad", "3.26.0", -1], ["bad", "also bad", 0], ["3.26.0", "bad", 1],
      ["3.26.0-preview.2", "3.26.0-preview.10", -1], ["1.0.0-alpha", "1.0.0-alpha.1", -1],
      ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1], ["1.0.0-beta", "1.0.0-alpha", 1],
      ["1.0.0+one", "1.0.0+two", 0], ["1.0.0-a.100000000000000000000", "1.0.0-a.99999999999999999999", 1],
    ];
    for (const [left, right, expected] of pairs) assert.equal(compareVersions(left, right), expected, `${left} vs ${right}`);
  });

  it("rejects malformed semver and unsafe marker paths", () => {
    for (const value of ["", "v3.26.0", "3.26", "03.26.0", "3.26.0-01", "3.26.0-preview..1", "3.26.0+", "../3.26.0", "3.26.0/evil", "3.26.0\n", "9007199254740992.0.0"]) {
      assert.equal(parseVersion(value), null, value);
    }
    assert.deepEqual(parseVersion("3.26.0-preview.1+build.2"), { core: [3, 26, 0], pre: ["preview", "1"] });
    assert.equal(isNewer(null, "3.25.0"), false);
    assert.equal(isNewer(undefined, "3.25.0"), false);
    assert.equal(isNewer("invalid", "invalid"), false);
    assert.equal(isNewer("3.26.0", "3.25.0"), true);
  });

  it("selects tags and release links", () => {
    assert.equal(defaultTag("3.26.0-preview.1"), "preview");
    assert.equal(defaultTag("3.26.0"), "latest");
    assert.equal(defaultTag("3.26.0-beta.1"), "latest");
    assert.equal(isUpdateTag("latest"), true);
    assert.equal(isUpdateTag("preview"), true);
    assert.equal(isUpdateTag("next"), false);
    assert.equal(isUpdateTag(null), false);
    assert.equal(releaseUrl("3.26.0"), "https://github.com/lidge-ai/ima2-gen/releases/tag/v3.26.0");
  });
});

describe("split update state", () => {
  it("uses the config directory and reads missing, corrupt and wrong-typed owners as nulls", (t) => {
    assert.equal(versionCachePath(), join(config.storage.configDir, "version.json"));
    const path = tempCache(t);
    assert.deepEqual(readVersionCache(path), emptyCache);
    writeFileSync(path, "not json");
    writeFileSync(join(dirname(path), "update-dismissed.json"), "null");
    assert.deepEqual(readVersionCache(path), emptyCache);
    writeFileSync(path, JSON.stringify({ latest_version: 1, last_checked_at: "yesterday", tag: "next", dismissed_version: "legacy", last_seen_version: "3.25.0" }));
    writeFileSync(join(dirname(path), "update-dismissed.json"), JSON.stringify({ dismissed_version: [] }));
    assert.deepEqual(readVersionCache(path), emptyCache);
    mkdirSync(join(dirname(path), "update-seen", "3.29.0"), { recursive: true });
    writeFileSync(join(dirname(path), "update-seen", "invalid"), "");
    assert.deepEqual(readVersionCache(path), emptyCache);
  });

  it("routes patches to separate owners and leaves no temporary or lock files", (t) => {
    const path = tempCache(t);
    updateVersionCache({ dismissed_version: "3.26.0" }, path);
    const cache = updateVersionCache({ latest_version: "3.26.0", last_checked_at: 100, tag: "latest", last_seen_version: "3.25.0" }, path);
    assert.deepEqual(cache, { latest_version: "3.26.0", last_checked_at: 100, tag: "latest", dismissed_version: "3.26.0", last_seen_version: "3.25.0" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { latest_version: "3.26.0", last_checked_at: 100, tag: "latest" });
    assert.deepEqual(JSON.parse(readFileSync(join(dirname(path), "update-dismissed.json"), "utf8")), { dismissed_version: "3.26.0" });
    assert.deepEqual(readdirSync(dirname(path)).sort(), ["update-dismissed.json", "update-seen", "version.json"]);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("cleans temporary files when an atomic rename fails", (t) => {
    const path = tempCache(t);
    mkdirSync(path);
    assert.throws(() => updateVersionCache({ latest_version: "3.26.0", last_checked_at: 100, tag: "latest" }, path));
    assert.deepEqual(readdirSync(dirname(path)), ["version.json"]);
  });

  it("claims an upgrade once, suppresses first-run and downgrades, and keeps all markers", (t) => {
    const path = tempCache(t);
    assert.equal(claimUpdatedNotice("3.25.0", path), null);
    assert.equal(claimUpdatedNotice("3.26.0", path), "3.26.0");
    assert.equal(claimUpdatedNotice("3.26.0", path), null);
    assert.equal(claimUpdatedNotice("3.24.0", path), null);
    assert.equal(claimUpdatedNotice("3.25.0", path), null);
    markSeen("3.27.0", path);
    assert.equal(claimUpdatedNotice("3.27.0", path), null);
    for (let patch = 1; patch <= 6; patch++) markSeen(`3.27.${patch}`, path);
    assert.equal(readdirSync(join(dirname(path), "update-seen")).length, 10);
    assert.equal(readVersionCache(path).last_seen_version, "3.27.6");
    assert.throws(() => markSeen("../bad", path), /Invalid update version/);
  });

  it("compares a new claim against the highest mixed-history marker", (t) => {
    const path = tempCache(t);
    markSeen("3.25.0", path);
    markSeen("3.27.0", path);
    assert.equal(claimUpdatedNotice("3.26.0", path), null);
    assert.equal(claimUpdatedNotice("3.26.0", path), null);
    assert.equal(readVersionCache(path).last_seen_version, "3.27.0");
  });

  it("allows exactly one of four processes to claim the same upgraded version", async (t) => {
    const path = tempCache(t);
    markSeen("3.25.0", path);
    const code = `import { claimUpdatedNotice } from ${JSON.stringify(cacheModule)}; const v = claimUpdatedNotice("3.26.0", ${JSON.stringify(path)}); if (v) console.log(v);`;
    const outputs = await Promise.all(Array.from({ length: 4 }, () => child(code)));
    assert.deepEqual(outputs.filter(Boolean), ["3.26.0"]);
  });

  it("keeps complete registry facts and a dismissal across concurrent process writes", async (t) => {
    const path = tempCache(t);
    const writers = Array.from({ length: 4 }, (_, index) => child(`import { updateVersionCache } from ${JSON.stringify(cacheModule)}; for (let n = 0; n < 20; n++) updateVersionCache({latest_version:"3.26.${index}",last_checked_at:${index + 1},tag:"latest"}, ${JSON.stringify(path)});`));
    writers.push(child(`import { updateVersionCache } from ${JSON.stringify(cacheModule)}; updateVersionCache({dismissed_version:"3.26.0"}, ${JSON.stringify(path)});`));
    await Promise.all(writers);
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(/^3\.26\.[0-3]$/.test(persisted.latest_version));
    assert.equal(persisted.last_checked_at, Number(persisted.latest_version.split(".")[2]) + 1);
    assert.equal(persisted.tag, "latest");
    assert.equal(readVersionCache(path).dismissed_version, "3.26.0");
    assert.equal(readdirSync(dirname(path)).some((name) => /\.tmp$|\.lock/.test(name)), false);
  });
});

describe("badge and freshness", () => {
  it("exposes availability, dismissal, staleness, channel and desktop state", () => {
    const cache = { ...emptyCache, latest_version: "3.26.0", last_checked_at: 100, tag: "latest" as const };
    const input = { cache, current: "3.25.0", tag: "latest" as const, enabled: true, surface: "npm" as const, now: 101 };
    assert.deepEqual(buildBadge(input), { surface: "npm", enabled: true, currentVersion: "3.25.0", latestVersion: "3.26.0", available: true, dismissed: false, stale: false, checkedAt: 100, tag: "latest", command: "ima2 update", releaseUrl: "https://github.com/lidge-ai/ima2-gen/releases/tag/v3.26.0" });
    const dismissed = buildBadge({ ...input, cache: { ...cache, dismissed_version: "3.26.0" } });
    assert.equal(dismissed.dismissed, true);
    assert.equal(dismissed.available, false);
    assert.equal(buildBadge({ ...input, cache: emptyCache }).stale, true);
    assert.equal(buildBadge({ ...input, now: 100 + config.update.staleMs }).stale, true);
    assert.equal(buildBadge({ ...input, now: 110, staleMs: 10 }).stale, true);
    const preview = buildBadge({ ...input, tag: "preview" });
    assert.equal(preview.available, false);
    assert.equal(preview.stale, true);
    assert.equal(preview.command, "ima2 update --tag preview");
    const desktop = buildBadge({ ...input, surface: "desktop" });
    assert.equal(desktop.available, false);
    assert.equal(desktop.enabled, false);
    assert.equal(buildBadge({ ...input, current: "3.26.0" }).available, false);
    assert.equal(buildBadge({ ...input, cache: emptyCache }).releaseUrl, null);
  });

  it("uses successful check timestamps and respects opt-out only for automatic checks", () => {
    const cache = { ...emptyCache, tag: "latest" as const, last_checked_at: 100 };
    assert.equal(isCacheFresh(cache, "latest", 100 + config.update.freshMs - 1), true);
    assert.equal(isCacheFresh(cache, "latest", 100 + config.update.freshMs), false);
    assert.equal(isCacheFresh(cache, "preview", 101), false);
    assert.equal(isCacheFresh(emptyCache, "latest", 101), false);
    assert.equal(isCacheFresh(cache, "latest", 110, 10), false);
    assert.equal(updateChecksEnabled({}, "foreground"), true);
    assert.equal(updateChecksEnabled({ IMA2_DISABLE_UPDATE_CHECK: "1" }, "service"), false);
    assert.equal(updateChecksEnabled({ IMA2_DISABLE_UPDATE_CHECK: "0" }, "background"), true);
    assert.equal(updateChecksEnabled({}, "desktop"), false);
    assert.equal(updateChecksEnabled({ NODE_TEST_CONTEXT: "child" }, "foreground"), false);
  });
});

describe("injected registry checks", () => {
  it("uses the requested registry, tag, JSON header and combined abort signal", async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (url, init) => {
      assert.equal(url, "https://registry.test/ima2-gen/preview");
      assert.deepEqual(init?.headers, { accept: "application/json" });
      assert.ok(init?.signal instanceof AbortSignal);
      assert.notEqual(init.signal, controller.signal);
      return Response.json({ version: "3.26.0-preview.1" });
    };
    assert.equal(await fetchLatestVersion("preview", { fetchImpl, registry: "https://registry.test///", signal: controller.signal }), "3.26.0-preview.1");
  });

  it("rejects HTTP failures, malformed JSON and invalid registry bodies", async () => {
    const responses = [new Response("missing", { status: 404 }), new Response("broken"), Response.json(null), Response.json([]), Response.json("3.26.0"), Response.json({}), Response.json({ version: 3 }), Response.json({ version: "3.26" })];
    for (const response of responses) {
      await assert.rejects(fetchLatestVersion("latest", { fetchImpl: async () => response }), /registry returned/);
    }
  });

  it("persists successful checks, preserves dismissals and leaves failure state untouched", async (t) => {
    const path = tempCache(t);
    updateVersionCache({ dismissed_version: "3.26.0" }, path);
    const cache = await checkForUpdate("latest", { cachePath: path, now: () => 123, fetchImpl: async () => Response.json({ version: "3.26.0" }) });
    assert.deepEqual(cache, { ...emptyCache, latest_version: "3.26.0", last_checked_at: 123, tag: "latest", dismissed_version: "3.26.0" });
    const before = readFileSync(path, "utf8");
    await assert.rejects(checkForUpdate("latest", { cachePath: path, fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
    assert.equal(readFileSync(path, "utf8"), before);
  });

  it("coalesces checks per tag across callers and releases the promise after success", async (t) => {
    const path = tempCache(t);
    const response = deferred<Response>();
    let calls = 0;
    const deps = { cachePath: path, fetchImpl: () => { calls++; return response.promise; } };
    const first = checkForUpdate("latest", deps);
    const second = checkForUpdate("latest", deps);
    assert.equal(first, second);
    assert.equal(calls, 1);
    response.resolve(Response.json({ version: "3.26.0" }));
    assert.deepEqual(await first, await second);
    await checkForUpdate("latest", { cachePath: path, fetchImpl: async () => { calls++; return Response.json({ version: "3.26.1" }); } });
    assert.equal(calls, 2);
  });

  it("keeps concurrent latest and preview checks independent", async (t) => {
    const latestPath = tempCache(t);
    const previewPath = tempCache(t);
    const latestResponse = deferred<Response>();
    const previewResponse = deferred<Response>();
    const latest = checkForUpdate("latest", { cachePath: latestPath, fetchImpl: () => latestResponse.promise });
    const preview = checkForUpdate("preview", { cachePath: previewPath, fetchImpl: () => previewResponse.promise });
    assert.notEqual(latest, preview);
    latestResponse.resolve(Response.json({ version: "3.26.0" }));
    previewResponse.resolve(Response.json({ version: "3.27.0-preview.1" }));
    assert.equal((await latest).tag, "latest");
    assert.equal((await preview).tag, "preview");
  });

  it("uses the timeout budget to abort a pending fetch without writing cache state", async (t) => {
    const path = tempCache(t);
    const timeout = new AbortController();
    t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 321); return timeout.signal; });
    const pending = checkForUpdate("latest", {
      cachePath: path, timeoutMs: 321,
      fetchImpl: (_url, init) => {
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal);
        return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    timeout.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(readVersionCache(path), emptyCache);
  });

  it("does not persist an aborted response", async (t) => {
    const path = tempCache(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(checkForUpdate("latest", { cachePath: path, signal: controller.signal, fetchImpl: async () => Response.json({ version: "3.26.0" }) }), { name: "AbortError" });
    assert.deepEqual(readVersionCache(path), emptyCache);
  });
});

describe("update scheduler with fake timers", () => {
  it("starts immediately for stale state, unrefs timers and skips fresh state", async (t) => {
    let calls = 0;
    const { timers, scheduler, path } = schedulerFixture(t, async () => { calls++; return Response.json({ version: "3.26.0" }); });
    assert.equal(scheduler.nextDelayMs(), 0);
    assert.equal(timers.unrefs(), 1);
    await timers.fire();
    assert.equal(calls, 1);
    assert.equal(scheduler.nextDelayMs(), 3_600_000);
    await timers.fire();
    assert.equal(calls, 1);
    updateVersionCache({ tag: "preview" }, path);
    await timers.fire();
    assert.equal(calls, 2);
    assert.equal(timers.unrefs(), 4);
  });

  it("doubles backoff to the cap, logs failures and resets after success", async (t) => {
    let fail = true;
    const { timers, scheduler, logs, path } = schedulerFixture(t, async () => {
      if (fail) throw new Error("offline");
      return Response.json({ version: "3.26.0" });
    });
    for (const delay of [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]) {
      await timers.fire();
      assert.equal(scheduler.nextDelayMs(), delay);
    }
    assert.deepEqual(logs, Array(8).fill("[update] check failed: offline"));
    fail = false;
    await timers.fire();
    assert.equal(scheduler.nextDelayMs(), 3_600_000);
    updateVersionCache({ last_checked_at: null }, path);
    fail = true;
    await timers.fire();
    assert.equal(scheduler.nextDelayMs(), 60_000);
  });

  it("coalesces manual scheduler and other callers into a single registry request", async (t) => {
    const response = deferred<Response>();
    let calls = 0;
    const { scheduler, path } = schedulerFixture(t, () => { calls++; return response.promise; });
    const first = scheduler.checkNow();
    const second = scheduler.checkNow();
    const external = checkForUpdate("latest", { cachePath: path, fetchImpl: async () => { throw new Error("must coalesce"); } });
    assert.equal(first, second);
    assert.equal(calls, 1);
    response.resolve(Response.json({ version: "3.26.0" }));
    assert.deepEqual(await first, await external);
  });

  it("stop aborts an active request, clears its timer and prevents later runs", async (t) => {
    const started = deferred<AbortSignal>();
    const { scheduler, timers, path, logs } = schedulerFixture(t, (_url, init) => {
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
      started.resolve(signal);
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const queued = timers.queue[0]!;
    const pending = scheduler.checkNow();
    const signal = await started.promise;
    scheduler.stop();
    assert.equal(signal.aborted, true);
    assert.equal(await pending, null);
    assert.equal(timers.cleared[0], queued);
    assert.equal(timers.queue.length, 0);
    queued.fn();
    assert.equal(await scheduler.checkNow(), null);
    assert.equal(timers.queue.length, 0);
    assert.deepEqual(readVersionCache(path), emptyCache);
    assert.deepEqual(logs, []);
  });

  it("stop while a scheduled check is active never schedules another tick", async (t) => {
    const started = deferred<void>();
    const response = deferred<Response>();
    const { scheduler, timers } = schedulerFixture(t, () => { started.resolve(); return response.promise; });
    timers.queue.shift()!.fn();
    await started.promise;
    const pending = scheduler.checkNow();
    scheduler.stop();
    response.resolve(Response.json({ version: "3.26.0" }));
    assert.equal(await pending, null);
    assert.equal(timers.queue.length, 0);
  });
});
