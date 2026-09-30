import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { markSeen, updateVersionCache, versionCachePath, type UpdateBadge } from "../lib/updateCache.js";
import type { CheckDeps } from "../lib/updateCheck.js";
import type { RouteRuntimeContext } from "../lib/runtimeContext.js";
import { registerUpdateRoutes, type UpdateRouteDeps } from "../routes/update.js";

async function fixture(t: TestContext, ctx: RouteRuntimeContext = {}, deps: UpdateRouteDeps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ima2-update-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const path = versionCachePath(dir);
  const app = express();
  app.use(express.json());
  registerUpdateRoutes(app, { packageVersion: "3.25.0", launcher: "foreground", ...ctx }, { cachePath: path, now: () => 1000, env: {}, ...deps });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/update`;
  return {
    path,
    get: () => fetch(`${base}/badge`),
    post: (route: string, body?: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  };
}

describe("update routes on an ephemeral local server", () => {
  it("GET badge reads cached state without checking the registry", async (t) => {
    const api = await fixture(t, {}, { check: async () => { throw new Error("must not fetch"); } });
    updateVersionCache({ latest_version: "3.26.0", last_checked_at: 999, tag: "latest" }, api.path);
    const response = await api.get();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { surface: "npm", enabled: true, currentVersion: "3.25.0", latestVersion: "3.26.0", available: true, dismissed: false, stale: false, checkedAt: 999, tag: "latest", command: "ima2 update", releaseUrl: "https://github.com/lidge-ai/ima2-gen/releases/tag/v3.26.0" });
  });

  it("rejects malformed dismiss versions, then writes a valid dismissal", async (t) => {
    const api = await fixture(t);
    updateVersionCache({ latest_version: "3.26.0", last_checked_at: 999, tag: "latest" }, api.path);
    for (const body of [{}, { version: 123 }, { version: "bad" }, { version: "../3.26.0" }, null, []]) {
      const response = await api.post("dismiss", body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, code: "INVALID_VERSION" });
    }
    const response = await api.post("dismiss", { version: "3.26.0" });
    assert.equal(response.status, 200);
    const badge: UpdateBadge = await response.json();
    assert.equal(badge.dismissed, true);
    assert.equal(badge.available, false);
  });

  it("POST check returns the resulting cache badge and forwards preview channel and clock", async (t) => {
    const api = await fixture(t, { packageVersion: "3.25.0-preview.1" }, {
      check: async (tag, deps: CheckDeps = {}) => {
        assert.equal(tag, "preview");
        assert.equal(deps.now?.(), 1000);
        return updateVersionCache({ latest_version: "3.26.0-preview.1", last_checked_at: deps.now!(), tag }, deps.cachePath);
      },
    });
    const response = await api.post("check");
    assert.equal(response.status, 200);
    const badge: UpdateBadge = await response.json();
    assert.equal(badge.available, true);
    assert.equal(badge.tag, "preview");
    assert.equal(badge.latestVersion, "3.26.0-preview.1");
    assert.equal(badge.command, "ima2 update --tag preview");
  });

  it("POST check surfaces a 503 error with the unchanged cached badge", async (t) => {
    const api = await fixture(t, {}, { check: async () => { throw new Error("offline"); } });
    updateVersionCache({ latest_version: "3.26.0", last_checked_at: 999, tag: "latest" }, api.path);
    const response = await api.post("check");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "UPDATE_CHECK_FAILED");
    assert.equal(body.message, "offline");
    assert.equal(body.badge.latestVersion, "3.26.0");
    assert.equal(body.badge.checkedAt, 999);
  });

  it("manual POST check works with automatic update checks disabled", async (t) => {
    let calls = 0;
    const api = await fixture(t, {}, {
      env: { IMA2_DISABLE_UPDATE_CHECK: "1" },
      check: async (tag, deps) => {
        calls++;
        return updateVersionCache({ latest_version: "3.26.0", last_checked_at: 1000, tag }, deps?.cachePath);
      },
    });
    const response = await api.post("check");
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    const badge: UpdateBadge = await response.json();
    assert.equal(badge.enabled, false);
    assert.equal(badge.available, true);
  });

  it("desktop returns disabled badges and no notice without calling npm checks", async (t) => {
    const api = await fixture(t, { launcher: "desktop" }, { check: async () => { throw new Error("desktop must not fetch"); } });
    updateVersionCache({ latest_version: "3.26.0", last_checked_at: 999, tag: "latest" }, api.path);
    for (const response of [await api.get(), await api.post("check")]) {
      assert.equal(response.status, 200);
      const badge: UpdateBadge = await response.json();
      assert.equal(badge.surface, "desktop");
      assert.equal(badge.enabled, false);
      assert.equal(badge.available, false);
    }
    const response = await api.post("notice");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { updatedTo: null });
  });

  it("notice suppresses first-run, claims upgrades once, and honors CLI markSeen", async (t) => {
    const initial = await fixture(t);
    assert.deepEqual(await (await initial.post("notice")).json(), { updatedTo: null });
    const upgraded = await fixture(t, { packageVersion: "3.26.0" });
    markSeen("3.25.0", upgraded.path);
    assert.deepEqual(await (await upgraded.post("notice")).json(), { updatedTo: "3.26.0" });
    assert.deepEqual(await (await upgraded.post("notice")).json(), { updatedTo: null });
    const installed = await fixture(t, { packageVersion: "3.26.0" });
    markSeen("3.25.0", installed.path);
    markSeen("3.26.0", installed.path);
    assert.deepEqual(await (await installed.post("notice")).json(), { updatedTo: null });
  });
});
