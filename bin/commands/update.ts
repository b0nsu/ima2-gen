import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { errInfo } from "../../lib/errInfo.js";
import { markSeen, type VersionCache } from "../../lib/updateCache.js";
import { checkForUpdate } from "../../lib/updateCheck.js";
import { defaultTag, isNewer, isUpdateTag, parseVersion, type UpdateTag } from "../../lib/updateVersion.js";
import { confirmDestructiveAction } from "../lib/destructive-confirm.js";
import { classifyInstall, defaultExec, defaultFs, installGlobal, planRestart, readInstalledVersion,
  runNewCli, runtimeSnapshot, serviceOwned, type Exec, type FsLike, type RestartPlan, type RuntimeSnapshot } from "../lib/npmUpdate.js";

const USAGE = "Usage: ima2 update [--check] [--tag latest|preview] [--yes] [--json]\nCheck or install the latest global npm release. --check never installs or restarts.";
const RESTART_POLL_MS = 500;
const RESTART_TIMEOUT_MS = 20_000;
export interface UpdateDeps {
  current: string; pkgDir: string; exec: Exec; fs: FsLike;
  check(tag: UpdateTag): Promise<VersionCache>;
  isTTY: boolean; confirm(question: string): Promise<boolean>;
  serviceOwned(pkgDir: string): boolean;
  runtime(): Promise<RuntimeSnapshot>;
  markSeen(version: string): void;
  log(line: string): void; error(line: string): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}
