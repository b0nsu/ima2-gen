import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { requireRuntimeContext, type RouteRuntimeContext } from "../lib/runtimeContext.js";
import { logEvent } from "../lib/logger.js";
import { stopIntentLine } from "../lib/runtimeIdentity.js";
import { requestShutdown, type ShutdownReason } from "../bin/lib/platform.js";

/**
 * Local admin surface. POST /api/admin/stop shuts the server down cleanly.
 *
 * Threat model: the LAN guard is a pass-through on loopback binds, so without
 * extra auth ANY web page could fire a cross-origin
 * fetch("http://127.0.0.1:3333/api/admin/stop") and kill the server — a
 * remote-triggerable kill switch (adversarial audit 260821c, blocker 1).
 * Two independent gates close that hole:
 *
 * 1. The caller must present the boot-generated admin nonce, which is
 *    published only in the advertise file (~/.ima2/server.json). Reading that
 *    file requires local filesystem access, which a web page does not have.
 * 2. Any request carrying an Origin header is refused outright. Browser-issued
 *    cross-origin fetches always carry Origin; the ima2 CLI never does.
 *
 * Shutdown goes through the coordinator installed by onShutdown(), which owns
 * the complete teardown (unadvertise, proxy children, agent queue, timers, DB
 * close, exit). A Windows self-SIGTERM terminates the process without running
 * that handler, so the route requests shutdown directly instead.
 *
 * Before requesting shutdown the route prints the stop-intent line on stdout
 * and proceeds only once that write has flushed. A supervisor that owns this
 * process's pipe (the desktop shell) reads it to tell a requested stop from a
 * crash, so it does not restart a server the user just stopped.
 */
export function registerAdminRoutes(
  app: Express,
  ctxRaw: RouteRuntimeContext,
  { shutdown = requestShutdown }: { shutdown?: (reason: ShutdownReason) => void | Promise<void> } = {},
) {
  const ctx = requireRuntimeContext(ctxRaw);
  app.post("/api/admin/stop", (req: Request, res: Response) => {
    if (typeof req.headers.origin === "string" && req.headers.origin.length > 0) {
      return res.status(403).json({ error: "admin stop is not callable from a browser context" });
    }
    const nonce = req.headers["x-ima2-admin-nonce"];
    const expected = Buffer.from(ctx.adminNonce);
    const presented = typeof nonce === "string" ? Buffer.from(nonce) : Buffer.alloc(0);
    const valid =
      expected.length > 0 &&
      presented.length === expected.length &&
      timingSafeEqual(presented, expected);
    if (!valid) {
      return res.status(401).json({ error: "missing or invalid admin nonce" });
    }
    logEvent("admin", "stop_requested", { pid: process.pid });
    res.status(202).json({ ok: true, pid: process.pid, stopping: true });
    setImmediate(() => {
      process.stdout.write(stopIntentLine(ctx.bootId), () => { void shutdown("admin"); });
    });
  });
}
