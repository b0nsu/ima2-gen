/**
 * Backoff for GPT OAuth per-minute rate limits.
 *
 * The ChatGPT backend rejects a burst with HTTP 429 and a message such as
 * "Rate limit reached for gpt-image-2-codex ... on input-images per min: Limit 4000,
 * Used 4000. Please try again in 7.5s". That bucket refills within the minute, so waiting
 * and sending the same request again succeeds. A usage cap (the 5-hour or weekly plan
 * limit, `usage_limit_reached`, an exhausted quota or billing limit) does not refill in
 * seconds and must fail fast, so it is excluded before any per-minute wording is matched.
 *
 * A 429 is a rejection before any work starts, so replaying the request cannot bill the
 * user twice (unlike the pre-response retries in lib/grokUpstreamRetry.ts).
 *
 * One job (a plan plus its renders) spends one retry budget: a retry count, a total wait and
 * the job's generation deadline, so a burst never stretches a job past its timeout.
 *
 * MUST stay a leaf module: only retry primitives and the dependency-free job abort helper.
 */
import { oauthAbortError, throwIfOAuthAborted } from "./oauthJobDeadline.js";
import { jitterDelayMs, retryAfterDelayMs, sleepWithAbort } from "./grokUpstreamRetry.js";

export type OAuthRateLimitKind = "transient" | "permanent";

/**
 * Caps that no short wait can clear. Checked first so mixed wording never retries. A bare
 * "billing" or "credit" is not matched: per-minute messages can link to the billing page or
 * mention credits, so only an exhausted credit balance counts.
 */
const PERMANENT_LIMIT_RE =
  /usage[ _]?limit|usage cap|quota|billing[ _](?:hard[ _])?limit|hard limit|spending|insufficient[_ ]credits?|credits? (?:exhausted|depleted|balance)|out of credits|plan limit|monthly|weekly|daily|per day|\b5[- ]?hours?\b/i;
const TRANSIENT_LIMIT_RE =
  /rate[ _]?limit(?:ed| reached|_exceeded)|(?:requests|tokens|images|input-images) per min|per minute|try again in/i;
const PER_WINDOW_RE = /per min|per minute|try again in/i;

export interface OAuthRateLimitSignal {
  status?: number | undefined;
  /** Raw upstream text (message, code, type). Classified here, never forwarded to clients. */
  text?: string | null | undefined;
  /** Retry-After header wait in ms, when the rejection carried one. */
  retryAfterMs?: number | undefined;
  /** Longest single wait the retry loop may take (config `maxDelayMs`). */
  maxDelayMs?: number | undefined;
}

export interface OAuthRateLimitRetryConfig {
  /** Retries per job, plan and renders combined. */
  maxRetries: number;
  baseDelayMs: number;
  /** Cap for one wait. */
  maxDelayMs: number;
  /** Cap for all waits of one job combined. */
  maxTotalWaitMs: number;
}

export const DEFAULT_OAUTH_RATE_LIMIT_RETRY: OAuthRateLimitRetryConfig = Object.freeze({
  maxRetries: 5,
  baseDelayMs: 8_000,
  maxDelayMs: 45_000,
  maxTotalWaitMs: 120_000,
});

/** `null` means "not a rate limit this module recognizes"; only "transient" is retried. */
export function classifyOAuthRateLimit({ status, text, retryAfterMs, maxDelayMs }: OAuthRateLimitSignal): OAuthRateLimitKind | null {
  if (status === 401 || status === 403) return null;
  const s = String(text ?? "");
  if (PERMANENT_LIMIT_RE.test(s)) return status === 429 || TRANSIENT_LIMIT_RE.test(s) ? "permanent" : null;
  if (TRANSIENT_LIMIT_RE.test(s) && (status === 429 || PER_WINDOW_RE.test(s))) return "transient";
  // A wordless 429 with only Retry-After is a per-window bucket only when the wait fits one
  // retry; a longer wait points at a cap the text did not name, so it surfaces unclassified.
  if (status === 429 && retryAfterMs !== undefined) {
    return retryAfterMs <= (maxDelayMs ?? DEFAULT_OAUTH_RATE_LIMIT_RETRY.maxDelayMs) ? "transient" : null;
  }
  return null;
}

