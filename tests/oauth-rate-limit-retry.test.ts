// GPT OAuth per-minute rate-limit backoff (lib/oauthRateLimit.ts). The sleep is injected, so
// each case asserts the exact waits and call counts without real timers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOAuthRateLimit,
  oauthRateLimitDelayMs,
  oauthRateLimitFields,
  oauthRateLimitRetryConfig,
  parseRetryHintMs,
  withOAuthRateLimitRetry,
} from "../lib/oauthRateLimit.js";

const PER_MIN = "Rate limit reached for gpt-image-2-codex in organization org-x on input-images per min: "
  + "Limit 4000, Used 4000, Requested 3. Please try again in 7.5s.";
const CONFIG = { maxRetries: 5, baseDelayMs: 8000, maxDelayMs: 45_000 };

function rateLimited(kind: "transient" | "permanent", retryAfterMs?: number) {
  return Object.assign(new Error("OpenAI rate limited the image request."), {
    status: 429, code: "RESPONSES_IMAGE_ERROR", rateLimit: kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

describe("OAuth rate-limit classification", () => {
  it("treats per-minute buckets and retry hints as transient", () => {
    assert.equal(classifyOAuthRateLimit({ status: 429, text: PER_MIN }), "transient");
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "Rate limit reached for requests" }), "transient");
    assert.equal(classifyOAuthRateLimit({ status: 400, text: "tokens per min exceeded, try again in 2s" }), "transient");
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "", hasRetryAfter: true }), "transient");
    // Per-minute messages may link the billing page; that alone is not a billing cap.
    assert.equal(classifyOAuthRateLimit({
      status: 429, text: `${PER_MIN} Add a payment method at https://platform.openai.com/account/billing.`,
    }), "transient");
  });

  it("never treats usage caps, quotas or plan windows as transient", () => {
    for (const text of [
      "The usage limit has been reached usage_limit_reached",
      "You exceeded your current quota, please check your plan and billing details. insufficient_quota",
      "Rate limit reached: weekly limit for your plan. Please try again in 3 days",
      "You've hit your 5-hour limit. Try again in 2s",
      "Rate limit reached on requests per day (RPD). Please try again in 7.5s",
      "Billing hard limit has been reached",
    ]) {
      assert.equal(classifyOAuthRateLimit({ status: 429, text }), "permanent", text);
    }
  });

  it("ignores auth failures and unrecognized errors", () => {
    assert.equal(classifyOAuthRateLimit({ status: 401, text: PER_MIN }), null);
    assert.equal(classifyOAuthRateLimit({ status: 403, text: "rate limit reached" }), null);
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "" }), null, "a bare 429 without hints is not retried");
    assert.equal(classifyOAuthRateLimit({ status: 400, text: "invalid size" }), null);
    assert.equal(classifyOAuthRateLimit({ status: 400, text: "insufficient credit for this model" }), null);
  });

  it("parses retry hints and prefers the message over Retry-After", () => {
    assert.equal(parseRetryHintMs(PER_MIN), 7500);
    assert.equal(parseRetryHintMs("please try again in 820ms"), 820);
    assert.equal(parseRetryHintMs("Try again in 2 seconds"), 2000);
    assert.equal(parseRetryHintMs("no hint"), undefined);
    assert.deepEqual(oauthRateLimitFields(429, PER_MIN, new Headers({ "retry-after": "20" })), { rateLimit: "transient", retryAfterMs: 7500 });
    assert.deepEqual(oauthRateLimitFields(429, "Rate limit reached", new Headers({ "retry-after": "3" })), { rateLimit: "transient", retryAfterMs: 3000 });
    assert.deepEqual(oauthRateLimitFields(429, "usage_limit_reached", new Headers({ "retry-after": "3" })), { rateLimit: "permanent" });
    assert.deepEqual(oauthRateLimitFields(400, "invalid size"), {});
  });
});

