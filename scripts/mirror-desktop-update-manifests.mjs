#!/usr/bin/env node
/**
 * Installed desktop apps find updates through electron-updater's GitHub provider, which
 * reads latest*.yml from the release GitHub marks Latest. By contract that is the npm
 * release vX.Y.Z (scripts/release-contract.mjs ensureGithubRelease --latest), while the
 * desktop assets and manifests live in desktop-vX.Y.Z, published with --latest=false
 * (.github/workflows/desktop.yml). Without a copy in vX.Y.Z every update check ends in
 * "Cannot find latest-mac.yml in the latest release artifacts" (404).
 *
 * This copies the desktop manifests with every file path rewritten to
 * "../desktop-vX.Y.Z/<file>". The provider builds download URLs with
 * new URL("/<owner>/<repo>/releases/download/vX.Y.Z/<path>", "https://github.com"),
 * which normalizes the dot segment, so the download lands on the desktop release asset
 * that the unchanged sha512 describes.
 *
 * Usage: node scripts/mirror-desktop-update-manifests.mjs <sourceDir> <outDir> <desktopTag>
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_NAME = /^latest(?:-[a-z0-9-]+)?\.yml$/;
const DESKTOP_TAG = /^desktop-v\d+\.\d+\.\d+$/;
const FILE_LINE = /^(\s*-\s+url:\s+|path:\s+)(\S+)$/gm;

export function rewriteManifest(text, desktopTag) {
  if (!DESKTOP_TAG.test(desktopTag)) throw new Error("desktop tag must look like desktop-vX.Y.Z: " + desktopTag);
  let rewritten = 0;
  const next = text.replace(FILE_LINE, (_line, key, value) => {
    if (value.includes("/") || value.includes("\\")) throw new Error("manifest file path is not a bare name: " + value);
    rewritten += 1;
    return key + "../" + desktopTag + "/" + value;
  });
  if (rewritten === 0) throw new Error("manifest has no url or path entries");
  return next;
}

export function mirrorManifests(sourceDir, outDir, desktopTag) {
  const names = readdirSync(sourceDir).filter((name) => MANIFEST_NAME.test(name)).sort();
  if (names.length === 0) throw new Error("no latest*.yml manifests in " + sourceDir);
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(outDir, name), rewriteManifest(readFileSync(join(sourceDir, name), "utf8"), desktopTag));
  }
  return names;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourceDir, outDir, desktopTag] = process.argv.slice(2);
  if (!sourceDir || !outDir || !desktopTag) {
    console.error("Usage: node scripts/mirror-desktop-update-manifests.mjs <sourceDir> <outDir> <desktopTag>");
    process.exit(2);
  }
  for (const name of mirrorManifests(sourceDir, outDir, desktopTag)) console.log("mirrored " + name);
}

