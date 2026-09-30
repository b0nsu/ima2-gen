import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { parseVersion, PACKAGE_NAME } from "../../lib/updateVersion.js";
import { launchdPlistPath, parseServiceConfigDir, systemdUnitPath } from "./serviceManager.js";

export interface ExecResult { status: number | null; stdout: string; stderr: string }
export interface ExecOptions { inherit?: boolean; shell?: boolean }
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => ExecResult;
export const defaultExec: Exec = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, {
    encoding: "utf8", windowsHide: true, shell: opts.shell ?? false,
    stdio: opts.inherit ? ["inherit", "inherit", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  const stderr = result.stderr ?? result.error?.message ?? "";
  if (opts.inherit && stderr) process.stderr.write(stderr);
  return { status: result.status, stdout: result.stdout ?? "", stderr };
};

export interface FsLike {
  exists(p: string): boolean;
  realpath(p: string): string;
  readFile?(p: string): string;
}
export const defaultFs: FsLike = {
  exists: existsSync, realpath: realpathSync, readFile: (p) => readFileSync(p, "utf8"),
};
export function npmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}
export function npmInvocation(
  platform: NodeJS.Platform = process.platform, execPath = process.execPath, fs: FsLike = defaultFs,
): { command: string; args: string[]; shell: boolean } {
  if (platform !== "win32") return { command: "npm", args: [], shell: false };
  const paths = execPath.includes("\\") ? win32 : { dirname, join };
  const cli = paths.join(paths.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.exists(cli) ? { command: execPath, args: [cli], shell: false }
    : { command: npmCommand(platform), args: [], shell: true };
}
export function globalRoot(exec: Exec, platform: NodeJS.Platform = process.platform, fs: FsLike = defaultFs): string | null {
  const npm = npmInvocation(platform, process.execPath, fs);
  const result = exec(npm.command, [...npm.args, "root", "-g"], { inherit: false, shell: npm.shell });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
export type InstallKind =
  | { kind: "global"; pkgDir: string; root: string }
  | { kind: "source"; pkgDir: string }
  | { kind: "other"; pkgDir: string; reason: "npx" | "local" | "unknown" };
export function classifyInstall(
  pkgDir: string, exec: Exec, fs: FsLike = defaultFs, platform: NodeJS.Platform = process.platform,
): InstallKind {
  if (fs.exists(join(pkgDir, "server.ts")) || fs.exists(join(pkgDir, ".git"))) return { kind: "source", pkgDir };
  const root = globalRoot(exec, platform, fs);
  const paths = platform === "win32" ? win32 : { join };
  try {
    if (root && fs.realpath(pkgDir) === fs.realpath(paths.join(root, PACKAGE_NAME))) return { kind: "global", pkgDir, root };
  } catch { /* Missing paths cannot establish global-install ownership. */ }
  const normalized = pkgDir.replaceAll("\\", "/");
  const reason = /\/_npx\//.test(normalized) ? "npx" : /\/node_modules\//.test(normalized) ? "local" : "unknown";
  return { kind: "other", pkgDir, reason };
}
export function installGlobal(
  version: string, exec: Exec, platform: NodeJS.Platform = process.platform, fs: FsLike = defaultFs,
): void {
  if (!parseVersion(version)) throw new Error("Invalid update version");
  const npm = npmInvocation(platform, process.execPath, fs);
  const result = exec(npm.command, [...npm.args, "install", "--global", `${PACKAGE_NAME}@${version}`, "--no-fund", "--no-audit"],
    { inherit: true, shell: npm.shell });
  if (result.status === 0) return;
  const hint = /EACCES|EPERM/.test(result.stderr) ? ` Fix the npm prefix permissions or run: sudo npm i -g ${PACKAGE_NAME}@${version}` : "";
  throw new Error(`npm install failed (exit ${result.status ?? "unknown"}).${hint}`);
}
export function readInstalledVersion(pkgDir: string, fs: FsLike = defaultFs): string | null {
  try {
    const pkg: unknown = JSON.parse(fs.readFile!(join(pkgDir, "package.json")));
    return pkg !== null && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string"
      && parseVersion(pkg.version) ? pkg.version : null;
  } catch { return null; /* A missing/corrupt manifest cannot prove installation success. */ }
}

export interface RuntimeSnapshot {
  live: boolean; launcher: string | null; url: string | null; version: string | null; managed: boolean;
}
export async function runtimeSnapshot(): Promise<RuntimeSnapshot> {
  const { collectRuntimeStatus } = await import("../commands/runtimeStatus.js");
  const report = await collectRuntimeStatus();
  return { live: report.liveness === "live", launcher: report.runtime?.launcher ?? null,
    url: report.runtime?.url ?? null, version: report.runtime?.version ?? null, managed: report.serviceOwnership === "managed" };
}
export type RestartPlan = { kind: "service" } | { kind: "background" } | { kind: "foreground"; url: string } | { kind: "none" };
export function planRestart(input: RuntimeSnapshot & { serviceOwned: boolean }): RestartPlan {
  if (input.serviceOwned) return { kind: "service" };
  if (!input.live || input.managed) return { kind: "none" };
  if (input.launcher === "background") return { kind: "background" };
  if (input.launcher === "foreground" && input.url) return { kind: "foreground", url: input.url };
  return { kind: "none" };
}
export function runNewCli(pkgDir: string, args: string[], exec: Exec): number {
  return exec(process.execPath, [join(pkgDir, "bin", "ima2.js"), ...args], { inherit: true, shell: false }).status ?? 1;
}
export function serviceArtifactPath(platform: NodeJS.Platform = process.platform): string | null {
  return platform === "darwin" ? launchdPlistPath() : platform === "linux" ? systemdUnitPath() : null;
}
function serviceServerPath(text: string, platform: NodeJS.Platform): string | null {
  if (platform === "darwin") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
    const server = array ? Array.from(array.matchAll(/<string>([^<]*)<\/string>/g))[1]?.[1] : null;
    return server?.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&") ?? null;
  }
  const command = /^ExecStart=(.+)$/m.exec(text)?.[1];
  const args = command?.match(/"[^"]*"|'[^']*'|\S+/g);
  return args?.length === 2 ? args[1]!.replace(/^(["'])(.*)\1$/, "$2") : null;
}
function canonicalConfig(path: string, fs: FsLike): string {
  try { return fs.realpath(path); } catch { return resolve(path); }
}
export function serviceOwned(
  pkgDir: string, configDir: string,
  opts: { platform?: NodeJS.Platform; fs?: FsLike; log?: (line: string) => void } = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  const fs = opts.fs ?? defaultFs;
  const artifact = serviceArtifactPath(platform);
  if (!artifact || !fs.exists(artifact)) return false;
  try {
    const text = fs.readFile!(artifact);
    const server = serviceServerPath(text, platform);
    if (server && isAbsolute(server) && basename(server) === "server.js") {
      const inside = relative(fs.realpath(pkgDir), fs.realpath(server));
      if (inside && inside !== ".." && !inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(inside)
        && canonicalConfig(parseServiceConfigDir(text), fs) === canonicalConfig(configDir, fs)) return true;
    }
  } catch { /* An unreadable/unparseable artifact cannot prove ownership. */ }
  (opts.log ?? console.error)("A login service exists but belongs to another install; not restarting it.");
  return false;
}
