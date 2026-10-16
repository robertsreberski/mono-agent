import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import config, { retainedEntries, retainedExports } from "../core-scans/knip.ts";
import ts from "typescript";
import { packages, root, run, scanArguments, summarize } from "../core-scans/run.mjs";

const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runWith(kind, result) {
  const directory = mkdtempSync(resolve(root, "node_modules/core-scans-test-"));
  directories.push(directory);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const execute = vi.fn(() => ({ status: 0, stdout: "[]", stderr: "", ...result }));
  return { code: run(kind, { execute, directory }), execute, directory };
}

describe("core scan policy", () => {
  test("pins tools and selects only the five core workspaces in every Knip mode", () => {
    expect(packages).toEqual(["contracts", "config", "turn", "conversation", "app"]);
    expect(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).devDependencies.knip).toBe("5.88.1");
    const scans = scanArguments("dead-code");
    expect(scans.map((scan) => scan.name)).toEqual(["knip-default", "knip-production", "knip-entry-exports"]);
    for (const { args } of scans) {
      expect(args.slice(0, 2)).toEqual(["exec", "knip"]);
      expect(args.filter((_, index) => args[index - 1] === "--workspace")).toEqual(packages.map((name) => `packages/${name}`));
      expect(args).not.toContain("--no-exit-code");
    }
    expect(scans[1].args).toContain("--production");
    expect(scans[2].args).toContain("--include-entry-exports");
    expect(scanArguments("cycles").map(({ args }) => args.at(-1))).toEqual(packages.map((name) => `packages/${name}/src`));
    for (const { args } of scanArguments("cycles")) {
      expect(args.slice(0, 2)).toEqual(["dlx", "madge@8.0.0"]);
      expect(args.slice(-3, -1)).toEqual(["--exclude", "__tests__"]);
    }
    expect(() => scanArguments("unknown")).toThrow(/Usage/);
  });

  test("limits exceptions to exact fixture paths and the string-loaded dependency", () => {
    expect(Object.keys(config.ignoreIssues)).toEqual([
      "packages/conversation/src/__tests__/fixtures/canonical-v5-fixture.d.mts",
      "packages/conversation/src/__tests__/fixtures/managed-native-switch-fixture.d.mts",
    ]);
    expect(config.workspaces["packages/turn"].ignoreDependencies).toEqual(["@vscode/ripgrep"]);
    for (const name of packages) {
      expect(config.workspaces[`packages/${name}`].project[0]).toMatch(/^src\/.*!$/);
      expect(config.workspaces[`packages/${name}`].project).toContain("!src/**/__tests__/**!");
    }
    const smoke = readFileSync(resolve(root, "packages/app/scripts/README.md"), "utf8");
    for (const entry of config.workspaces["packages/app"].entry.filter((entry) => !entry.endsWith("!"))) {
      expect(smoke).toContain(entry);
    }
  });

  test("uses native local-use analysis and only registered per-symbol annotations", () => {
    expect(config.ignoreExportsUsedInFile).toBe(true);
    expect(config.tags).toEqual(["-coreScanRetained"]);
    const expected = new Set(retainedExports.flatMap((entry) => entry.taggedNames.map((name) => `${entry.file}:${name}`)));
    const actual = new Set();
    for (const file of globSync("packages/{contracts,config,turn,conversation,app}/src/**/*.{js,ts}", { cwd: root })) {
      if (file.includes("/__tests__/")) continue;
      const source = readFileSync(resolve(root, file), "utf8");
      if (!source.includes("@coreScanRetained")) continue;
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const node of ast.statements) {
        if (!ts.getJSDocTags(node).some((tag) => tag.tagName.text === "coreScanRetained")) continue;
        const name = node.name?.text ?? (ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name.getText(ast) : undefined);
        expect(name, file).toBeTruthy();
        actual.add(`${file}:${name}`);
      }
    }
    expect([...actual].sort()).toEqual([...expected].sort());
    for (const entry of [...retainedExports, ...retainedEntries]) {
      expect(entry.reason).toMatch(/^(documented extension|consumed|test isolation control|indirect|deferred):? /);
      const citation = entry.citation.split(/[:#]/)[0];
      const evidence = readFileSync(resolve(root, citation), "utf8")
        .replace(/<!-- public-api-inventory:start -->[\s\S]*?<!-- public-api-inventory:end -->/g, "");
      expect(evidence.trim()).not.toBe("");
      if ("names" in entry) for (const name of entry.names) expect(readFileSync(resolve(root, entry.file), "utf8")).toContain(name);
    }
    expect(retainedEntries).toContainEqual({
      file: "packages/turn/src/agent/allowlists.js",
      reason: "deferred: turn entry regrouping",
      citation: "packages/turn/package.json",
    });
  });

  test("summarizes findings without counting consumers", () => {
    const issue = { exports: [{ name: "unused" }], types: [], dependencies: [], duplicates: [] };
    expect(summarize({ files: ["packages/app/src/unused.ts", "extras/other/src/unused.ts"], issues: [
      { ...issue, file: "packages/app/src/used.ts" }, { ...issue, file: "extras/other/src/used.ts" },
    ] }, "app")).toEqual({ files: 1, exports: 1, types: 0, other: 0 });
  });

  test("finishes every mode when findings return exit 1", () => {
    const { code, execute } = runWith("dead-code", { status: 1, stdout: '{"files":[],"issues":[]}' });
    expect(code).toBe(1);
    expect(execute).toHaveBeenCalledTimes(3);
    for (const [, , options] of execute.mock.calls) expect(options.cwd).toBe(root);
  });

  test("the combined command runs cycles even if Knip fails", () => {
    const { code, execute } = runWith("all", { status: 1, stdout: "invalid report" });
    expect(code).toBe(2);
    expect(execute).toHaveBeenCalledTimes(8);
  });

  test("reports an empty cycle scan as clean", () => {
    const { code, execute } = runWith("cycles");
    expect(code).toBe(0);
    expect(execute).toHaveBeenCalledTimes(5);
  });

  test.each([
    { status: 1, stdout: "not JSON" },
    { status: 2 },
    { signal: "SIGTERM", status: null },
    { error: new Error("tool missing"), status: null },
    { stdout: '{"files":["extras/other/src/unused.ts"],"issues":[]}' },
  ])("keeps tool failures distinct from scan findings: %j", (result) => {
    const { code, execute, directory } = runWith("dead-code", result);
    expect(code).toBe(2);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(JSON.parse(readFileSync(resolve(directory, "knip-default.json"), "utf8"))).toHaveProperty("error");
  });
});
