import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import {
  BADGE_POLL_MS, claimServerNotice, dismissUpdate, fetchUpdateBadge, viewFromBadge, viewFromDesktop,
  type DesktopUpdateState, type UpdateBadge,
} from "../ui/src/lib/updateStatus.ts";
import * as channel from "../ui/src/lib/eventChannel.ts";
import type { DesktopBridge } from "../ui/src/lib/desktopShell.ts";

const badge: UpdateBadge = {
  surface: "npm", enabled: true, currentVersion: "3.25.0", latestVersion: "3.26.0",
  available: true, dismissed: false, noticePending: false, stale: false, checkedAt: 100, tag: "latest",
  command: "ima2 update", releaseUrl: "https://github.com/lidge-ai/ima2-gen/releases/tag/v3.26.0",
};
const desktop: DesktopUpdateState = {
  active: true, currentVersion: "3.25.0", phase: "available", availableVersion: "3.26.0",
  progress: null, error: null, updatedTo: null, checkedAt: 100,
};
const hidden = { kind: "hidden" };
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
let moduleId = 0;
const freshStore = () => import(`../ui/src/lib/updateStore.ts?case=${++moduleId}`) as Promise<typeof import("../ui/src/lib/updateStore.ts")>;
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

function setBridge(bridge: DesktopBridge | undefined): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: Object.assign(new EventTarget(), { ima2Desktop: bridge, location: { href: "http://localhost:9999", origin: "http://localhost:9999" } }),
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

class HintSource extends EventTarget {
  static CLOSED = 2;
  static instances: HintSource[] = [];
  readyState = 0;
  constructor(readonly url: string) { super(); HintSource.instances.push(this); }
  close() { this.readyState = HintSource.CLOSED; }
  emit(value: unknown) { this.raw(JSON.stringify(value)); }
  raw(data: string, lastEventId = "") { this.dispatchEvent(new MessageEvent("update", { data, lastEventId })); }
}

function browserHints(context: TestContext): HintSource {
  const restoreWindow = setBridge(undefined);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  HintSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: HintSource });
  channel.ensureConnected();
  context.after(() => {
    channel.disconnect();
    restoreWindow();
    if (previous) Object.defineProperty(globalThis, "EventSource", previous);
    else Reflect.deleteProperty(globalThis, "EventSource");
  });
  return HintSource.instances[0];
}

describe("update view contract", () => {
  it("hides null, disabled, desktop, and unavailable npm badges", () => {
    for (const input of [null, { ...badge, enabled: false }, { ...badge, surface: "desktop" as const },
      { ...badge, available: false }, { ...badge, latestVersion: null }]) {
      assert.deepEqual(viewFromBadge(input), hidden);
    }
  });
  it("preserves the npm command, release URL and preview channel command", () => {
    assert.deepEqual(viewFromBadge(badge), {
      kind: "npm", version: "3.26.0", command: "ima2 update", releaseUrl: badge.releaseUrl,
    });
    assert.deepEqual(viewFromBadge({ ...badge, tag: "preview", command: "ima2 update --tag preview" }), {
      kind: "npm", version: "3.26.0", command: "ima2 update --tag preview", releaseUrl: badge.releaseUrl,
    });
  });
  it("hides inactive and non-pending desktop states", () => {
    assert.deepEqual(viewFromDesktop(null), hidden);
    assert.deepEqual(viewFromDesktop({ ...desktop, active: false }), hidden);
    for (const phase of ["unsupported", "idle", "current", "checking", "installing"] as const) {
      assert.deepEqual(viewFromDesktop({ ...desktop, phase }), hidden);
    }
  });
  for (const phase of ["available", "downloading", "downloaded", "error"] as const) {
    it(`shows desktop ${phase} with the version and progress`, () => {
      assert.deepEqual(viewFromDesktop({ ...desktop, phase, progress: 42 }), {
        kind: "desktop", version: "3.26.0", phase, progress: 42,
      });
    });
  }
  it("requires a version for retry", () => {
    assert.deepEqual(viewFromDesktop({ ...desktop, phase: "error", availableVersion: null }), hidden);
  });
});

