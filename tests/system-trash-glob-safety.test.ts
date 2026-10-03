import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { executionTestProcess } from "./_executionTestProcess.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const chain = ["trash", "globby", "fast-glob", "micromatch", "braces"];
const versions = ["10.1.1", "14.1.0", "3.3.3", "4.0.8", "3.0.3"];
type Package = { version?: string; dev?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };

function guardedImports(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName)
    .filter((name) => chain.some((pkg) => name === pkg || name.startsWith(`${pkg}/`) || name.includes(`/node_modules/${pkg}/`)));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".git", "dist", "tests", "e2e", "devlog", "skills", "target"].includes(entry.name) || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.[cm]?[jt]sx?$/.test(path) || /\.(test|spec|d)\.[cm]?[jt]sx?$/.test(path)) return [];
    if (path.endsWith(".js") && existsSync(path.slice(0, -3) + ".ts")) return [];
    return [path];
  });
}

if (executionTestProcess(import.meta.url)) {
  test("real trash receives literal single/multiple paths without invoking globby; glob:true reaches sentinel", async (t) => {
    assert.equal(process.env.IMA2_TEST_SYSTEM_TRASH_DIR, undefined);
    const dir = mkdtempSync(join(tmpdir(), "ima2-trash-glob-"));
    const calls: string[][] = [];
    let globCalls = 0;
    const sentinel = new Error("GLOBBY_PATTERN_PARSER_REACHED");
    const entry = import.meta.resolve("trash");
    const capture = async (paths: string[]) => { calls.push(paths); };
    try {
      mock.module("globby", { namedExports: { globby: async () => { globCalls++; throw sentinel; } } });
      for (const platform of ["macos", "windows", "linux", "wsl"]) {
        mock.module(new URL(`./lib/${platform}.js`, entry), { defaultExport: capture });
      }
      const { default: trash } = await import("trash");
      const { moveToSystemTrash } = await import("../lib/systemTrash.ts");
      assert.equal(globCalls, 0, "import does not call globby");
      const names = ["ordinary.png", "literal{a,b}.png", "literal[ab].png", "!negated.png"];
      if (process.platform !== "win32") names.push("literal*.png", "literal?.png");
      const paths = names.map((name) => join(dir, name));
      for (const path of paths) writeFileSync(path, "synthetic fixture");
      await moveToSystemTrash([relative(process.cwd(), paths[0])]);
      await moveToSystemTrash(paths.slice(1));
      assert.deepEqual(calls, [[resolve(paths[0])], paths.slice(1).map((path) => resolve(path))]);
      assert.equal(globCalls, 0, "the production wrapper must bypass pattern expansion");
      assert.ok(paths.every((path) => existsSync(path)), "mocked OS implementations never delete fixtures");
      await assert.rejects(trash(paths, { glob: true }), (error) => error === sentinel);
      assert.equal(globCalls, 1, "positive control proves globby interception is live");
      assert.equal(calls.length, 2, "positive control stops before the OS boundary");
      t.diagnostic(JSON.stringify({ literalFiles: paths.length, platformCalls: calls.length, globCalls, realOsCalls: 0 }));
    } finally {
      mock.restoreAll();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("production lock graph has only the reviewed five-node trash parser chain", () => {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, Package> };
    const incoming: string[] = [];
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (pkg.dev) continue;
      for (const name of chain) {
        if (pkg.dependencies?.[name] || pkg.optionalDependencies?.[name]) incoming.push(`${path || "<root>"}->${name}`);
      }
    }
    assert.deepEqual(incoming.sort(), ["<root>->trash", "node_modules/trash->globby", "node_modules/globby->fast-glob", "node_modules/fast-glob->micromatch", "node_modules/micromatch->braces"].sort());
    chain.forEach((name, index) => {
      const copies = Object.entries(lock.packages).filter(([path, pkg]) => !pkg.dev && (path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)));
      assert.deepEqual(copies.map(([path, pkg]) => [path, pkg.version]), [[`node_modules/${name}`, versions[index]]]);
      const installed = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as Package;
      assert.equal(installed.version, versions[index], `installed ${name} must match inspected lock`);
    });
  });

  test("first-party production imports cannot add another consumer of the excepted parser chain", () => {
    const consumers = sourceFiles(root).flatMap((path) => guardedImports(readFileSync(path, "utf8"))
      .map((name) => `${relative(root, path).split(sep).join("/")}->${name}`));
    assert.deepEqual(consumers.sort(), ["lib/systemTrash.ts->trash"]);
    for (const name of chain) {
      for (const source of [`import x from '${name}'`, `export * from '${name}'`, `import('${name}')`, `require('${name}')`, `import x from '${name}/index.js'`]) {
        assert.equal(guardedImports(source).length, 1, `scanner must see ${source}`);
      }
    }
  });
}
