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

/**
 * One SSE frame with the cached badge, written when a browser opens GET /api/events. It is the
 * web UI's only cue that this server has update routes: the UI makes no update request until it
 * sees it, so fixture servers and e2e route harnesses never receive one. No id line, so replay
 * cursors are unchanged. Null for desktop-launched servers and for contexts without a version.
 */
export function updateHintFrame(ctxRaw: RouteRuntimeContext, deps: UpdateRouteDeps = {}): string | null {
  const raw = ctxRaw as { packageVersion?: unknown; launcher?: unknown } | undefined;
  if (typeof raw?.packageVersion !== "string" || raw.launcher === "desktop") return null;
  try {
    const ctx = requireRuntimeContext(ctxRaw);
    const badge = buildBadge({
      cache: readVersionCache(deps.cachePath ?? versionCachePath(ctx.config.storage.configDir)),
      current: ctx.packageVersion, tag: defaultTag(ctx.packageVersion), surface: "npm",
      enabled: updateChecksEnabled(deps.env ?? process.env, ctx.launcher),
      now: (deps.now ?? Date.now)(), staleMs: ctx.config.update.staleMs,
    });
    return `event: update\ndata: ${JSON.stringify(badge)}\n\n`;
  } catch {
    return null; // The hint is optional; an unreadable cache must not break the event stream.
  }
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
