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
 * MUST stay a leaf module: it only borrows the abortable sleep and Retry-After parsing.
 */
import { retryAfterDelayMs, sleepWithAbort } from "./grokUpstreamRetry.js";

export type OAuthRateLimitKind = "transient" | "permanent";

/**
 * Caps that no short wait can clear. Checked first so mixed wording never retries. A bare
 * "billing" is not matched: per-minute messages can link to the account billing page.
 */
const PERMANENT_LIMIT_RE =
  /usage[ _]?limit|usage cap|quota|billing[ _](?:hard[ _])?limit|hard limit|spending|credit|plan limit|monthly|weekly|daily|per day|\b5[- ]?hours?\b/i;
const TRANSIENT_LIMIT_RE =
  /rate[ _]?limit(?:ed| reached|_exceeded)|(?:requests|tokens|images|input-images) per min|per minute|try again in/i;
const PER_WINDOW_RE = /per min|per minute|try again in/i;

export interface OAuthRateLimitSignal {
  status?: number | undefined;
  /** Raw upstream text (message, code, type). Classified here, never forwarded to clients. */
  text?: string | null | undefined;
  /** A Retry-After header was present on the rejection. */
  hasRetryAfter?: boolean | undefined;
}

/** `null` means "not a rate limit this module recognizes"; only "transient" is retried. */
export function classifyOAuthRateLimit({ status, text, hasRetryAfter }: OAuthRateLimitSignal): OAuthRateLimitKind | null {
  if (status === 401 || status === 403) return null;
  const s = String(text ?? "");
  if (PERMANENT_LIMIT_RE.test(s)) return status === 429 || TRANSIENT_LIMIT_RE.test(s) ? "permanent" : null;
  if (TRANSIENT_LIMIT_RE.test(s) && (status === 429 || PER_WINDOW_RE.test(s))) return "transient";
  if (status === 429 && hasRetryAfter) return "transient";
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
export function oauthRateLimitFields(status: number, text: string | null | undefined, headers?: Headers) {
  const headerMs = headers ? retryAfterDelayMs(headers) : undefined;
  const kind = classifyOAuthRateLimit({ status, text, hasRetryAfter: headerMs !== undefined });
  if (!kind) return {};
  const retryAfterMs = parseRetryHintMs(text) ?? headerMs;
  return { rateLimit: kind, ...(kind === "transient" && retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

export interface OAuthRateLimitRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OAUTH_RATE_LIMIT_RETRY: OAuthRateLimitRetryConfig = Object.freeze({
  maxRetries: 5,
  baseDelayMs: 8_000,
  maxDelayMs: 45_000,
});

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function oauthRateLimitRetryConfig(raw?: Partial<OAuthRateLimitRetryConfig> | null): OAuthRateLimitRetryConfig {
  const d = DEFAULT_OAUTH_RATE_LIMIT_RETRY;
  const maxRetries = Math.min(nonNegativeInt(raw?.maxRetries, d.maxRetries), 20);
  const baseDelayMs = nonNegativeInt(raw?.baseDelayMs, d.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, nonNegativeInt(raw?.maxDelayMs, d.maxDelayMs));
  return { maxRetries, baseDelayMs, maxDelayMs };
}

/**
 * The upstream hint wins when it is a real wait (≥ 1s); sub-second hints are unrealistic for a
 * per-minute bucket, so the linear backoff (base × attempt) applies. Both are capped.
 */
export function oauthRateLimitDelayMs(attempt: number, hintMs: number | undefined, config: OAuthRateLimitRetryConfig): number {
  if (hintMs !== undefined && hintMs >= 1000) return Math.min(Math.ceil(hintMs), config.maxDelayMs);
  return Math.min(config.baseDelayMs * Math.max(1, attempt), config.maxDelayMs);
}

export function isTransientOAuthRateLimit(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { rateLimit?: unknown }).rateLimit === "transient");
}

function retryAfterOf(error: unknown): number | undefined {
  const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function canceledError(cause: unknown) {
  return Object.assign(new Error("Generation canceled"), { status: 499, code: "GENERATION_CANCELED", cause });
}

export interface OAuthRateLimitRetryInfo {
  attempt: number;
  maxRetries: number;
  waitMs: number;
  totalWaitMs: number;
}

export interface OAuthRateLimitRetryOptions {
  config?: OAuthRateLimitRetryConfig | undefined;
  signal?: AbortSignal | null | undefined;
  /** Injected in tests; defaults to an abortable setTimeout. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onRetry?: ((info: OAuthRateLimitRetryInfo) => void) | undefined;
  onExhausted?: ((info: { retries: number; totalWaitMs: number }) => void) | undefined;
}

/** Run `request`, replaying it after a transient rate limit. Any other error surfaces as is. */
export async function withOAuthRateLimitRetry<T>(request: () => Promise<T>, options: OAuthRateLimitRetryOptions = {}): Promise<T> {
  const config = options.config ?? DEFAULT_OAUTH_RATE_LIMIT_RETRY;
  const sleep = options.sleep ?? sleepWithAbort;
  const signal = options.signal ?? undefined;
  let totalWaitMs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!isTransientOAuthRateLimit(error) || signal?.aborted) throw error;
      if (attempt > config.maxRetries) {
        options.onExhausted?.({ retries: attempt - 1, totalWaitMs });
        throw error;
      }
      const waitMs = oauthRateLimitDelayMs(attempt, retryAfterOf(error), config);
      totalWaitMs += waitMs;
      options.onRetry?.({ attempt, maxRetries: config.maxRetries, waitMs, totalWaitMs });
      try {
        await sleep(waitMs, signal);
      } catch (sleepError) {
        if (signal?.aborted) throw canceledError(sleepError);
        throw sleepError;
      }
      if (signal?.aborted) throw canceledError(signal.reason);
    }
  }
}
