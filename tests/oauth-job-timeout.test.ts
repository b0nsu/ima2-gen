import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import type { TestContext } from "node:test";
import { after, before, test, mock } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { executionTestProcess } from "./_executionTestProcess.ts";
import { plannerSse, imagesJson } from "./_oauthNativeFixture.ts";
import type { OAuthImageJob } from "../lib/oauthImages.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    value => { settled = true; return { value, error: undefined }; },
    (error: unknown) => { settled = true; return { value: undefined, error }; },
  );
  return { outcome, settled: () => settled };
}
function expectCode(error: unknown, code = "OAUTH_IMAGE_TIMEOUT", status = 504) {
  assert.ok(error instanceof Error);
  assert.equal(Reflect.get(error, "code"), code);
  assert.equal(Reflect.get(error, "status"), status);
}

function held(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const schedule = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const live = new Set<ReturnType<typeof setTimeout>>(), delays: number[] = [];
  const barriers = new Map<number, ReturnType<typeof deferred<void>>>();
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms: number) => {
    const handle = schedule(() => { live.delete(handle); fn(); }, ms);
    live.add(handle); delays.push(ms); barriers.get(ms)?.resolve();
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle: ReturnType<typeof setTimeout>) => {
    live.delete(handle); clear(handle);
  });
  return { live, delays, entered(ms: number) {
    if (delays.includes(ms)) return Promise.resolve();
    const barrier = deferred<void>(); barriers.set(ms, barrier); return barrier.promise;
  } };
}

