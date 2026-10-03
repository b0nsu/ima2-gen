import assert from "node:assert/strict";
import { after, before, test, mock } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { executionTestProcess } from "./_executionTestProcess.ts";
import type { RouteRuntimeContext } from "../lib/runtimeContext.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function held(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
function check(error: unknown, canceled = false) {
  assert.ok(error instanceof Error);
  assert.equal(Reflect.get(error, "status"), canceled ? 499 : 504);
  assert.equal(Reflect.get(error, "code"), canceled ? "GENERATION_CANCELED" : "RESPONSES_IMAGE_TIMEOUT");
  assert.equal(error.message, canceled ? "Generation canceled" : "Responses image generation timed out");
  return true;
}

if (executionTestProcess(import.meta.url)) {
  let post: typeof import("../lib/responsesTransport.ts").postResponses;
  let postImages: typeof import("../lib/responsesTransport.ts").postOAuthImages;
  let ctx: RouteRuntimeContext;
  const originalFetch = globalThis.fetch;
  before(async () => {
    mock.module(new URL("../lib/inflight.ts", import.meta.url).href, { namedExports: { setJobPhase() {} } });
    mock.module(new URL("../lib/codexBackend/index.ts", import.meta.url).href, { namedExports: {
      oauthFetch: (_ctx: unknown, _path: string, init: RequestInit) => globalThis.fetch("http://fixture.invalid", init),
    } });
    const { config } = await import("../config.ts");
    ctx = { apiKey: "fixture", config: { ...config, oauth: { ...config.oauth, generationTimeoutMs: 100 } } };
    ({ postResponses: post, postOAuthImages: postImages } = await import("../lib/responsesTransport.ts"));
    globalThis.fetch = async () => { throw new Error("Unexpected real network call"); };
  });
  after(() => { mock.restoreAll(); globalThis.fetch = originalFetch; });

  for (const cause of ["timeout", "cancel"] as const) {
    test(`API awaits persistence callback after ${cause}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const event = { type: "response.output_item.done", item: { type: "image_generation_call", result: "fixture" } };
      globalThis.fetch = async () => new Response(`data: ${JSON.stringify(event)}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
      const entered = deferred<void>(), persist = deferred<void>(), user = new AbortController();
      let settled = false;
      const result = post({ ctx, provider: "api", scope: "api-compat", payload: {}, signal: user.signal,
        onFinalImage: async () => { entered.resolve(); await persist.promise; } });
      void result.then(() => { settled = true; }, () => { settled = true; });
      await entered.promise;
      if (cause === "cancel") user.abort(); else t.mock.timers.tick(100);
      await turn();
      try { assert.equal(settled, false, "persistence must remain awaited"); }
      finally { persist.resolve(); }
      assert.equal((await result).images.length, 1);
    });
  }

  test("API negative timeout retains scheduling and original 504 message", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const schedule = globalThis.setTimeout, delays: number[] = [], entered = deferred<void>();
    t.mock.method(globalThis, "setTimeout", (fn: () => void, ms: number) => {
      delays.push(ms); return schedule(fn, Math.max(1, ms));
    });
    globalThis.fetch = async (_url, init) => { entered.resolve(); return held(init?.signal); };
    const result = assert.rejects(post({ ctx: { ...ctx, config: { ...ctx.config,
      oauth: { ...ctx.config?.oauth, generationTimeoutMs: -1 } } },
      provider: "api", scope: "api-compat", payload: {} }), error => check(error));
    await entered.promise; assert.deepEqual(delays, [-1]); t.mock.timers.tick(1); await result;
  });

  test("API external cancellation retains catch-time precedence", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const entered = deferred<void>(), response = deferred<Response>(), user = new AbortController();
    globalThis.fetch = async () => { entered.resolve(); return response.promise; };
    const result = assert.rejects(post({ ctx, provider: "api", scope: "api-compat", payload: {}, signal: user.signal }),
      error => check(error, true));
    await entered.promise; t.mock.timers.tick(100); user.abort();
    response.reject(new DOMException("aborted", "AbortError")); await result;
  });

  for (const kind of ["planner", "render"] as const) {
    test(`standalone OAuth ${kind} request timeout keeps RESPONSES code`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const entered = deferred<void>();
      globalThis.fetch = async (_url, init) => { entered.resolve(); return held(init?.signal); };
      const call = kind === "planner" ? post({ ctx, provider: "oauth", scope: "request-compat", payload: {}, maxImages: 0 })
        : postImages({ ctx, scope: "request-compat", kind: "generations", json: {} });
      const result = assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(Reflect.get(error, "status"), 504);
        assert.equal(Reflect.get(error, "code"), "RESPONSES_IMAGE_TIMEOUT"); return true;
      });
      await entered.promise; t.mock.timers.tick(100); await result;
    });
  }
}
