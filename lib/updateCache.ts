import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { errInfo } from "./errInfo.js";
import { compareVersions, isNewer, isUpdateTag, parseVersion, releaseUrl, type UpdateTag } from "./updateVersion.js";

export interface VersionCache {
  latest_version: string | null;
  last_checked_at: number | null;
  dismissed_version: string | null;
  tag: UpdateTag | null;
  last_seen_version: string | null;
}

export function versionCachePath(configDir = config.storage.configDir): string {
  return join(configDir, "version.json");
}

function readObject(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {}; // Missing or corrupt update state has the same empty read view.
  }
}

function highestSeen(path: string): string | null {
  try {
    return readdirSync(join(dirname(path), "update-seen"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && parseVersion(entry.name) !== null)
      .reduce<string | null>((highest, entry) => highest === null || compareVersions(entry.name, highest) > 0 ? entry.name : highest, null);
  } catch {
    return null; // The marker directory does not exist on the first run.
  }
}

export function readVersionCache(path = versionCachePath()): VersionCache {
  const version = readObject(path);
  const dismissed = readObject(join(dirname(path), "update-dismissed.json"));
  return {
    latest_version: typeof version.latest_version === "string" ? version.latest_version : null,
    last_checked_at: typeof version.last_checked_at === "number" && Number.isFinite(version.last_checked_at) ? version.last_checked_at : null,
    tag: isUpdateTag(version.tag) ? version.tag : null,
    dismissed_version: typeof dismissed.dismissed_version === "string" ? dismissed.dismissed_version : null,
    last_seen_version: highestSeen(path),
  };
}

function writeOwner(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort removal after a failed atomic write */ }
    throw error;
  }
}

function createSeen(version: string, path: string): boolean {
  if (!parseVersion(version)) throw new Error("Invalid update version");
  const dir = join(dirname(path), "update-seen");
  mkdirSync(dir, { recursive: true });
  try {
    closeSync(openSync(join(dir, version), "wx", 0o600));
    return true;
  } catch (error) {
    if (errInfo(error).code === "EEXIST") return false;
    throw error;
  }
}

/** Record the version installed by the CLI without claiming a UI notice. */
export function markSeen(version: string, path = versionCachePath()): void {
  createSeen(version, path);
}

export function updateVersionCache(patch: Partial<VersionCache>, path = versionCachePath()): VersionCache {
  const fresh = readVersionCache(path);
  const next = { ...fresh, ...patch };
  if (["latest_version", "last_checked_at", "tag"].some((key) => Object.hasOwn(patch, key))) {
    writeOwner(path, { latest_version: next.latest_version, last_checked_at: next.last_checked_at, tag: next.tag });
  }
  if (Object.hasOwn(patch, "dismissed_version")) {
    writeOwner(join(dirname(path), "update-dismissed.json"), { dismissed_version: next.dismissed_version });
  }
  if (patch.last_seen_version !== undefined && patch.last_seen_version !== null) markSeen(patch.last_seen_version, path);
  return readVersionCache(path);
}

export function claimUpdatedNotice(current: string, path = versionCachePath()): string | null {
  const previous = highestSeen(path);
  if (!createSeen(current, path)) return null;
  return previous !== null && compareVersions(current, previous) > 0 ? current : null;
}

export interface UpdateBadge {
  surface: "npm" | "desktop";
  enabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  dismissed: boolean;
  stale: boolean;
  checkedAt: number | null;
  tag: UpdateTag;
  command: string;
  releaseUrl: string | null;
}

export function buildBadge(input: {
  cache: VersionCache; current: string; tag: UpdateTag; enabled: boolean;
  surface: "npm" | "desktop"; now: number; staleMs?: number;
}): UpdateBadge {
  const { cache, current, tag, enabled, surface, now } = input;
  const latest = cache.latest_version;
  const dismissed = latest !== null && cache.dismissed_version === latest;
  return {
    surface, enabled: enabled && surface === "npm", currentVersion: current, latestVersion: latest,
    available: surface === "npm" && cache.tag === tag && isNewer(latest, current) && !dismissed,
    dismissed,
    stale: cache.last_checked_at === null || cache.tag !== tag || now - cache.last_checked_at >= (input.staleMs ?? config.update.staleMs),
    checkedAt: cache.last_checked_at, tag,
    command: tag === "preview" ? "ima2 update --tag preview" : "ima2 update",
    releaseUrl: latest !== null ? releaseUrl(latest) : null,
  };
}
