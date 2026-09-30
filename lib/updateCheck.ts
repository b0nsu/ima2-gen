import { config } from "../config.js";
import { errInfo } from "./errInfo.js";
import { readVersionCache, updateVersionCache, type VersionCache } from "./updateCache.js";
import { PACKAGE_NAME, parseVersion, type UpdateTag } from "./updateVersion.js";

export interface CheckDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  cachePath?: string;
  registry?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function fetchLatestVersion(tag: UpdateTag, deps: CheckDeps = {}): Promise<string> {
  const registry = (deps.registry ?? config.update.registry).replace(/\/+$/, "");
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? config.update.timeoutMs);
  const signal = deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout;
  const response = await (deps.fetchImpl ?? fetch)(`${registry}/${PACKAGE_NAME}/${tag}`, {
    headers: { accept: "application/json" }, signal,
  });
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
  const body: unknown = await response.json().catch((error: unknown) => {
    throw new Error("registry returned invalid JSON", { cause: error });
  });
  if (!body || typeof body !== "object" || Array.isArray(body) || !("version" in body)
    || typeof body.version !== "string" || !parseVersion(body.version)) {
    throw new Error("registry returned an invalid version");
  }
  signal.throwIfAborted();
  return body.version;
}

const inFlight = new Map<UpdateTag, Promise<VersionCache>>();

export function checkForUpdate(tag: UpdateTag, deps: CheckDeps = {}): Promise<VersionCache> {
  const existing = inFlight.get(tag);
  if (existing) return existing;
  const pending = fetchLatestVersion(tag, deps).then((latest_version) => {
    deps.signal?.throwIfAborted();
    return updateVersionCache({ latest_version, last_checked_at: (deps.now ?? Date.now)(), tag }, deps.cachePath);
  }).finally(() => { inFlight.delete(tag); });
  inFlight.set(tag, pending);
  return pending;
}

export function isCacheFresh(cache: VersionCache, tag: UpdateTag, now: number, maxAgeMs = config.update.freshMs): boolean {
  return cache.tag === tag && cache.last_checked_at !== null && now - cache.last_checked_at < maxAgeMs;
}

/**
 * Automatic checks run only for real npm-launched servers: never for the desktop's bundled
 * server (the app updates itself) and never under node --test, whose NODE_TEST_CONTEXT is
 * inherited by servers that tests start, so suites stay offline and away from ~/.ima2.
 */
export function updateChecksEnabled(env: NodeJS.ProcessEnv, launcher: string): boolean {
  return env.IMA2_DISABLE_UPDATE_CHECK !== "1" && launcher !== "desktop" && !env.NODE_TEST_CONTEXT;
}

export interface SchedulerOptions {
  tag: UpdateTag;
  deps?: CheckDeps;
  tickMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  freshMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (m: string) => void;
}

class UpdateScheduler {
  private readonly controller = new AbortController();
  private readonly deps: CheckDeps;
  private readonly setTimer: NonNullable<SchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<SchedulerOptions["clearTimer"]>;
  private timer: unknown;
  private stopped = false;
  private pending: Promise<VersionCache | null> | null = null;
  private delay = 0;
  private backoff: number;

  constructor(private readonly opts: SchedulerOptions) {
    this.deps = { ...opts.deps, signal: opts.deps?.signal
      ? AbortSignal.any([this.controller.signal, opts.deps.signal]) : this.controller.signal };
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.backoff = opts.backoffMinMs ?? config.update.backoffMinMs;
    this.schedule(0);
  }

  checkNow(): Promise<VersionCache | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.pending) return this.pending;
    this.pending = checkForUpdate(this.opts.tag, this.deps).catch((error: unknown) => {
      if (!this.stopped) (this.opts.log ?? console.log)(`[update] check failed: ${errInfo(error).message}`);
      return null;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    const cache = readVersionCache(this.deps.cachePath);
    const fresh = isCacheFresh(cache, this.opts.tag, (this.deps.now ?? Date.now)(), this.opts.freshMs);
    const succeeded = fresh || await this.checkNow() !== null;
    if (this.stopped) return;
    if (succeeded) {
      this.backoff = this.opts.backoffMinMs ?? config.update.backoffMinMs;
      this.schedule(this.opts.tickMs ?? config.update.tickMs);
    } else {
      this.schedule(this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.opts.backoffMaxMs ?? config.update.backoffMaxMs);
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.delay = ms;
    this.timer = this.setTimer(() => { void this.run(); }, ms);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.controller.abort();
  }

  nextDelayMs(): number { return this.delay; }
}

export function startUpdateScheduler(opts: SchedulerOptions): {
  stop(): void; checkNow(): Promise<VersionCache | null>; nextDelayMs(): number;
} {
  const scheduler = new UpdateScheduler(opts);
  return {
    stop: () => scheduler.stop(), checkNow: () => scheduler.checkNow(), nextDelayMs: () => scheduler.nextDelayMs(),
  };
}
