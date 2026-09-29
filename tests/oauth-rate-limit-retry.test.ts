// GPT OAuth per-minute rate-limit backoff (lib/oauthRateLimit.ts). Sleep, clock and jitter are
// injected, so each case asserts the exact waits and call counts without real timers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOAuthRateLimit,
  createOAuthRateLimitBudget,
  oauthRateLimitDelayMs,
  oauthRateLimitFields,
  oauthRateLimitRetryConfig,
  parseRetryHintMs,
  withOAuthRateLimitRetry,
} from "../lib/oauthRateLimit.js";

const PER_MIN = "Rate limit reached for gpt-image-2-codex in organization org-x on input-images per min: "
  + "Limit 4000, Used 4000, Requested 3. Please try again in 7.5s.";
const CONFIG = { maxRetries: 5, baseDelayMs: 8000, maxDelayMs: 45_000, maxTotalWaitMs: 120_000 };
/** random() = 0.5 is the jitter midpoint: backoff waits are exact, hints move +10%. */
const MID = () => 0.5;

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
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "", retryAfterMs: 3000 }), "transient");
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
      "insufficient_credits: add credits to continue",
      "Your credit balance is too low to generate images",
      "You are out of credits",
    ]) {
      assert.equal(classifyOAuthRateLimit({ status: 429, text }), "permanent", text);
    }
  });

  it("keeps per-minute limits transient when the wording mentions credits", () => {
    for (const text of [
      "Rate limit reached for images per min. Requests are credited back; please try again in 5s",
      "Rate limit reached on input-images per min (credit tier 2). Please try again in 7.5s",
      "Too many requests per minute for this credit pool. Try again in 3s",
    ]) {
      assert.equal(classifyOAuthRateLimit({ status: 429, text }), "transient", text);
    }
  });

  it("retries a wordless 429 only when its Retry-After fits one wait", () => {
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "", retryAfterMs: 45_000 }), "transient", "at the cap");
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "", retryAfterMs: 45_001 }), null, "past the cap");
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "", retryAfterMs: 3600_000 }), null);
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "", retryAfterMs: 20_000, maxDelayMs: 10_000 }), null, "configured cap");
    assert.deepEqual(oauthRateLimitFields(429, "", new Headers({ "retry-after": "30" })), { rateLimit: "transient", retryAfterMs: 30_000 });
    assert.deepEqual(oauthRateLimitFields(429, "", new Headers({ "retry-after": "3600" })), {});
    assert.deepEqual(oauthRateLimitFields(429, "", new Headers({ "retry-after": "30" }), 10_000), {});
    // Per-minute wording is evidence enough; its long header is only capped, not refused.
    assert.equal(classifyOAuthRateLimit({ status: 429, text: "Rate limit reached", retryAfterMs: 3600_000 }), "transient");
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
    assert.equal(oauthRateLimitDelayMs(1, undefined, CONFIG, MID), 8000);
    assert.equal(oauthRateLimitDelayMs(3, undefined, CONFIG, MID), 24_000);
    assert.equal(oauthRateLimitDelayMs(9, undefined, CONFIG, MID), 45_000);
    assert.equal(oauthRateLimitDelayMs(1, 7500, CONFIG, () => 0), 7500);
    assert.equal(oauthRateLimitDelayMs(2, 120_000, CONFIG, MID), 45_000);
    assert.equal(oauthRateLimitDelayMs(2, 15, CONFIG, MID), 16_000, "sub-second hints fall back to the backoff");
  });

  it("spreads waits by jitter without retrying before the hint", () => {
    assert.equal(oauthRateLimitDelayMs(2, undefined, CONFIG, () => 0), 12_800, "backoff -20%");
    assert.equal(oauthRateLimitDelayMs(2, undefined, CONFIG, () => 0.999), 19_193, "backoff just under +20%");
    assert.equal(oauthRateLimitDelayMs(1, 7500, CONFIG, () => 0), 7500, "a hint never shrinks");
    assert.equal(oauthRateLimitDelayMs(1, 7500, CONFIG, () => 1), 9000, "a hint grows at most +20%");
    assert.equal(oauthRateLimitDelayMs(5, undefined, CONFIG, () => 1), 45_000, "jitter stays under the cap");
  });

  it("sanitizes the configured knobs", () => {
    assert.deepEqual(oauthRateLimitRetryConfig(undefined), CONFIG);
    assert.deepEqual(oauthRateLimitRetryConfig({ maxRetries: -1, baseDelayMs: Number.NaN, maxDelayMs: 10, maxTotalWaitMs: -5 }),
      { maxRetries: 5, baseDelayMs: 8000, maxDelayMs: 8000, maxTotalWaitMs: 120_000 });
    assert.deepEqual(oauthRateLimitRetryConfig({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, maxTotalWaitMs: 0 }),
      { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, maxTotalWaitMs: 0 });
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
    }, { config: CONFIG, sleep, random: MID, onRetry: (info) => retries.push(info.attempt) });
    assert.equal(result, "image");
    assert.equal(calls, 3);
    assert.deepEqual(waits, [8250, 16_000]);
    assert.deepEqual(retries, [1, 2]);
  });

  it("surfaces the original error once the retry budget is spent", async () => {
    const { waits, sleep } = recorder();
    const exhausted: Array<{ retries: number; totalWaitMs: number; reason: string }> = [];
    let calls = 0;
    const last = rateLimited("transient");
    await assert.rejects(withOAuthRateLimitRetry(async () => {
      calls++;
      throw calls === 3 ? last : rateLimited("transient");
    }, { config: { ...CONFIG, maxRetries: 2 }, sleep, random: MID, onExhausted: (info) => exhausted.push(info) }), (error) => error === last);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [8000, 16_000]);
    assert.deepEqual(exhausted, [{ retries: 2, totalWaitMs: 24_000, reason: "retries" }]);
  });

  it("shares one retry count across the calls of a job", async () => {
    const { waits, sleep } = recorder();
    const budget = createOAuthRateLimitBudget();
    const config = { ...CONFIG, maxRetries: 3 };
    let planCalls = 0;
    const planned = await withOAuthRateLimitRetry(async () => {
      if (++planCalls <= 2) throw rateLimited("transient");
      return "plan";
    }, { config, budget, sleep, random: MID });
    assert.equal(planned, "plan");
    const last = rateLimited("transient");
    let renderCalls = 0;
    const reasons: string[] = [];
    await assert.rejects(withOAuthRateLimitRetry(async () => { renderCalls++; throw renderCalls === 2 ? last : rateLimited("transient"); },
      { config, budget, sleep, random: MID, onExhausted: (info) => reasons.push(info.reason) }), (error) => error === last);
    assert.equal(renderCalls, 2, "the render only gets the one retry the plan left");
    assert.deepEqual(waits, [8000, 16_000, 8000]);
    assert.deepEqual(budget, { retries: 3, totalWaitMs: 32_000, deadlineAt: undefined });
    assert.deepEqual(reasons, ["retries"]);
  });

  it("stops before the total wait cap instead of trimming the wait", async () => {
    const { waits, sleep } = recorder();
    const last = rateLimited("transient", 40_000);
    const reasons: string[] = [];
    let calls = 0;
    await assert.rejects(withOAuthRateLimitRetry(async () => { calls++; throw calls === 3 ? last : rateLimited("transient", 40_000); },
      { config: { ...CONFIG, maxTotalWaitMs: 100_000 }, sleep, random: () => 0, onExhausted: (info) => reasons.push(info.reason) }),
      (error) => error === last);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [40_000, 40_000], "a third 40s wait would pass the 100s total");
    assert.deepEqual(reasons, ["total_wait"]);
  });

  it("never waits past the job deadline", async () => {
    const waits: number[] = [];
    let clock = 1_000_000;
    const now = () => clock;
    const budget = createOAuthRateLimitBudget(30_000, now);
    const reasons: string[] = [];
    const error = rateLimited("transient", 20_000);
    let calls = 0;
    await assert.rejects(withOAuthRateLimitRetry(async () => { calls++; clock += 5_000; throw error; },
      { config: CONFIG, budget, now, random: () => 0, sleep: async (ms) => { waits.push(ms); clock += ms; },
        onExhausted: (info) => reasons.push(info.reason) }), (thrown) => thrown === error);
    // t=5s: 5s + 20s < 30s, so it waits; t=30s after the second call: no time left, it throws at once.
    assert.equal(calls, 2);
    assert.deepEqual(waits, [20_000]);
    assert.deepEqual(reasons, ["deadline"]);
    assert.equal(createOAuthRateLimitBudget(0).deadlineAt, undefined, "a disabled timeout sets no deadline");
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
    const waits: number[] = [];
    const pending = withOAuthRateLimitRetry(async () => { calls++; throw rateLimited("transient"); },
      { config: { ...CONFIG, baseDelayMs: 60_000, maxDelayMs: 60_000 }, signal: controller.signal,
        // The cancel lands during the first wait; the injected sleep rejects the way an aborted timer does.
        sleep: async (ms) => { waits.push(ms); controller.abort(); throw new Error("aborted"); } });
    await assert.rejects(pending, (error: { status?: number; code?: string }) =>
      error.status === 499 && error.code === "GENERATION_CANCELED");
    assert.equal(calls, 1, "no request after the cancel");
    assert.equal(waits.length, 1, "one wait started, then the cancel ended the job");
  });

  it("reports a cancel, not the 429, for an already canceled job and starts no wait", async () => {
    const controller = new AbortController();
    controller.abort();
    const { waits, sleep } = recorder();
    const error = rateLimited("transient");
    await assert.rejects(withOAuthRateLimitRetry(async () => { throw error; }, { config: CONFIG, signal: controller.signal, sleep }),
      (thrown: { status?: number; code?: string }) => thrown.status === 499 && thrown.code === "GENERATION_CANCELED");
    assert.deepEqual(waits, []);
  });

  it("lets a non-rate-limit error surface unchanged even after a cancel", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new Error("boom");
    await assert.rejects(withOAuthRateLimitRetry(async () => { throw error; }, { config: CONFIG, signal: controller.signal }),
      (thrown) => thrown === error);
  });
});
