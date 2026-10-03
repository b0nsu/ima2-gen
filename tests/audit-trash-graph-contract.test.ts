import assert from "node:assert/strict";
import { test } from "node:test";
import { loadExceptions, partitionFindings } from "../scripts/audit-gate.mjs";

const NOW = new Date("2026-10-03T00:00:00.000Z");
const GHSA = "GHSA-vfj7-8cjw-p6xm";
const names = ["braces", "fast-glob", "globby", "micromatch", "trash"];
const advisory = (ghsa: string) => ({ url: `https://github.com/advisories/${ghsa}` });
const exception = (overrides: Record<string, string> = {}) => ({
  ghsa: GHSA, package: "braces", scope: "root",
  reason: "Literal paths do not reach pattern parsing",
  evidence: "Real installed trash glob sentinel and production caller/graph guard",
  expires: "2026-10-17T00:00:00.000Z", ...overrides,
});

function graph(bracesVia: unknown[] = [advisory(GHSA)], extra: Record<string, { severity: string; via: unknown[] }> = {}) {
  const vulnerabilities = {
    // npm's actual propagated graph; reverse order forces multiple fixed-point rounds.
    trash: { severity: "high", via: ["globby"] },
    globby: { severity: "high", via: ["fast-glob"] },
    "fast-glob": { severity: "high", via: ["micromatch"] },
    micromatch: { severity: "high", via: ["braces"] },
    braces: { severity: "high", via: bracesVia }, ...extra,
  };
  return { vulnerabilities, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: Object.keys(vulnerabilities).length, critical: 0 } } };
}

const active = (overrides: Record<string, string> = {}, now = NOW) =>
  loadExceptions(JSON.stringify({ exceptions: [exception(overrides)] }), now).active;

test("one exact root braces advisory excludes precisely its five-node propagated graph", () => {
  const result = partitionFindings(graph(), "high", active(), "root");
  assert.deepEqual(result.excluded.sort(), names);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(partitionFindings(graph(), "high", [], "root").remaining.sort(), names);
});

test("another braces advisory invalidates the entire propagated exclusion", () => {
  const result = partitionFindings(graph([advisory(GHSA), advisory("GHSA-aaaa-bbbb-cccc")]), "high", active(), "root");
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.remaining.sort(), names);
});

test("an unrelated high finding remains blocked alongside the excluded graph", () => {
  const report = graph(undefined, { unrelated: { severity: "high", via: [advisory("GHSA-aaaa-bbbb-cccc")] } });
  const result = partitionFindings(report, "high", active(), "root");
  assert.deepEqual(result.excluded.sort(), names);
  assert.deepEqual(result.remaining, ["unrelated"]);
});

test("mixed, unknown and missing via entries cannot be covered by the braces exception", () => {
  for (const via of [[advisory(GHSA), "unknown"], [advisory(GHSA), { source: 999 }], [advisory(GHSA), null], []]) {
    const result = partitionFindings(graph(via), "high", active(), "root");
    assert.deepEqual(result.excluded, []);
    assert.deepEqual(result.remaining.sort(), names);
  }
});

test("wrong scope and wrong package cannot widen the root exception", () => {
  assert.deepEqual(partitionFindings(graph(), "high", active({ scope: "ui" }), "root").remaining.sort(), names);
  assert.deepEqual(partitionFindings(graph(), "high", active(), "ui").remaining.sort(), names);
  assert.throws(() => partitionFindings(graph(), "high", active({ package: "trash" }), "root"), /names package trash but the advisory belongs to braces/);
});

test("expiry at the exact UTC boundary restores all five findings", () => {
  const before = new Date("2026-10-16T23:59:59.999Z");
  const expiry = new Date("2026-10-17T00:00:00.000Z");
  assert.deepEqual(partitionFindings(graph(), "high", active({}, before), "root").remaining, []);
  const loaded = loadExceptions(JSON.stringify({ exceptions: [exception()] }), expiry);
  assert.equal(loaded.active.length, 0);
  assert.match(loaded.skipped[0].problems.join(), /expired on/);
  assert.deepEqual(partitionFindings(graph(), "high", loaded.active, "root").remaining.sort(), names);
});
