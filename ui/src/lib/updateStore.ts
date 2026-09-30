import { desktopBridge } from "./desktopShell";
import {
  BADGE_POLL_MS, UPDATE_FIRST_FETCH_MS, claimServerNotice, dismissUpdate, fetchUpdateBadge, viewFromBadge, viewFromDesktop,
  type UpdateView,
} from "./updateStatus";

const hidden: UpdateView = { kind: "hidden" };
const listeners = new Set<() => void>();
let view: UpdateView = hidden;
let stop: (() => void) | null = null;
let dismissedVersion: string | null = null;
let noticeClaim: Promise<string | null> | null = null;
let noticePending = false;
let releaseNoticeWait: (() => void) | null = null;

function publish(next: UpdateView): void {
  view = next.kind === "npm" && next.version === dismissedVersion ? hidden : next;
  for (const listener of listeners) listener();
}

function startDesktop(): () => void {
  const bridge = desktopBridge();
  let alive = true;
  let revision = 0;
  const unsubscribe = bridge?.onUpdateState?.((state) => {
    if (!alive) return;
    revision++;
    publish(viewFromDesktop(state));
  });
  void bridge?.getUpdateState?.().then((state) => {
    if (alive && revision === 0) publish(viewFromDesktop(state));
  }).catch(() => { /* Keep the last view when the bridge is unavailable. */ });
  return () => { alive = false; unsubscribe?.(); };
}

function startBrowser(): () => void {
  let alive = true;
  let fetching = false;
  const poll = async () => {
    if (!alive || fetching) return;
    fetching = true;
    try {
      const badge = await fetchUpdateBadge();
      if (alive) {
        publish(viewFromBadge(badge));
        if (badge.noticePending === true) {
          noticePending = true;
          releaseNoticeWait?.();
          releaseNoticeWait = null;
        }
      }
    } catch { /* Offline and LAN authentication failures keep the last view. */ }
    finally { fetching = false; }
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  const timeout = setTimeout(() => {
    void poll();
    interval = setInterval(() => { void poll(); }, BADGE_POLL_MS);
  }, UPDATE_FIRST_FETCH_MS);
  return () => {
    alive = false;
    clearTimeout(timeout);
    if (interval !== null) clearInterval(interval);
  };
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) stop = desktopBridge()?.getUpdateState ? startDesktop() : startBrowser();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { stop?.(); stop = null; }
  };
}

export function getSnapshot(): UpdateView { return view; }
export function getServerSnapshot(): UpdateView { return hidden; }

export async function dismiss(): Promise<void> {
  if (view.kind !== "npm") return;
  const version = view.version;
  try {
    await dismissUpdate(version);
    dismissedVersion = version;
    if (view.kind === "npm" && view.version === version) publish(hidden);
  } catch (error) { console.warn("[update] dismissal failed", error); }
}

export async function download(): Promise<void> {
  if (view.kind !== "desktop" || (view.phase !== "available" && view.phase !== "error")) return;
  try { await desktopBridge()?.downloadUpdate?.(); }
  catch (error) { console.warn("[update] download failed", error); }
}

export async function install(): Promise<void> {
  if (view.kind !== "desktop" || view.phase !== "downloaded") return;
  try { await desktopBridge()?.installUpdate?.(); }
  catch (error) { console.warn("[update] install failed", error); }
}

/** Coalesce StrictMode remounts and never claim a second notice in this page. */
export function claimUpdateNotice(): Promise<string | null> {
  noticeClaim ??= (async () => {
    try {
      const bridge = desktopBridge();
      if (bridge?.getUpdateState) return await bridge.claimUpdateNotice?.() ?? null;
      if (!noticePending) await new Promise<void>((resolve) => { releaseNoticeWait = resolve; });
      return await claimServerNotice();
    } catch { return null; /* A LAN 401 or unavailable bridge must not disrupt the UI. */ }
  })();
  return noticeClaim;
}
