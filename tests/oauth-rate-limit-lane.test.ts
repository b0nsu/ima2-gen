/**
 * GPT OAuth per-minute rate limits through the real classic route (lib/oauthImages.ts +
 * lib/responsesTransport.ts): a transient 429 is replayed and succeeds, a usage cap fails on
 * the first call. Waits are zeroed on the live config so the case stays fast.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readdir } from "node:fs/promises";
import sharp from "sharp";
import { executionTestProcess } from "./_executionTestProcess.ts";
import { openRouteHarness, type RouteHarness, type UpstreamCall } from "./_executionRouteHarness.ts";
import { imagesJson } from "./_oauthNativeFixture.ts";

const OAUTH = "http://oauth-fixture.invalid";
const BASE = { provider: "oauth", mode: "direct", model: "gpt-6-luna", prompt: "rate limited prompt", quality: "high",
  size: "1024x1024", moderation: "low", reasoningEffort: "medium", webSearchEnabled: false, sizeNudge: false, format: "png" };
const PER_MIN = "Rate limit reached for gpt-image-2-codex in organization org-fixture on input-images per min: "
  + "Limit 4000, Used 4000, Requested 3. Please try again in 7.5s.";

const endpointOf = (call: UpstreamCall) => call.url.slice(OAUTH.length);

function rejection(message: string, type: string) {
  return new Response(JSON.stringify({ error: { message, type, code: type } }), {
    status: 429, headers: { "content-type": "application/json" },
  });
}

if (executionTestProcess(import.meta.url)) describe("GPT OAuth rate-limit backoff lane", { concurrency: false }, () => {
  let harness: RouteHarness;
  let red: string;
  before(async () => {
    harness = await openRouteHarness();
    // The routes read the live config object; zero the waits instead of sleeping 7.5s per retry.
    const { config } = await import("../config.ts");
    Object.assign(config.oauth.rateLimitRetry, { baseDelayMs: 0, maxDelayMs: 0 });
    red = (await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toBuffer()).toString("base64");
  });
  after(async () => { await harness?.close(); });

  it("a per-minute 429 is replayed until the render succeeds", async () => {
    let renders = 0;
    await harness.run("classic", { upstream: () => (++renders < 3 ? rejection(PER_MIN, "rate_limit_exceeded") : imagesJson(red)) }, async (f) => {
      const response = await f.post(BASE);
      assert.equal(response.status, 200);
      const result = await response.json();
      await f.waitSettled();
      assert.deepEqual(f.calls.map(endpointOf), Array(3).fill("/v1/images/generations"), "the same request is sent again");
      assert.deepEqual(new Set(f.calls.map((call) => call.body)).size, 1);
      assert.equal(result.image, `data:image/png;base64,${red}`);
    });
  });

  it("a usage cap is not retried and nothing is saved", async () => {
    await harness.run("classic", { upstream: () => rejection("The usage limit has been reached", "usage_limit_reached") }, async (f) => {
      const response = await f.post(BASE);
      assert.notEqual(response.status, 200);
      await f.waitSettled();
      assert.deepEqual(f.calls.map(endpointOf), ["/v1/images/generations"]);
      assert.deepEqual((await readdir(f.generatedDir)).filter((file) => file.endsWith(".json")), []);
    });
  });
});
