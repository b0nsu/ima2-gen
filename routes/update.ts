import type { Express } from "express";
import { errInfo } from "../lib/errInfo.js";
import { requireRuntimeContext, type RouteRuntimeContext } from "../lib/runtimeContext.js";
import { buildBadge, claimUpdatedNotice, readVersionCache, updateVersionCache, versionCachePath } from "../lib/updateCache.js";
import { checkForUpdate, updateChecksEnabled } from "../lib/updateCheck.js";
import { defaultTag, parseVersion } from "../lib/updateVersion.js";

export interface UpdateRouteDeps {
  check?: typeof checkForUpdate;
  cachePath?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export function registerUpdateRoutes(app: Express, ctxRaw: RouteRuntimeContext, deps: UpdateRouteDeps = {}): void {
  const ctx = requireRuntimeContext(ctxRaw);
  const surface = ctx.launcher === "desktop" ? "desktop" : "npm";
  const tag = defaultTag(ctx.packageVersion);
  const path = deps.cachePath ?? versionCachePath(ctx.config.storage.configDir);
  const badge = () => buildBadge({
    cache: readVersionCache(path), current: ctx.packageVersion, tag, surface,
    enabled: updateChecksEnabled(deps.env ?? process.env, ctx.launcher),
    now: (deps.now ?? Date.now)(), staleMs: ctx.config.update.staleMs,
  });
  app.get("/api/update/badge", (_req, res) => { res.json(badge()); });
  app.post("/api/update/check", async (_req, res) => {
    if (surface === "desktop") { res.json(badge()); return; }
    try {
      await (deps.check ?? checkForUpdate)(tag, { cachePath: path, now: deps.now ?? Date.now });
      res.json(badge());
    } catch (error) {
      res.status(503).json({ ok: false, code: "UPDATE_CHECK_FAILED", message: errInfo(error).message, badge: badge() });
    }
  });
  app.post("/api/update/dismiss", (req, res) => {
    const body: unknown = req.body;
    const version = body && typeof body === "object" && "version" in body ? body.version : undefined;
    if (typeof version !== "string" || !parseVersion(version)) {
      res.status(400).json({ ok: false, code: "INVALID_VERSION" }); return;
    }
    updateVersionCache({ dismissed_version: version }, path);
    res.json(badge());
  });
  app.post("/api/update/notice", (_req, res) => {
    res.json({ updatedTo: surface === "desktop" ? null : claimUpdatedNotice(ctx.packageVersion, path) });
  });
}