/** "Please try again in 7.5s" / "in 820ms" / "in 2 seconds" → milliseconds. */
export function parseRetryHintMs(text: string | null | undefined): number | undefined {
  const match = String(text ?? "").match(/try again in\s*([\d.]+)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return /^m/i.test(match[2] as string) ? value : value * 1000;
}

/** Fields the transport attaches to a rejected OAuth request. */
export function oauthRateLimitFields(status: number, text: string | null | undefined, headers?: Headers, maxDelayMs?: number) {
  const headerMs = headers ? retryAfterDelayMs(headers) : undefined;
  const kind = classifyOAuthRateLimit({ status, text, retryAfterMs: headerMs, maxDelayMs });
  if (!kind) return {};
  const retryAfterMs = parseRetryHintMs(text) ?? headerMs;
  return { rateLimit: kind, ...(kind === "transient" && retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function oauthRateLimitRetryConfig(raw?: Partial<OAuthRateLimitRetryConfig> | null): OAuthRateLimitRetryConfig {
  const d = DEFAULT_OAUTH_RATE_LIMIT_RETRY;
  const maxRetries = Math.min(nonNegativeInt(raw?.maxRetries, d.maxRetries), 20);
  const baseDelayMs = nonNegativeInt(raw?.baseDelayMs, d.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, nonNegativeInt(raw?.maxDelayMs, d.maxDelayMs));
  const maxTotalWaitMs = nonNegativeInt(raw?.maxTotalWaitMs, d.maxTotalWaitMs);
  return { maxRetries, baseDelayMs, maxDelayMs, maxTotalWaitMs };
}

/**
 * The upstream hint wins when it is a real wait (≥ 1s); sub-second hints are unrealistic for a
 * per-minute bucket, so the linear backoff (base × attempt) applies. The backoff is spread ±20%
 * like lib/grokUpstreamRetry.ts; a hint only moves later (0 to +20%) so no retry lands before
 * the bucket refills. Both are capped at `maxDelayMs`.
 */
export function oauthRateLimitDelayMs(
  attempt: number,
  hintMs: number | undefined,
  config: OAuthRateLimitRetryConfig,
  random: () => number = Math.random,
): number {
  if (hintMs !== undefined && hintMs >= 1000) return Math.min(Math.ceil(hintMs * (1 + random() * 0.2)), config.maxDelayMs);
  return Math.min(jitterDelayMs(config.baseDelayMs * Math.max(1, attempt), random), config.maxDelayMs);
}

export function isTransientOAuthRateLimit(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { rateLimit?: unknown }).rateLimit === "transient");
}

function retryAfterOf(error: unknown): number | undefined {
  const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Retry state shared by every call of one job; updated synchronously, so parallel renders share it safely. */
export interface OAuthRateLimitBudget {
  retries: number;
  totalWaitMs: number;
  /**
   * Epoch ms no rate-limit wait may reach (the job's generation timeout); undefined means none.
   * The job owner also bounds readiness and transport with its shared signal.
   */
  deadlineAt: number | undefined;
}

export function createOAuthRateLimitBudget(timeoutMs?: number, now: () => number = Date.now): OAuthRateLimitBudget {
  const bounded = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
  return { retries: 0, totalWaitMs: 0, deadlineAt: bounded ? now() + timeoutMs : undefined };
}

export interface OAuthRateLimitRetryInfo {
  attempt: number;
  maxRetries: number;
  waitMs: number;
  totalWaitMs: number;
}

export type OAuthRateLimitExhaustedReason = "retries" | "total_wait" | "deadline";

export interface OAuthRateLimitRetryOptions {
  config?: OAuthRateLimitRetryConfig | undefined;
  /** Job-wide budget shared by the plan and render calls; a fresh one without deadline when omitted. */
  budget?: OAuthRateLimitBudget | undefined;
  signal?: AbortSignal | null | undefined;
  /** Injected in tests; defaults to an abortable setTimeout. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Injected in tests; defaults to Math.random. */
  random?: (() => number) | undefined;
  /** Injected in tests; defaults to Date.now. */
  now?: (() => number) | undefined;
  onRetry?: ((info: OAuthRateLimitRetryInfo) => void) | undefined;
  onExhausted?: ((info: { retries: number; totalWaitMs: number; reason: OAuthRateLimitExhaustedReason }) => void) | undefined;
}

/** Why the budget cannot pay for `waitMs`, or null when it can. */
function budgetShortfall(budget: OAuthRateLimitBudget, config: OAuthRateLimitRetryConfig, waitMs: number, now: number) {
  if (budget.retries >= config.maxRetries) return "retries" as const;
  if (budget.totalWaitMs + waitMs > config.maxTotalWaitMs) return "total_wait" as const;
  if (budget.deadlineAt !== undefined && now + waitMs >= budget.deadlineAt) return "deadline" as const;
  return null;
}

/** Run `request`, replaying it after a transient rate limit. Any other error surfaces as is. */
export async function withOAuthRateLimitRetry<T>(request: () => Promise<T>, options: OAuthRateLimitRetryOptions = {}): Promise<T> {
  const config = options.config ?? DEFAULT_OAUTH_RATE_LIMIT_RETRY;
  const budget = options.budget ?? createOAuthRateLimitBudget();
  const sleep = options.sleep ?? sleepWithAbort;
  const now = options.now ?? Date.now;
  const signal = options.signal ?? undefined;
  for (let attempt = 1; ; attempt++) {
    throwIfOAuthAborted(signal);
    try {
      return await request();
    } catch (error) {
      if (!isTransientOAuthRateLimit(error)) throw error;
      // A job canceled while its request was being rate limited ends as a cancel, not a 429.
      if (signal?.aborted) throw oauthAbortError(signal);
      const waitMs = oauthRateLimitDelayMs(attempt, retryAfterOf(error), config, options.random);
      const reason = budgetShortfall(budget, config, waitMs, now());
      if (reason) {
        options.onExhausted?.({ retries: budget.retries, totalWaitMs: budget.totalWaitMs, reason });
        throw error;
      }
      budget.retries++;
      budget.totalWaitMs += waitMs;
      options.onRetry?.({ attempt: budget.retries, maxRetries: config.maxRetries, waitMs, totalWaitMs: budget.totalWaitMs });
      try {
        await sleep(waitMs, signal);
      } catch (sleepError) {
        if (signal?.aborted) throw oauthAbortError(signal);
        throw sleepError;
      }
      if (signal?.aborted) throw oauthAbortError(signal);
    }
  }
}