describe("update transport and singleton", () => {
  it("uses the server JSON routes and dismissal body", async (context) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    context.mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(Response.json(url.endsWith("notice") ? { updatedTo: "3.26.0" } : badge));
    });
    assert.deepEqual(await fetchUpdateBadge(), badge);
    await dismissUpdate("3.26.0");
    assert.equal(await claimServerNotice(), "3.26.0");
    assert.deepEqual(calls, [
      { url: "/api/update/badge", init: undefined },
      { url: "/api/update/dismiss", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"version":"3.26.0"}' } },
      { url: "/api/update/notice", init: { method: "POST" } },
    ]);
  });
  it("shares one browser poll, keeps the last view on failure and stops after the last subscriber", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const clearPoll = context.mock.method(globalThis, "clearInterval");
    let requests = 0;
    let fails = false;
    context.mock.method(globalThis, "fetch", () => {
      requests++;
      return fails ? Promise.reject(Object.assign(new Error("LAN auth"), { status: 401 })) : Promise.resolve(Response.json(badge));
    });
    const store = await freshStore();
    const first = store.subscribe(() => {});
    const second = store.subscribe(() => {});
    context.after(() => { first(); second(); });
    await drain();
    assert.equal(requests, 0);
    assert.deepEqual(store.getSnapshot(), hidden);
    context.mock.timers.tick(3 * 60 * 60_000);
    await drain();
    assert.equal(requests, 0);
    hints.emit(badge);
    assert.equal(requests, 0);
    assert.deepEqual(store.getSnapshot(), viewFromBadge(badge));
    context.mock.timers.tick(BADGE_POLL_MS - 1);
    await drain();
    assert.equal(requests, 0);
    hints.emit(badge);
    context.mock.timers.tick(1);
    await drain();
    assert.equal(requests, 1);
    fails = true;
    context.mock.timers.tick(BADGE_POLL_MS - 1);
    await drain();
    assert.equal(requests, 1);
    context.mock.timers.tick(1);
    await drain();
    assert.equal(requests, 2);
    assert.deepEqual(store.getSnapshot(), viewFromBadge(badge));
    first();
    assert.equal(clearPoll.mock.callCount(), 0);
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.equal(requests, 3);
    second();
    assert.equal(clearPoll.mock.callCount(), 1);
    hints.emit({ ...badge, latestVersion: "3.27.0" });
    assert.deepEqual(store.getSnapshot(), viewFromBadge(badge));
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.equal(requests, 3);
  });
  it("uses one desktop subscription, no HTTP, and ignores an older initial snapshot", async (context) => {
    let deliver: (state: DesktopUpdateState) => void = () => {};
    let resolveInitial: (state: DesktopUpdateState) => void = () => {};
    let reads = 0, subscriptions = 0, cleanups = 0, downloads = 0, installs = 0, claims = 0;
    context.after(setBridge({
      getUpdateState: () => { reads++; return new Promise((resolve) => { resolveInitial = resolve; }); },
      onUpdateState: (callback) => { subscriptions++; deliver = callback; return () => { cleanups++; }; },
      downloadUpdate: () => { downloads++; return Promise.resolve(true); },
      installUpdate: () => { installs++; return Promise.resolve(true); },
      claimUpdateNotice: () => { claims++; return Promise.resolve("3.26.0"); },
    }));
    const http = context.mock.method(globalThis, "fetch", () => { throw new Error("Desktop must not fetch HTTP"); });
    const store = await freshStore();
    const first = store.subscribe(() => {}), second = store.subscribe(() => {});
    context.after(() => { first(); second(); });
    deliver(desktop);
    resolveInitial({ ...desktop, phase: "idle" });
    await drain();
    assert.deepEqual(store.getSnapshot(), viewFromDesktop(desktop));
    await store.download();
    await store.install();
    assert.equal(downloads, 1);
    assert.equal(installs, 0);
    deliver({ ...desktop, phase: "downloading", progress: 42 });
    await store.download();
    assert.equal(downloads, 1);
    deliver({ ...desktop, phase: "downloaded", progress: 100 });
    await store.install();
    assert.equal(installs, 1);
    assert.deepEqual(await Promise.all([store.claimUpdateNotice(), store.claimUpdateNotice()]), ["3.26.0", "3.26.0"]);
    assert.equal(claims, 1);
    assert.equal(reads, 1);
    assert.equal(subscriptions, 1);
    assert.equal(http.mock.callCount(), 0);
    first();
    assert.equal(cleanups, 0);
    second();
    assert.equal(cleanups, 1);
  });
  it("hides a successful dismissal and prevents a stale poll from reviving it", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    context.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json(badge)));
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    context.after(unsubscribe);
    hints.emit(badge);
    await drain();
    await store.dismiss();
    assert.deepEqual(store.getSnapshot(), hidden);
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.deepEqual(store.getSnapshot(), hidden);
  });
  it("keeps a newer badge visible when an earlier dismissal resolves", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let latest = badge;
    let finishDismiss: (response: Response) => void = () => {};
    context.mock.method(globalThis, "fetch", (url: string) => url.endsWith("dismiss")
      ? new Promise<Response>((resolve) => { finishDismiss = resolve; }) : Promise.resolve(Response.json(latest)));
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    context.after(unsubscribe);
    hints.emit(badge);
    await drain();
    const pending = store.dismiss();
    latest = { ...badge, latestVersion: "3.27.0" };
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    finishDismiss(Response.json(badge));
    await pending;
    assert.deepEqual(store.getSnapshot(), viewFromBadge(latest));
  });
  it("ignores a response from a stopped browser poller", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let finish: (response: Response) => void = () => {};
    context.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    hints.emit(badge);
    context.mock.timers.tick(BADGE_POLL_MS);
    unsubscribe();
    finish(Response.json({ ...badge, latestVersion: "3.27.0", noticePending: true }));
    await drain();
    assert.deepEqual(store.getSnapshot(), viewFromBadge(badge));
  });
  it("removes the hint listener when stopped before any hint", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const http = context.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json(badge)));
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    hints.emit({ ...badge, noticePending: true });
    context.mock.timers.tick(3 * 60 * 60_000);
    await drain();
    assert.equal(http.mock.callCount(), 0);
    assert.deepEqual(store.getSnapshot(), hidden);
  });
  it("waits for a pending badge and coalesces browser notice claims once per page", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let latest = badge;
    const calls: { url: string; method?: string }[] = [];
    context.mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return Promise.resolve(Response.json(url.endsWith("notice") ? { updatedTo: "3.26.0" } : latest));
    });
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    context.after(unsubscribe);
    const first = store.claimUpdateNotice(), second = store.claimUpdateNotice();
    assert.equal(first, second);
    let resolved = false;
    void first.then(() => { resolved = true; });
    await drain();
    assert.deepEqual(calls, []);
    assert.equal(resolved, false);
    hints.emit(badge);
    await drain();
    assert.deepEqual(calls, []);
    assert.equal(resolved, false);
    latest = { ...badge, noticePending: true };
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.deepEqual(await Promise.all([first, second]), ["3.26.0", "3.26.0"]);
    assert.deepEqual(calls, [
      { url: "/api/update/badge", method: undefined },
      { url: "/api/update/notice", method: "POST" },
    ]);
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.equal(await store.claimUpdateNotice(), "3.26.0");
    assert.equal(calls.filter((call) => call.url.endsWith("notice")).length, 1);
  });
  for (const claimBeforeHint of [true, false]) {
    it(`claims once from a pending hint with the claim ${claimBeforeHint ? "before" : "after"} the hint`, async (context) => {
      const hints = browserHints(context);
      context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
      const http = context.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ updatedTo: "3.26.0" })));
      const store = await freshStore();
      const unsubscribe = store.subscribe(() => {});
      context.after(unsubscribe);
      const early = claimBeforeHint ? store.claimUpdateNotice() : null;
      await drain();
      assert.equal(http.mock.callCount(), 0);
      hints.emit({ ...badge, noticePending: true });
      const claim = early ?? store.claimUpdateNotice();
      assert.equal(await claim, "3.26.0");
      hints.emit({ ...badge, noticePending: true });
      assert.equal(await store.claimUpdateNotice(), "3.26.0");
      assert.equal(http.mock.callCount(), 1);
      assert.equal(http.mock.calls[0].arguments[0], "/api/update/notice");
    });
  }
  it("never claims a notice from an older badge without noticePending", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const legacyBadge: Partial<UpdateBadge> = { ...badge };
    delete legacyBadge.noticePending;
    const http = context.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json(legacyBadge)));
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    context.after(unsubscribe);
    let resolved = false;
    void store.claimUpdateNotice().then(() => { resolved = true; });
    await drain();
    assert.equal(http.mock.callCount(), 0);
    hints.emit(legacyBadge);
    assert.deepEqual(store.getSnapshot(), viewFromBadge(badge));
    assert.equal(http.mock.callCount(), 0);
    for (const tick of [BADGE_POLL_MS, BADGE_POLL_MS, BADGE_POLL_MS]) {
      context.mock.timers.tick(tick);
      await drain();
    }
    assert.equal(http.mock.callCount(), 3);
    assert.ok(http.mock.calls.every((call) => call.arguments[0] === "/api/update/badge"));
    assert.equal(resolved, false);
    assert.deepEqual(store.getSnapshot(), viewFromBadge(badge));
  });
  it("returns null on a notice LAN 401 without retrying the claim", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let posts = 0;
    context.mock.method(globalThis, "fetch", (url: string) => {
      if (url.endsWith("notice")) {
        posts++;
        return Promise.resolve(Response.json({ error: "LAN auth" }, { status: 401 }));
      }
      return Promise.resolve(Response.json({ ...badge, noticePending: true }));
    });
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    context.after(unsubscribe);
    const first = store.claimUpdateNotice(), second = store.claimUpdateNotice();
    await drain();
    assert.equal(posts, 0);
    hints.emit({ ...badge, noticePending: true });
    await drain();
    assert.deepEqual(await Promise.all([first, second]), [null, null]);
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.equal(await store.claimUpdateNotice(), null);
    assert.equal(posts, 1);
  });
});

