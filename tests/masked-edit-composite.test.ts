import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import sharp from "sharp";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = await mkdtemp(join(tmpdir(), "ima2-masked-edit-"));
process.env.IMA2_CONFIG_DIR = TEST_DIR;
process.env.IMA2_DB_PATH = join(TEST_DIR, "sessions.db");

const { config } = await import("../config.js");
const { preserveOutsideMask, MASKED_EDIT_MAX_PIXELS } = await import("../lib/maskedEditComposite.ts");
const { registerEditRoutes } = await import("../routes/edit.ts");
const { _resetForTest: resetEventBus } = await import("../lib/eventBus.js");
const { _resetForTests: resetInflight } = await import("../lib/inflight.js");
const db = await import("../lib/db.js");
const { configureLogger } = await import("../lib/logger.ts");
configureLogger({ level: "silent" });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetEventBus();
  resetInflight();
});

after(async () => {
  db.closeDb();
  await rm(TEST_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const W = 8;
const H = 8;

/** Deterministic noisy RGB image, so any resampling of the kept area would show. */
async function noisyPng(width: number, height: number, seed: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let state = seed;
  for (let i = 0; i < raw.length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = state & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** OpenAI mask contract: opaque = keep, alpha 0 = editable. Left half is editable. */
async function leftHalfEditableMask(editAlpha = 0): Promise<Buffer> {
  const raw = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      raw[(y * W + x) * 4 + 3] = x < W / 2 ? editAlpha : 255;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function rgba(buffer: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function pixel(data: Buffer, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

async function assertComposite(out: Buffer, source: Buffer, resultAtSourceSize: Buffer): Promise<void> {
  const got = await rgba(out);
  const src = await rgba(source);
  const res = await rgba(resultAtSourceSize);
  assert.equal(got.width, W);
  assert.equal(got.height, H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const expected = x < W / 2 ? pixel(res.data, W, x, y) : pixel(src.data, W, x, y);
      assert.deepEqual(pixel(got.data, W, x, y), expected, `pixel ${x},${y}`);
    }
  }
}

describe("preserveOutsideMask", () => {
  it("keeps opaque-mask pixels identical to the source and editable pixels from the result", async () => {
    const source = await noisyPng(W, H, 1);
    const result = await noisyPng(W, H, 2);
    const out = await preserveOutsideMask({ source, result, mask: await leftHalfEditableMask() });
    await assertComposite(out, source, result);
    assert.equal((await sharp(out).metadata()).channels, 3, "an opaque RGB result stays RGB");
  });

  it("resizes a differently sized result to the source before compositing", async () => {
    const source = await noisyPng(W, H, 3);
    const result = await noisyPng(20, 14, 4);
    const out = await preserveOutsideMask({ source, result, mask: await leftHalfEditableMask() });
    const resized = await sharp(result).resize(W, H, { fit: "fill" }).png().toBuffer();
    await assertComposite(out, source, resized);
  });

  it("blends partial mask alpha instead of cutting a hard edge", async () => {
    const source = await sharp({ create: { width: W, height: H, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const result = await sharp({ create: { width: W, height: H, channels: 3, background: "#0000ff" } }).png().toBuffer();
    const out = await preserveOutsideMask({ source, result, mask: await leftHalfEditableMask(128) });
    const got = await rgba(out);
    const [r, g, b, a] = pixel(got.data, W, 0, 0);
    assert.ok(Math.abs(r! - 128) <= 2 && g === 0 && Math.abs(b! - 127) <= 2 && a === 255, `blend ${r},${g},${b},${a}`);
    assert.deepEqual(pixel(got.data, W, W - 1, 0), [255, 0, 0, 255]);
  });

  it("keeps a transparent source pixel transparent in the kept area", async () => {
    const raw = Buffer.alloc(W * H * 4, 255);
    raw[(0 * W + (W - 1)) * 4 + 3] = 0;
    const source = await sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
    const result = await sharp({ create: { width: W, height: H, channels: 3, background: "#0000ff" } }).png().toBuffer();
    const out = await preserveOutsideMask({ source, result, mask: await leftHalfEditableMask() });
    const got = await rgba(out);
    assert.equal(pixel(got.data, W, W - 1, 0)[3], 0, "kept transparent pixel");
    assert.deepEqual(pixel(got.data, W, 0, 0), [0, 0, 255, 255], "edited pixel comes from the result");
    assert.equal((await sharp(out).metadata()).channels, 4);
  });

  it("refuses a source above the composite pixel limit", async () => {
    assert.equal(MASKED_EDIT_MAX_PIXELS, 4096 * 4096);
    const source = await sharp({ create: { width: 4097, height: 4096, channels: 3, background: "#000" } }).png().toBuffer();
    const result = await noisyPng(W, H, 13);
    await assert.rejects(
      preserveOutsideMask({ source, result, mask: await leftHalfEditableMask() }),
      /pixel limit/,
    );
  });

  it("runs composites one at a time without dropping one after a failure", async () => {
    const mask = await leftHalfEditableMask();
    const jobs = [
      preserveOutsideMask({ source: await noisyPng(W, H, 14), result: await noisyPng(W, H, 15), mask }),
      preserveOutsideMask({ source: await noisyPng(W, H, 16), result: await noisyPng(W, H, 17), mask: mask.subarray(0, 33) }),
      preserveOutsideMask({ source: await noisyPng(W, H, 18), result: await noisyPng(W, H, 19), mask }),
    ];
    const settled = await Promise.allSettled(jobs);
    assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "rejected", "fulfilled"]);
  });
});

function sseResponse(b64: string): Response {
  const events = [
    { type: "response.output_item.done", item: { type: "image_generation_call", result: b64, revised_prompt: "r" } },
    { type: "response.completed", response: { usage: { total_tokens: 3 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

async function editOnce(body: Record<string, unknown>, resultB64: string, features = config.features) {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, init);
    return sseResponse(resultB64);
  };
  const rootDir = await mkdtemp(join(TEST_DIR, "app-"));
  const generatedDir = join(rootDir, "generated");
  const app = express();
  app.use(express.json({ limit: "12mb" }));
  registerEditRoutes(app, {
    rootDir, apiKey: "sk-test", packageVersion: "test",
    config: { ...config, features, storage: { ...config.storage, generatedDir }, log: { ...config.log, level: "silent" } },
  } as never);
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const { port } = server.address() as import("node:net").AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "paint it", provider: "api", ...body }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const json = await res.json() as { image: string };
    const [file] = (await readdir(generatedDir)).filter((n) => !n.endsWith(".json") && !n.includes("thumb"));
    assert.ok(file);
    return {
      saved: await readFile(join(generatedDir, file)),
      meta: JSON.parse(await readFile(join(generatedDir, `${file}.json`), "utf8")) as Record<string, unknown>,
      responseImage: Buffer.from(json.image.replace(/^data:image\/png;base64,/, ""), "base64"),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("edit route mask preservation", () => {
  it("saves and returns the composited image and records maskOutsidePreserved", async () => {
    const source = await noisyPng(W, H, 5);
    const result = await noisyPng(12, 12, 6);
    const mask = await leftHalfEditableMask();
    const { saved, meta, responseImage } = await editOnce({
      requestId: "mask_keep_1", image: source.toString("base64"), mask: mask.toString("base64"),
    }, result.toString("base64"));
    await assertComposite(saved, source, await sharp(result).resize(W, H, { fit: "fill" }).png().toBuffer());
    assert.ok(responseImage.equals(saved));
    assert.equal(meta.maskOutsidePreserved, true);
  });

  it("stores the provider bytes unchanged when no mask is sent", async () => {
    const result = await noisyPng(12, 12, 7);
    const { saved, meta } = await editOnce({
      requestId: "mask_none_1", image: (await noisyPng(W, H, 8)).toString("base64"),
    }, result.toString("base64"));
    assert.ok(saved.equals(result));
    assert.equal("maskOutsidePreserved" in meta, false);
  });

  it("stores the provider bytes unchanged when features.preserveOutsideMask is off", async () => {
    const result = await noisyPng(W, H, 9);
    const { saved, meta } = await editOnce({
      requestId: "mask_off_1", image: (await noisyPng(W, H, 10)).toString("base64"),
      mask: (await leftHalfEditableMask()).toString("base64"),
    }, result.toString("base64"), { ...config.features, preserveOutsideMask: false });
    assert.ok(saved.equals(result));
    assert.equal("maskOutsidePreserved" in meta, false);
  });

  it("falls back to the provider bytes when the composite fails", async () => {
    const result = await noisyPng(W, H, 11);
    // Signature + IHDR only: passes the header check but sharp cannot decode it.
    const truncatedMask = (await leftHalfEditableMask()).subarray(0, 33);
    const warnings: string[] = [];
    configureLogger({ level: "warn", sink: { warn: (line: string) => warnings.push(line), error: () => {} } });
    let outcome;
    try {
      outcome = await editOnce({
        requestId: "mask_fail_1", image: (await noisyPng(W, H, 12)).toString("base64"),
        mask: truncatedMask.toString("base64"),
      }, result.toString("base64"));
    } finally {
      configureLogger({ level: "silent" });
    }
    const { saved, meta, responseImage } = outcome;
    const failures = warnings.filter((line) => line.includes("mask_preserve_failed"));
    assert.equal(failures.length, 1, warnings.join("\n"));
    assert.ok(!failures[0]!.includes(result.toString("base64").slice(0, 32)));
    assert.ok(saved.equals(result));
    assert.ok(responseImage.equals(result));
    assert.equal("maskOutsidePreserved" in meta, false);
  });
});
