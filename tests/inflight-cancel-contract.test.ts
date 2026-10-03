import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectCallArguments } from "./_executionImportEdges.mjs";
import { readStoreBundle } from "./_storeBundle.mjs";

const root = process.cwd();

function readSource(path) {
  if (path === "ui/src/store/useAppStore.ts") return readStoreBundle();
  return readFileSync(join(root, path), "utf8");
}

test("inflight cancel is wired to AbortController, not just terminal bookkeeping", () => {
  const inflight = readSource("lib/inflight.ts");
  const health = readSource("routes/health.ts");
  const transport = readSource("lib/responsesTransport.ts");

  assert.match(inflight, /const abortControllers = new Map<string, AbortController>\(\)/);
  assert.match(inflight, /export function registerJobAbortController/);
  assert.match(inflight, /controller\.abort\(\)/);
  assert.match(health, /abortJob\(req\.params\.requestId\)/);
  assert.match(transport, /export interface PostResponsesArgs\s*\{[^}]*signal\?: AbortSignal \| null/);
  const owner = "lib/responsesTransport.ts";
  assert.deepEqual(collectCallArguments(transport, owner, "transportLifetime", "postResponses"), [["ctx", "provider", "signal"]]);
  const requests = collectCallArguments(transport, owner, "requestResponses", "postResponses");
  assert.equal(requests.length, 1);
  assert.match(requests[0][2], /signal:\s*lifetime\.signal/);
  const oauthLifetimes = collectCallArguments(transport, owner, "createOAuthRequestDeadline", "transportLifetime");
  assert.equal(oauthLifetimes.length, 1);
  assert.equal(oauthLifetimes[0][1], "parent");
  assert.deepEqual(collectCallArguments(transport, owner, "combineAbortSignals", "transportLifetime"), [["[controller.signal, parent]"]]);
  assert.match(transport, /code: "GENERATION_CANCELED"/);
});

test("classic and multimode routes register cancel controllers and block late saves", () => {
  const classic = (readSource("routes/generate.ts") + readSource("lib/generatePipeline.ts"));
  const multimode = (readSource("routes/multimode.ts") + readSource("lib/multimodePipeline.ts"));

  for (const source of [classic, multimode]) {
    assert.match(source, /registerJobAbortController\(requestId, cancelController\)/);
    assert.match(source, /signal: cancelController\.signal/);
    assert.match(source, /throwIfJobCanceled\(requestId\)/);
    assert.match(source, /canceled: finishCanceled/);
  }
});

test("UI exposes cancel buttons only through the store cancel action", () => {
  const list = readSource("ui/src/components/InFlightList.tsx");
  const store = readSource("ui/src/store/useAppStore.ts");

  assert.match(list, /className="in-flight-cancel"/);
  assert.match(list, /cancelInFlightJob\(f\.id\)/);
  assert.match(store, /cancelInFlightJob.*cancelInFlightJobImpl/);
  assert.match(store, /await cancelInflight\(requestId\)/);
  assert.match(store, /phase: "canceling"/);
});