describe("OAuth rate-limit backoff", () => {
  it("waits base x attempt, honours a real hint and caps every wait", () => {
    assert.equal(oauthRateLimitDelayMs(1, undefined, CONFIG), 8000);
    assert.equal(oauthRateLimitDelayMs(3, undefined, CONFIG), 24_000);
    assert.equal(oauthRateLimitDelayMs(9, undefined, CONFIG), 45_000);
    assert.equal(oauthRateLimitDelayMs(1, 7500, CONFIG), 7500);
    assert.equal(oauthRateLimitDelayMs(2, 120_000, CONFIG), 45_000);
    assert.equal(oauthRateLimitDelayMs(2, 15, CONFIG), 16_000, "sub-second hints fall back to the backoff");
  });

  it("sanitizes the configured knobs", () => {
    assert.deepEqual(oauthRateLimitRetryConfig(undefined), CONFIG);
    assert.deepEqual(oauthRateLimitRetryConfig({ maxRetries: -1, baseDelayMs: Number.NaN, maxDelayMs: 10 }),
      { maxRetries: 5, baseDelayMs: 8000, maxDelayMs: 8000 });
    assert.deepEqual(oauthRateLimitRetryConfig({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 }),
      { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 });
  });

  it("retries the same request after a transient limit and returns its result", async () => {
    const { waits, sleep } = recorder();
    const retries: number[] = [];
    let calls = 0;
    const result = await withOAuthRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw rateLimited("transient", 7500);
      if (calls === 2) throw rateLimited("transient");
      return "image";
    }, { config: CONFIG, sleep, onRetry: (info) => retries.push(info.attempt) });
    assert.equal(result, "image");
    assert.equal(calls, 3);
    assert.deepEqual(waits, [7500, 16_000]);
    assert.deepEqual(retries, [1, 2]);
  });

  it("surfaces the original error once the retry budget is spent", async () => {
    const { waits, sleep } = recorder();
    const exhausted: Array<{ retries: number; totalWaitMs: number }> = [];
    let calls = 0;
    const last = rateLimited("transient");
    await assert.rejects(withOAuthRateLimitRetry(async () => {
      calls++;
      throw calls === 3 ? last : rateLimited("transient");
    }, { config: { ...CONFIG, maxRetries: 2 }, sleep, onExhausted: (info) => exhausted.push(info) }), (error) => error === last);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [8000, 16_000]);
    assert.deepEqual(exhausted, [{ retries: 2, totalWaitMs: 24_000 }]);
  });

  it("never retries permanent limits or other errors", async () => {
    for (const error of [rateLimited("permanent"), Object.assign(new Error("auth"), { status: 401 }), new Error("boom")]) {
      const { waits, sleep } = recorder();
      let calls = 0;
      await assert.rejects(withOAuthRateLimitRetry(async () => { calls++; throw error; }, { config: CONFIG, sleep }),
        (thrown) => thrown === error);
      assert.equal(calls, 1);
      assert.deepEqual(waits, []);
    }
  });

  it("stops waiting as soon as the job is canceled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();
    const pending = withOAuthRateLimitRetry(async () => { calls++; throw rateLimited("transient"); },
      { config: { ...CONFIG, baseDelayMs: 60_000, maxDelayMs: 60_000 }, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error: { status?: number; code?: string }) =>
      error.status === 499 && error.code === "GENERATION_CANCELED");
    assert.equal(calls, 1, "no request after the cancel");
    assert.ok(Date.now() - started < 5000, "the 60s wait was cut short");
  });

  it("does not start a wait for an already canceled job", async () => {
    const controller = new AbortController();
    controller.abort();
    const { waits, sleep } = recorder();
    const error = rateLimited("transient");
    await assert.rejects(withOAuthRateLimitRetry(async () => { throw error; }, { config: CONFIG, signal: controller.signal, sleep }),
      (thrown) => thrown === error);
    assert.deepEqual(waits, []);
  });
});