interface Options { check: boolean; yes: boolean; json: boolean; tag: UpdateTag }
interface UpdateResult {
  current: string; latest: string | null; tag: UpdateTag; available: boolean; updated: boolean;
  restart: { kind: RestartPlan["kind"]; ok: boolean; version: string | null } | null;
  error?: string;
}
interface Context { deps: UpdateDeps; opts: Options; result: UpdateResult; say(line: string): void }
class UsageError extends Error {}
function parseOptions(args: string[], current: string): Options {
  const opts: Options = { check: false, yes: false, json: args.includes("--json"), tag: defaultTag(current) };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--tag") {
      const tag = args[++i];
      if (!isUpdateTag(tag)) throw new UsageError("--tag must be latest or preview");
      opts.tag = tag;
    } else throw new UsageError(`Unknown option: ${arg}`);
  }
  return opts;
}
function refuseUnsupported(ctx: Context): void {
  const install = classifyInstall(ctx.deps.pkgDir, ctx.deps.exec, ctx.deps.fs);
  if (install.kind === "source") throw new UsageError("This is a source checkout. Update it with: git pull && npm install && npm run build");
  if (install.kind === "other") throw new UsageError(`ima2 is not a global npm install (${install.reason}). Install globally with: npm i -g ima2-gen@${ctx.opts.tag}`);
}
async function confirmUpdate(ctx: Context): Promise<boolean> {
  ctx.say(`v${ctx.result.current} -> v${ctx.result.latest}`);
  if (ctx.opts.yes) return true;
  if (ctx.opts.json || !ctx.deps.isTTY) throw new UsageError("Updating requires --yes in non-interactive or --json mode.");
  return ctx.deps.confirm("Install this update?");
}
function restartHint(kind: "service" | "background"): string {
  return kind === "service" ? "ima2 service restart" : "ima2 restart";
}
async function proveRestart(ctx: Context): Promise<RuntimeSnapshot> {
  const now = ctx.deps.now ?? (() => performance.now());
  const deadline = now() + RESTART_TIMEOUT_MS;
  let runtime = await ctx.deps.runtime();
  while (now() < deadline && !(runtime.live && runtime.version === ctx.result.latest)) {
    await (ctx.deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(Math.min(RESTART_POLL_MS, deadline - now()));
    runtime = await ctx.deps.runtime();
  }
  return runtime;
}
async function restartUpdated(ctx: Context, plan: RestartPlan, exec: Exec): Promise<void> {
  if (plan.kind === "none") return;
  ctx.result.restart = { kind: plan.kind, ok: false, version: null };
  if (plan.kind === "desktop") {
    ctx.say("The running server belongs to the ima2 desktop app, which updates itself; it was left running.");
    return;
  }
  if (plan.kind === "foreground") {
    ctx.say(`Restart your running 'ima2 serve' (${plan.url}) to use v${ctx.result.latest}.`);
    return;
  }
  try {
    const args = plan.kind === "service" ? ["service", "restart"] : ["restart"];
    if (runNewCli(ctx.deps.pkgDir, args, exec) === 0) {
      const runtime = await proveRestart(ctx);
      ctx.result.restart.version = runtime.version;
      ctx.result.restart.ok = runtime.live && runtime.version === ctx.result.latest;
    }
  } catch { /* Subprocess/probe errors are surfaced with the actionable restart hint below. */ }
  if (!ctx.result.restart.ok) throw new Error(`Updated to v${ctx.result.latest}, but the restart failed. Run: ${restartHint(plan.kind)}`);
}
async function installUpdate(ctx: Context): Promise<void> {
  const { deps, opts, result } = ctx;
  const exec: Exec = (cmd, args, options) => deps.exec(cmd, args, { ...options, inherit: !opts.json && Boolean(options?.inherit) });
  const owned = deps.serviceOwned(deps.pkgDir);
  const plan = planRestart({ ...await deps.runtime(), serviceOwned: owned });
  installGlobal(result.latest!, exec, process.platform, deps.fs);
  const installed = readInstalledVersion(deps.pkgDir, deps.fs);
  if (installed === null || installed !== result.latest) throw new Error(`npm finished but ima2 is still v${installed ?? "unknown"}`);
  result.updated = true;
  deps.markSeen(installed);
  ctx.say(`Updated to v${installed}`);
  await restartUpdated(ctx, plan, exec);
}
async function executeUpdate(ctx: Context): Promise<number> {
  if (!ctx.opts.check) refuseUnsupported(ctx);
  const cache = await ctx.deps.check(ctx.opts.tag);
  if (!cache.latest_version || !parseVersion(cache.latest_version)) throw new Error("Update check returned an invalid version");
  ctx.result.latest = cache.latest_version;
  ctx.result.available = isNewer(cache.latest_version, ctx.deps.current);
  if (!ctx.result.available) {
    ctx.say(`Up to date (v${ctx.deps.current})`);
    return 0;
  }
  if (ctx.opts.check) {
    const command = ctx.opts.tag === "preview" ? "ima2 update --tag preview" : "ima2 update";
    ctx.say(`Update available: v${cache.latest_version} (current v${ctx.deps.current}). Run: ${command}`);
    return 0;
  }
  if (!await confirmUpdate(ctx)) { ctx.say("Aborted."); return 0; }
  await installUpdate(ctx);
  return 0;
}
export async function runUpdate(args: string[], deps: UpdateDeps): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { deps.log(USAGE); return 0; }
  const json = args.includes("--json");
  const result: UpdateResult = { current: deps.current, latest: null, tag: defaultTag(deps.current), available: false, updated: false, restart: null };
  let code: number;
  try {
    const opts = parseOptions(args, deps.current);
    result.tag = opts.tag;
    code = await executeUpdate({ deps, opts, result, say: (line) => { if (!json) deps.log(line); } });
  } catch (error) {
    result.error = errInfo(error).message;
    code = error instanceof UsageError ? 2 : 1;
    if (!json) deps.error(`${result.error}${error instanceof UsageError ? `\n${USAGE}` : ""}`);
  }
  if (json) deps.log(JSON.stringify(result));
  return code;
}
export default async function update(args: string[] = []): Promise<void> {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const json = args.includes("--json");
  process.exitCode = await runUpdate(args, {
    current: readInstalledVersion(pkgDir) ?? "?", pkgDir, exec: defaultExec, fs: defaultFs,
    check: (tag) => checkForUpdate(tag), isTTY: Boolean(process.stdin.isTTY),
    confirm: (question) => confirmDestructiveAction(question, false),
    serviceOwned: (dir) => serviceOwned(dir, config.storage.configDir, { log: (line) => { if (!json) console.error(line); } }),
    runtime: runtimeSnapshot, markSeen, log: console.log, error: console.error,
  });
}
