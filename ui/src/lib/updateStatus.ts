import { jsonFetch } from "./api-core";

/** Browser mirror of the server badge contract; never imports server modules. */
export interface UpdateBadge {
  surface: "npm" | "desktop";
  enabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  dismissed: boolean;
  noticePending: boolean;
  stale: boolean;
  checkedAt: number | null;
  tag: "latest" | "preview";
  command: string;
  releaseUrl: string | null;
}

export interface DesktopUpdateState {
  active: boolean;
  currentVersion: string;
  phase: "unsupported" | "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "error";
  availableVersion: string | null;
  progress: number | null;
  error: string | null;
  updatedTo: string | null;
  checkedAt: number | null;
}

export type UpdateView =
  | { kind: "hidden" }
  | { kind: "npm"; version: string; command: string; releaseUrl: string | null }
  | { kind: "desktop"; version: string; phase: "available" | "downloading" | "downloaded" | "error"; progress: number | null };

export const BADGE_POLL_MS = 10 * 60_000;

export function viewFromBadge(badge: UpdateBadge | null): UpdateView {
  if (!badge || badge.surface !== "npm" || !badge.enabled || !badge.available || !badge.latestVersion) {
    return { kind: "hidden" };
  }
  return { kind: "npm", version: badge.latestVersion, command: badge.command, releaseUrl: badge.releaseUrl };
}

export function viewFromDesktop(state: DesktopUpdateState | null): UpdateView {
  if (!state?.active || !state.availableVersion) return { kind: "hidden" };
  const { phase } = state;
  if (phase !== "available" && phase !== "downloading" && phase !== "downloaded" && phase !== "error") {
    return { kind: "hidden" };
  }
  return { kind: "desktop", version: state.availableVersion, phase, progress: state.progress };
}

export function fetchUpdateBadge(): Promise<UpdateBadge> {
  return jsonFetch<UpdateBadge>("/api/update/badge");
}

export async function dismissUpdate(version: string): Promise<void> {
  await jsonFetch<UpdateBadge>("/api/update/dismiss", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }),
  });
}

export async function claimServerNotice(): Promise<string | null> {
  const notice = await jsonFetch<{ updatedTo: string | null }>("/api/update/notice", { method: "POST" });
  return notice.updatedTo;
}
