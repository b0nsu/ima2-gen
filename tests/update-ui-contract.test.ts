import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BADGE_POLL_MS, claimServerNotice, dismissUpdate, fetchUpdateBadge, viewFromBadge, viewFromDesktop,
  type DesktopUpdateState, type UpdateBadge,
} from "../ui/src/lib/updateStatus.ts";
import type { DesktopBridge } from "../ui/src/lib/desktopShell.ts";

const badge: UpdateBadge = {
  surface: "npm", enabled: true, currentVersion: "3.25.0", latestVersion: "3.26.0",
  available: true, dismissed: false, stale: false, checkedAt: 100, tag: "latest",
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
    configurable: true, value: { ima2Desktop: bridge, location: { href: "http://localhost:9999", origin: "http://localhost:9999" } },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
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
    context.after(setBridge(undefined));
    context.mock.timers.enable({ apis: ["setInterval"] });
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
    assert.equal(requests, 1);
    assert.deepEqual(store.getSnapshot(), viewFromBadge(badge));
    fails = true;
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.equal(requests, 2);
    assert.deepEqual(store.getSnapshot(), viewFromBadge(badge));
    first();
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.equal(requests, 3);
    second();
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
    context.after(setBridge(undefined));
    context.mock.timers.enable({ apis: ["setInterval"] });
    context.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json(badge)));
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    context.after(unsubscribe);
    await drain();
    await store.dismiss();
    assert.deepEqual(store.getSnapshot(), hidden);
    context.mock.timers.tick(BADGE_POLL_MS);
    await drain();
    assert.deepEqual(store.getSnapshot(), hidden);
  });
  it("keeps a newer badge visible when an earlier dismissal resolves", async (context) => {
    context.after(setBridge(undefined));
    context.mock.timers.enable({ apis: ["setInterval"] });
    let latest = badge;
    let finishDismiss: (response: Response) => void = () => {};
    context.mock.method(globalThis, "fetch", (url: string) => url.endsWith("dismiss")
      ? new Promise<Response>((resolve) => { finishDismiss = resolve; }) : Promise.resolve(Response.json(latest)));
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    context.after(unsubscribe);
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
    context.after(setBridge(undefined));
    let finish: (response: Response) => void = () => {};
    context.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    const store = await freshStore();
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    finish(Response.json(badge));
    await drain();
    assert.deepEqual(store.getSnapshot(), hidden);
  });
  it("coalesces browser notice claims and returns null on a LAN 401", async (context) => {
    context.after(setBridge(undefined));
    const http = context.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ updatedTo: "3.26.0" })));
    const store = await freshStore();
    assert.deepEqual(await Promise.all([store.claimUpdateNotice(), store.claimUpdateNotice()]), ["3.26.0", "3.26.0"]);
    assert.equal(http.mock.callCount(), 1);
    context.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ error: "LAN auth" }, { status: 401 })));
    const lockedStore = await freshStore();
    assert.equal(await lockedStore.claimUpdateNotice(), null);
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