describe("update hint channel", () => {
  it("delivers only object hints to listeners, preserves them on disconnect and leaves job cursors alone", (context) => {
    const old = browserHints(context);
    const received: unknown[] = [], jobs: string[] = [];
    const offHint = channel.onUpdateHint((value) => received.push(value));
    const offSecond = channel.onUpdateHint((value) => received.push(value));
    context.after(() => { offHint(); offSecond(); });
    channel.subscribe("job", null, (event) => jobs.push(event));
    old.raw(JSON.stringify({ ...badge, jobId: "job" }), "hint-id");
    assert.equal(received.length, 2);
    assert.deepEqual(jobs, []);
    for (const invalid of ["{", "null", "[]", "true", "1", '\"text\"']) old.raw(invalid);
    old.dispatchEvent(new Event("update"));
    assert.equal(received.length, 2);
    old.readyState = HintSource.CLOSED;
    channel.ensureConnected();
    const replacement = HintSource.instances.at(-1)!;
    assert.equal(replacement.url, "/api/events");
    old.emit(badge);
    assert.equal(received.length, 2);
    channel.disconnect();
    channel.ensureConnected();
    HintSource.instances.at(-1)!.emit(badge);
    assert.equal(received.length, 4);
    offHint(); offSecond();
    HintSource.instances.at(-1)!.emit(badge);
    assert.equal(received.length, 4);
    assert.deepEqual(jobs, []);
  });
  it("ignores malformed badge hints without starting HTTP polling", async (context) => {
    const hints = browserHints(context);
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const http = context.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected HTTP"); });
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    context.after(unsubscribe);
    for (const value of [{}, { ...badge, surface: "desktop" }, { ...badge, available: "true" },
      { ...badge, latestVersion: 123 }, { ...badge, noticePending: "true" }]) hints.emit(value);
    context.mock.timers.tick(3 * 60 * 60_000);
    await drain();
    assert.equal(http.mock.callCount(), 0);
    assert.deepEqual(store.getSnapshot(), hidden);
  });
});

