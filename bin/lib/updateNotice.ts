import { claimUpdatedNotice, readVersionCache, type VersionCache } from "../../lib/updateCache.js";
import { defaultTag, isNewer, releaseUrl } from "../../lib/updateVersion.js";

interface NoticeInput {
  command: string | undefined; args: string[]; isTTY: boolean;
  env: NodeJS.ProcessEnv; current: string; cache: VersionCache;
}
const NOTICE_COMMANDS = new Set(["serve", "start", "status", "open", "doctor", "ls", "ps"]);
const SILENT_FLAGS = new Set(["--json", "--quiet", "-q", "-h", "--help", "-v", "--version"]);
function eligible(input: Omit<NoticeInput, "current" | "cache">): boolean {
  return input.isTTY && input.env.IMA2_DISABLE_UPDATE_CHECK !== "1" && input.env.IMA2_DESKTOP !== "1"
    && NOTICE_COMMANDS.has(input.command ?? "") && !input.args.some((arg) => SILENT_FLAGS.has(arg));
}
export function updateNoticeLine(input: NoticeInput): string | null {
  const { cache, current } = input;
  if (!eligible(input) || cache.tag !== defaultTag(current) || !isNewer(cache.latest_version, current)
    || cache.dismissed_version === cache.latest_version) return null;
  const command = cache.tag === "preview" ? "ima2 update --tag preview" : "ima2 update";
  return `Update available: v${cache.latest_version} (current v${current}). Run: ${command}`;
}
export interface NoticeDeps {
  isTTY: boolean; env: NodeJS.ProcessEnv; readCache(): VersionCache;
  claim(current: string): string | null; write(line: string): void;
}
export function printUpdateNotice(
  command: string | undefined, args: string[], current: string,
  deps: NoticeDeps = { isTTY: Boolean(process.stdout.isTTY), env: process.env,
    readCache: readVersionCache, claim: claimUpdatedNotice, write: (line) => process.stderr.write(`${line}\n`) },
): void {
  if (!eligible({ command, args, isTTY: deps.isTTY, env: deps.env })) return;
  try {
    const line = updateNoticeLine({ command, args, current, cache: deps.readCache(), isTTY: deps.isTTY, env: deps.env });
    if (line) deps.write(line);
    const updated = deps.claim(current);
    if (updated) deps.write(`ima2 updated to v${updated} — what's new: ${releaseUrl(updated)}`);
  } catch { /* Notices are best-effort and must not interrupt the requested command. */ }
}
