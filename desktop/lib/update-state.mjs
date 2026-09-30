import { compareVersions } from "./update-receipt.mjs";

export const UPDATE_PHASES = ["unsupported", "idle", "checking", "current", "available", "downloading", "downloaded", "installing", "error"];
const STICKY_PHASES = ["downloading", "downloaded", "installing"];

export function initialUpdateState({ active, currentVersion }) {
  return {
    active, currentVersion, phase: active ? "idle" : "unsupported",
    availableVersion: null, progress: null, error: null, updatedTo: null, checkedAt: null,
  };
}

export function reduceUpdateState(state, event) {
  if (STICKY_PHASES.includes(state.phase) && ["checking", "not-available", "available"].includes(event.type)) {
    if (event.type !== "available" || compareVersions(event.version, state.availableVersion) <= 0) return state;
  }
  if (!state.active && !["updated", "notice-claimed"].includes(event.type)) return state;
  switch (event.type) {
    case "checking": return { ...state, phase: "checking", error: null };
    case "not-available": return { ...state, phase: "current", checkedAt: event.at, availableVersion: null, progress: null, error: null };
    case "available": return { ...state, phase: "available", availableVersion: event.version, progress: null, error: null };
    case "progress": return { ...state, phase: "downloading", progress: Math.round(Math.min(100, Math.max(0, Number(event.percent) || 0))), error: null };
    case "downloaded": return { ...state, phase: "downloaded", availableVersion: event.version, progress: 100, error: null };
    case "installing": return { ...state, phase: "installing", error: null };
    case "install-cancelled": return { ...state, phase: "downloaded" };
    case "error": return { ...state, phase: "error", error: event.message };
    case "updated": return { ...state, updatedTo: event.version };
    case "notice-claimed": return { ...state, updatedTo: null };
    default: return state;
  }
}

export function updatePending(state) {
  return ["available", "downloading", "downloaded"].includes(state.phase);
}

export function trayUpdateItem(state) {
  const v = state.availableVersion;
  const item = (label, action = null) => ({ label, enabled: action !== null, action });
  switch (state.phase) {
    case "unsupported": return null;
    case "checking": return item("Checking for Updates…");
    case "current": return item(`Up to date (v${state.currentVersion})`, "check");
    case "available": return item(`Download Update v${v}`, "download");
    case "downloading": return item(`Downloading Update v${v}… ${state.progress ?? 0}%`);
    case "downloaded": return item(`Restart to Update (v${v})`, "install");
    case "installing": return item(`Installing Update v${v}…`);
    case "error": if (v) return item(`Retry Update v${v}`, "download"); break;
  }
  return item("Check for Updates…", "check");
}

export function tooltipSuffix(state) {
  if (state.phase === "downloaded") return ` — Update v${state.availableVersion} ready`;
  if (["available", "downloading"].includes(state.phase)) return ` — Update v${state.availableVersion} available`;
  return "";
}