describe("update UI mounting and translations", () => {
  it("mounts the strip indicator and unconditional notice host with the stylesheet", () => {
    assert.match(source("ui/src/components/SidebarTopStrip.tsx"), /<UpdateIndicator variant="strip"/);
    assert.match(source("ui/src/App.tsx"), /<Toast \/>\s*<UpdateNoticeHost \/>/);
    assert.match(source("ui/src/App.tsx"), /import "\.\/styles\/update-indicator\.css"/);
    assert.match(source("ui/src/hooks/useUpdateStatus.ts"), /useSyncExternalStore\(subscribe, getSnapshot, getServerSnapshot\)/);
    assert.match(source("ui/src/components/UpdateNoticeHost.tsx"), /isMobile && !settingsOpen \? <UpdateIndicator variant="floating"/);
  });
  it("defines identical update keys and interpolation fields in every locale", () => {
    const expected = ["available", "download", "downloading", "ready", "retry", "popoverTitle", "runCommand", "copy", "copied", "whatsNew", "dismiss", "updatedTo"];
    for (const locale of ["en", "ko", "zh-Hans", "zh-Hant"]) {
      const dictionary = JSON.parse(source(`ui/src/i18n/${locale}.json`)) as { update: Record<string, string> };
      assert.deepEqual(Object.keys(dictionary.update).sort(), [...expected].sort());
      for (const key of expected) {
        assert.ok(dictionary.update[key].trim());
        const fields = [...dictionary.update[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        const versioned = ["available", "download", "downloading", "ready", "retry", "popoverTitle", "updatedTo"].includes(key);
        assert.deepEqual(fields, key === "downloading" ? ["progress", "version"] : versioned ? ["version"] : []);
      }
    }
  });
});
