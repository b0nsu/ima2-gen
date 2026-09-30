export type UpdateTag = "latest" | "preview";
export const PACKAGE_NAME = "ima2-gen";

type ParsedVersion = { core: [number, number, number]; pre: string[] };
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(v: string): ParsedVersion | null {
  const match = VERSION_RE.exec(v);
  if (!match) return null;
  const core: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!core.every(Number.isSafeInteger)) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core, pre };
}

function compareIdentifier(a: string, b: string): number {
  if (a === b) return 0;
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric && a.length !== b.length) return a.length > b.length ? 1 : -1;
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a > b ? 1 : -1;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (const index of [0, 1, 2] as const) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const order = compareIdentifier(l, r);
    if (order) return order;
  }
  return 0;
}

export function isNewer(candidate: string | null | undefined, current: string): boolean {
  return typeof candidate === "string" && parseVersion(candidate) !== null && compareVersions(candidate, current) > 0;
}

export function defaultTag(current: string): UpdateTag {
  return /-preview/.test(current) ? "preview" : "latest";
}

export function isUpdateTag(v: unknown): v is UpdateTag {
  return v === "latest" || v === "preview";
}

export function releaseUrl(version: string): string {
  return `https://github.com/lidge-ai/ima2-gen/releases/tag/v${version}`;
}