if (executionTestProcess(import.meta.url)) {
  let run: typeof import("../lib/oauthImages.ts").runOAuthImageJob;
  let base: OAuthImageJob;
  let upstream: (path: string, init: RequestInit) => Promise<Response>;
  const originalFetch = globalThis.fetch;
  before(async () => {
    globalThis.fetch = async () => { throw new Error("Unexpected real network call"); };
    mock.module(new URL("../lib/codexBackend/index.ts", import.meta.url).href, { namedExports: {
      oauthFetch: (_ctx: unknown, path: string, init: RequestInit) => upstream(path, init),
    } });
    mock.module(new URL("../lib/inflight.ts", import.meta.url).href, { namedExports: { setJobPhase() {}, isJobCanceled: () => false } });
    const { config } = await import("../config.ts");
    ({ runOAuthImageJob: run } = await import("../lib/oauthImages.ts"));
    base = {
      ctx: { config: { ...config, oauth: { ...config.oauth, generationTimeoutMs: 100, statusTimeoutMs: 1000 } },
        oauthReadyState: "ready", oauthTransport: "proxy", oauthUrl: "http://fixture.invalid" },
      scope: "deadline-test", model: "gpt-6-luna", mode: "auto", reasoningEffort: "low",
      webSearchEnabled: false, developerPrompt: "test", userText: "test", directPrompt: "test",
      images: [], maxImages: 1,
    };
  });
  after(() => { mock.restoreAll(); globalThis.fetch = originalFetch; });

  test("planner budget reduces render time", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const planning = deferred<void>(), rendering = deferred<void>();
    const plan = deferred<Response>(), render = deferred<Response>();
    upstream = async (path) => {
      if (path === "/v1/responses") { planning.resolve(); return plan.promise; }
      rendering.resolve(); return render.promise;
    };
    const work = observe(run(base));
    await planning.promise;
    t.mock.timers.tick(60);
    plan.resolve(plannerSse(["render"]));
    await rendering.promise;
    t.mock.timers.tick(40);
    await turn();
    try {
      assert.equal(work.settled(), true, "job must settle at total 100ms, not render 160ms");
      expectCode((await work.outcome).error);
    } finally {
      render.resolve(imagesJson("fixture"));
      await work.outcome;
    }
  });

  test("noncooperative response body rejects late after deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const reading = deferred<void>(), body = deferred<string>();
    upstream = async () => {
      const response = new Response();
      response.text = () => { reading.resolve(); return body.promise; };
      return response;
    };
    const work = observe(run({ ...base, mode: "direct" }));
    await reading.promise;
    t.mock.timers.tick(100);
    await turn();
    try {
      assert.equal(work.settled(), true, "body must not extend job deadline");
      expectCode((await work.outcome).error);
    } finally {
      body.reject(new Error("late body rejection"));
      await work.outcome;
      await turn();
    }
  });

  test("planner retry shares deadline", async (t) => {
    clock(t);
    const retry = deferred<void>(); let plans = 0;
    upstream = async (path, init) => {
      assert.equal(path, "/v1/responses");
      if (++plans === 1) { t.mock.timers.tick(60); return plannerSse([]); }
      retry.resolve(); return held(init.signal);
    };
    const work = observe(run(base));
    await retry.promise; t.mock.timers.tick(40);
    expectCode((await work.outcome).error); assert.equal(plans, 2);
  });

  for (const cause of ["deadline", "status", "cancel"] as const) {
    test(`readiness ${cause} before any upstream call`, async (t) => {
      const timers = clock(t), parent = new AbortController(), ready = deferred<void>();
      const statusMs = cause === "status" ? 20 : 1000;
      upstream = async () => { assert.fail("fetch during readiness"); };
      const job = { ...base, signal: parent.signal, ctx: { ...base.ctx, oauthReadyState: "starting" as const,
        oauthReadyPromise: ready.promise, config: { ...base.ctx.config,
          oauth: { ...base.ctx.config?.oauth, statusTimeoutMs: statusMs } } } };
      const work = observe(run(job));
      await timers.entered(statusMs);
      if (cause === "cancel") parent.abort(new Error("private detail"));
      else t.mock.timers.tick(cause === "status" ? 20 : 100);
      const result = await work.outcome;
      expectCode(result.error, cause === "status" ? "OAUTH_UNAVAILABLE" : cause === "cancel" ? "GENERATION_CANCELED" : "OAUTH_IMAGE_TIMEOUT",
        cause === "status" ? 503 : cause === "cancel" ? 499 : 504);
      assert.equal(timers.live.size, 0); assert.equal(getEventListeners(parent.signal, "abort").length, 0);
      t.mock.timers.tick(1000); ready.resolve(); await turn();
    });
  }

  test("direct mode timeout has no planner", async (t) => {
    clock(t); const entered = deferred<void>(); let calls = 0;
    upstream = async (path, init) => {
      calls++; assert.equal(path, "/v1/images/generations"); entered.resolve(); return held(init.signal);
    };
    const work = observe(run({ ...base, mode: "direct" }));
    await entered.promise; t.mock.timers.tick(100);
    expectCode((await work.outcome).error); assert.equal(calls, 1);
  });

  for (const stage of ["before", "planner", "render", "backoff"] as const) {
    test(`user cancel ${stage} is sanitized and stops requests`, async (t) => {
      const timers = clock(t), parent = new AbortController(), entered = deferred<void>(); let calls = 0;
      upstream = async (_path, init) => {
        calls++; entered.resolve();
        return stage === "backoff" ? new Response(JSON.stringify({ error: {
          message: "Rate limit reached for requests per min", code: "rate_limit_exceeded",
        } }), { status: 429 }) : held(init.signal);
      };
      if (stage === "before") parent.abort(new Error("private detail"));
      const work = observe(run({ ...base, mode: stage === "planner" ? "auto" : "direct", signal: parent.signal,
        ctx: { ...base.ctx, config: { ...base.ctx.config, oauth: { ...base.ctx.config?.oauth,
          rateLimitRetry: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 10, maxTotalWaitMs: 50 } } } } }));
      if (stage !== "before") {
        await entered.promise;
        if (stage === "backoff") {
          await turn(); assert.ok(timers.delays.some(ms => ms >= 8 && ms <= 10), "backoff timer entered");
        }
        parent.abort(new Error("private detail"));
      }
      const result = await work.outcome; expectCode(result.error, "GENERATION_CANCELED", 499);
      assert.doesNotMatch(String(result.error), /private detail/);
      assert.equal(calls, stage === "before" ? 0 : 1); assert.equal(timers.live.size, 0);
      t.mock.timers.tick(1000); assert.equal(calls, stage === "before" ? 0 : 1);
    });
  }

  test("completed images survive timeout", async (t) => {
    clock(t); const delivered = deferred<void>();
    upstream = async (path, init) => {
      if (path === "/v1/responses") return plannerSse(["first", "second"]);
      const body = JSON.parse(String(init.body)) as { prompt: string };
      return body.prompt === "first" ? imagesJson("fixture") : held(init.signal);
    };
    const work = run({ ...base, maxImages: 2, onFinalImage: () => { delivered.resolve(); } });
    await delivered.promise; t.mock.timers.tick(100);
    const result = await work; assert.deepEqual(result.originalIndexes, [0]);
    assert.equal(result.images[0]?.b64, "fixture"); expectCode(result.error);
  });

  for (const earlyErrorFirst of [true, false]) {
    test(`first error follows planner order: early400first=${earlyErrorFirst}`, async (t) => {
      clock(t); const delivered = deferred<void>(), errorBodyRead = deferred<void>();
      upstream = async (path, init) => {
        if (path === "/v1/responses") return plannerSse(["zero", "one", "two"]);
        const { prompt } = JSON.parse(String(init.body)) as { prompt: string };
        if (prompt === "one") return imagesJson("fixture");
        if (prompt === (earlyErrorFirst ? "zero" : "two")) {
          const response = new Response("", { status: 400 });
          response.text = async () => { errorBodyRead.resolve(); return JSON.stringify({ error: { message: "bad", type: "invalid_request_error" } }); };
          return response;
        }
        return held(init.signal);
      };
      const work = run({ ...base, maxImages: 3, onFinalImage: () => { delivered.resolve(); } });
      if (earlyErrorFirst) await delivered.promise;
      else { await errorBodyRead.promise; await turn(); }
      t.mock.timers.tick(100);
      const result = await work;
      assert.deepEqual(result.originalIndexes, [1]); assert.equal(result.images.length, 1);
      if (earlyErrorFirst) assert.equal(Reflect.get(result.error as object, "status"), 400);
      else expectCode(result.error);
    });
  }

  test("queued fourth render never calls upstream after abort", async (t) => {
    clock(t); const full = deferred<void>(); let renders = 0;
    upstream = async (path, init) => {
      if (path === "/v1/responses") return plannerSse(["a", "b", "c", "d"]);
      if (++renders === 3) full.resolve(); return held(init.signal);
    };
    const work = run({ ...base, maxImages: 4 });
    await full.promise; t.mock.timers.tick(100);
    const result = await work; assert.equal(renders, 3); assert.deepEqual(result.images, []); expectCode(result.error);
  });

  for (const finish of ["success", "error", "cancel", "ready"] as const) {
    test(`job timer and listener cleanup after ${finish}`, async (t) => {
      const timers = clock(t), parent = new AbortController(), ready = deferred<void>(), entered = deferred<void>();
      const initialListeners = getEventListeners(parent.signal, "abort").length; let calls = 0;
      upstream = async (_path, init) => {
        calls++; entered.resolve();
        if (finish === "cancel") return held(init.signal);
        return finish === "error" ? new Response("", { status: 500 }) : imagesJson("fixture");
      };
      const job: OAuthImageJob = { ...base, mode: "direct", signal: parent.signal, ctx: { ...base.ctx } };
      if (finish === "ready") { job.ctx.oauthReadyState = "starting"; job.ctx.oauthReadyPromise = ready.promise; }
      const work = observe(run(job));
      if (finish === "ready") { await timers.entered(1000); job.ctx.oauthReadyState = "ready"; ready.resolve(); }
      await entered.promise; if (finish === "cancel") parent.abort();
      const result = await work.outcome;
      assert.equal(Boolean(result.error), finish === "error" || finish === "cancel");
      assert.equal(timers.live.size, 0);
      assert.equal(getEventListeners(parent.signal, "abort").length, initialListeners);
      t.mock.timers.tick(1000); assert.equal(calls, 1);
    });
  }

  for (const value of [0, -1, NaN, Infinity]) {
    test(`disabled OAuth timeout ${value} still accepts cancellation`, async (t) => {
      const timers = clock(t), entered = deferred<void>(), parent = new AbortController();
      upstream = async (_path, init) => { entered.resolve(); return held(init.signal); };
      const work = observe(run({ ...base, mode: "direct", signal: parent.signal, ctx: { ...base.ctx,
        config: { ...base.ctx.config, oauth: { ...base.ctx.config?.oauth, generationTimeoutMs: value } } } }));
      await entered.promise; assert.deepEqual(timers.delays, []);
      t.mock.timers.tick(1000); assert.equal(work.settled(), false);
      parent.abort(); expectCode((await work.outcome).error, "GENERATION_CANCELED", 499);
    });
  }

  test("absent job-local timeout uses global config", async (t) => {
    const timers = clock(t), entered = deferred<void>(), parent = new AbortController();
    const { config } = await import("../config.ts");
    t.mock.property(config.oauth, "generationTimeoutMs", 137);
    upstream = async (_path, init) => { entered.resolve(); return held(init.signal); };
    const work = observe(run({ ...base, mode: "direct", signal: parent.signal,
      ctx: { ...base.ctx, config: { oauth: {} } } }));
    await entered.promise; assert.deepEqual(timers.delays, [137, 137]);
    parent.abort(); expectCode((await work.outcome).error, "GENERATION_CANCELED", 499);
    assert.equal(timers.live.size, 0);
  });

  test("admitted backoff timeout preserves job cause and sends no retry", async (t) => {
    clock(t);
    const { createOAuthJobDeadline } = await import("../lib/oauthJobDeadline.ts");
    const { withOAuthRateLimitRetry, createOAuthRateLimitBudget } = await import("../lib/oauthRateLimit.ts");
    const lifetime = createOAuthJobDeadline(100), waiting = deferred<void>(); let calls = 0;
    const work = observe(withOAuthRateLimitRetry(async () => {
      calls++; throw Object.assign(new Error("limited"), { rateLimit: "transient" });
    }, {
      signal: lifetime.signal, budget: createOAuthRateLimitBudget(100),
      config: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 10, maxTotalWaitMs: 50 }, random: () => 0.5,
      sleep: async (_ms, signal) => { waiting.resolve(); await held(signal); },
    }));
    await waiting.promise; t.mock.timers.tick(100);
    expectCode((await work.outcome).error); assert.equal(calls, 1); lifetime.dispose();
  });

  test("fraction rounds to 1ms and disposing detaches parent", async (t) => {
    const timers = clock(t), parent = new AbortController();
    const { createOAuthJobDeadline } = await import("../lib/oauthJobDeadline.ts");
    const life = createOAuthJobDeadline(0.5, parent.signal);
    assert.deepEqual(timers.delays, [1]); life.dispose(); parent.abort(); t.mock.timers.tick(100);
    assert.equal(life.signal.aborted, false); assert.equal(timers.live.size, 0);
    const expired = createOAuthJobDeadline(0.5); t.mock.timers.tick(1);
    expectCode(expired.signal.reason); expired.dispose();
  });

  for (const timeoutFirst of [true, false]) {
    test(`OAuth first abort wins: timeoutFirst=${timeoutFirst}`, async (t) => {
      clock(t); const parent = new AbortController();
      const { createOAuthJobDeadline, oauthAbortError } = await import("../lib/oauthJobDeadline.ts");
      const life = createOAuthJobDeadline(100, parent.signal);
      if (timeoutFirst) t.mock.timers.tick(100);
      parent.abort(); t.mock.timers.tick(100);
      expectCode(oauthAbortError(life.signal), timeoutFirst ? "OAUTH_IMAGE_TIMEOUT" : "GENERATION_CANCELED", timeoutFirst ? 504 : 499);
      life.dispose();
    });
  }

  test("classic execution never retries job deadline; node classifier preserves it", async (t) => {
    clock(t);
    const { prepareOpenaiExecution } = await import("../lib/providers/adapters/openaiExecution.ts");
    const { requireRuntimeContext } = await import("../lib/runtimeContext.ts");
    const { isNonRetryableGenerationError, normalizeGenerationFailure } = await import("../lib/generationErrors.ts");
    const entered = deferred<void>(); let calls = 0;
    upstream = async (path, init) => {
      assert.equal(path, "/v1/images/generations"); calls++; entered.resolve(); return held(init.signal);
    };
    const execution = await prepareOpenaiExecution(requireRuntimeContext({ ...base.ctx }), {
      surface: "classic", provider: "oauth", requestId: undefined, signal: new AbortController().signal,
      prompt: "fixture", rawPrompt: "fixture", references: [], providerUrl: null,
      background: null, backgroundConstraint: undefined, nai: {}, comfy: {},
      options: { model: "gpt-6-luna", quality: "high", size: "1024x1024", moderation: "low",
        mode: "direct", reasoningEffort: "low", webSearchEnabled: false },
    });
    const work = observe(execution.execute());
    await entered.promise; t.mock.timers.tick(100);
    const { error } = await work.outcome; expectCode(error);
    assert.ok(error instanceof Error);
    assert.equal(isNonRetryableGenerationError(error), true);
    expectCode(normalizeGenerationFailure(error));
    t.mock.timers.tick(1000); assert.equal(calls, 1);
  });

  test("OAuth deadline awaits already-entered image persistence callback", async (t) => {
    const timers = clock(t), entered = deferred<void>(), persist = deferred<void>();
    let writes = 0;
    upstream = async () => imagesJson("fixture");
    const work = observe(run({ ...base, mode: "direct", onFinalImage: async () => {
      entered.resolve(); await persist.promise; writes++;
    } }));
    await entered.promise; t.mock.timers.tick(100); await turn();
    try {
      assert.equal(work.settled(), false, "entered persistence must remain awaited");
      assert.equal(writes, 0);
    } finally {
      persist.resolve(); await work.outcome;
    }
    const result = await work.outcome;
    assert.equal(result.error, undefined); assert.equal(result.value?.images[0]?.b64, "fixture");
    assert.equal(writes, 1); assert.equal(timers.live.size, 0);
  });

  test("late noncooperative render after deadline never invokes image callback", async (t) => {
    const timers = clock(t), entered = deferred<void>(), response = deferred<Response>();
    let callbacks = 0;
    upstream = async () => { entered.resolve(); return response.promise; };
    const work = observe(run({ ...base, mode: "direct", onFinalImage: () => { callbacks++; } }));
    await entered.promise; t.mock.timers.tick(100); await turn();
    try {
      assert.equal(work.settled(), true, "deadline must settle before a late render completes");
      expectCode((await work.outcome).error);
    } finally {
      response.resolve(imagesJson("late-image")); await work.outcome; await turn();
    }
    assert.equal(callbacks, 0); assert.equal(timers.live.size, 0);
  });
}
