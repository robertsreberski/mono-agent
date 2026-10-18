import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import config, { retainedEntries, retainedExports } from "../core-scans/knip.ts";
import ts from "typescript";
import { classifyCycles, cycleExceptions } from "../core-scans/cycle-policy.mjs";
import { ownedPaths } from "../../packages/turn/scripts/staged-build.mjs";
import { missingPackageEntryPoints, packages, root, run, scanArguments, summarize } from "../core-scans/run.mjs";

const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runWith(kind, result, overrides = {}) {
  const directory = mkdtempSync(resolve(root, "node_modules/core-scans-test-"));
  directories.push(directory);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const execute = vi.fn(() => ({ status: 0, stdout: "[]", stderr: "", ...result }));
  return { code: run(kind, { execute, directory, checkBuild: () => [], sourceView: (action) => action(), exceptions: [], ...overrides }), execute, directory };
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

  test("registers all retained turn entries at their single authored source owner", () => {
    const directory = resolve(root, "packages/turn");
    const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    expect(Object.keys(manifest.exports)).toHaveLength(11);
    const entries = config.workspaces["packages/turn"].entry;
    const products = new Set(ownedPaths().map((path) => `${path}!`));
    const expected = [
      "src/index.ts!", "src/ai/index.ts!", "src/agent/index.ts!",
      "src/host/index.ts!", "src/host/config.ts!", "src/host/types.ts!", "src/host/sandbox/index.ts!",
      "src/engine/index.ts!", "src/engine/sessions.ts!", "src/engine/owned-fs.ts!", "src/tools/index.ts!",
    ];
    expect(expected).toHaveLength(11);
    expect(entries).toContain("src/engine/__tests__/fixtures/projection-parity-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/projection-parity-worker.mts!");
    expect(entries).toContain("src/__tests__/fixtures/prepared-host-runtime.mts");
    expect(entries).not.toContain("src/__tests__/fixtures/prepared-host-runtime.mts!");
    expect(entries).toContain("src/__tests__/ai/fixtures/native-journal-storage-worker.mts");
    expect(entries).not.toContain("src/__tests__/ai/fixtures/native-journal-storage-worker.mts!");
    expect(entries).toContain("src/__tests__/ai/fixtures/native-lifecycle-storage-worker.mts");
    expect(entries).not.toContain("src/__tests__/ai/fixtures/native-lifecycle-storage-worker.mts!");
    expect(entries).toContain("src/__tests__/ai/fixtures/native-writer-holder.mts");
    expect(entries).not.toContain("src/__tests__/ai/fixtures/native-writer-holder.mts!");
    expect(entries).toContain("src/engine/__tests__/fixtures/append-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/append-worker.mts!");
    expect(entries).toContain("src/engine/__tests__/fixtures/checkpoint-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/checkpoint-worker.mts!");
    expect(entries).toContain("src/engine/__tests__/fixtures/effect-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/effect-worker.mts!");
    expect(entries).toContain("src/engine/__tests__/fixtures/import-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/import-worker.mts!");
    expect(entries).toContain("src/engine/__tests__/fixtures/lock-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/lock-worker.mts!");
    expect(entries).toContain("src/engine/__tests__/fixtures/native-create-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/native-create-worker.mts!");
    expect(entries).toContain("src/engine/__tests__/fixtures/store-owner-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/store-owner-worker.mts!");
    expect(entries).toContain("src/engine/__tests__/fixtures/turn-evidence-worker.mts");
    expect(entries).not.toContain("src/engine/__tests__/fixtures/turn-evidence-worker.mts!");
    for (const entry of expected) {
      expect(entries).toContain(entry);
      expect(products.has(entry)).toBe(false);
    }
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
    const generated = new Set(ownedPaths().map((path) => `packages/turn/${path}`));
    for (const file of globSync("packages/{contracts,config,turn,conversation,app}/src/**/*.{js,mjs,ts,mts}", { cwd: root })) {
      if (file.includes("/__tests__/") && !retainedExports.some((entry) => entry.file === file) || generated.has(file)) continue;
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
    expect(retainedEntries).toEqual([]);
    expect(retainedExports.filter((entry) => entry.reason.startsWith("deferred: turn"))).toEqual([]);
  });

  test("checks built entries before entering the authored-only source view", () => {
    const events = [];
    const { code } = runWith("dead-code", { stdout: '{"files":[],"issues":[]}' }, {
      checkBuild: () => { events.push("preflight"); return []; },
      sourceView: (action) => { events.push("hide"); try { return action(); } finally { events.push("restore"); } },
    });
    expect(code).toBe(0);
    expect(events).toEqual(["preflight", "hide", "restore", "hide", "restore", "hide", "restore"]);
  });

  test("reports source-view failures without keeping stale scan successes", () => {
    const { code, execute, directory } = runWith("dead-code", {}, {
      sourceView: () => { throw new Error("stale staged output"); },
    });
    expect(code).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    for (const { name } of scanArguments("dead-code")) {
      expect(JSON.parse(readFileSync(resolve(directory, `${name}.json`), "utf8"))).toEqual({ error: "stale staged output" });
    }
  });

  test("summarizes findings without counting consumers", () => {
    const issue = { exports: [{ name: "unused" }], types: [], dependencies: [], duplicates: [] };
    expect(summarize({ files: ["packages/app/src/unused.ts", "extras/other/src/unused.ts"], issues: [
      { ...issue, file: "packages/app/src/used.ts" }, { ...issue, file: "extras/other/src/used.ts" },
    ] }, "app")).toEqual({ files: 1, exports: 1, types: 0, other: 0 });
  });

  test("requires every manifest runtime/types entry, including nested conditions and subpaths", () => {
    const workspace = mkdtempSync(resolve(root, "node_modules/core-scans-build-test-"));
    directories.push(workspace);
    const entries = ["dist/index.js", "types/index.d.ts", "types/nested.d.ts", "dist/nested.js"];
    for (const name of packages) {
      const directory = resolve(workspace, "packages", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, "package.json"), JSON.stringify({
        main: "./dist/index.js", types: "./types/index.d.ts",
        exports: {
          ".": { types: "./types/index.d.ts", import: "./dist/index.js" },
          "./nested": { node: [{ types: "./types/nested.d.ts" }, "./dist/nested.js"], default: null },
          "./package.json": "./package.json",
        },
      }));
    }
    expect(missingPackageEntryPoints(workspace)).toHaveLength(packages.length * entries.length);
    for (const name of packages) for (const file of entries) {
      const directory = resolve(workspace, "packages", name, file.split("/")[0]);
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(workspace, "packages", name, file), "");
    }
    expect(missingPackageEntryPoints(workspace)).toEqual([]);
    rmSync(resolve(workspace, "packages/contracts/dist/nested.js"));
    rmSync(resolve(workspace, "packages/app/types/index.d.ts"));
    expect(missingPackageEntryPoints(workspace)).toEqual([
      "packages/contracts/dist/nested.js", "packages/app/types/index.d.ts",
    ]);
  });

  test("refuses an unbuilt tree before executing Knip and invalidates stale reports", () => {
    const directory = mkdtempSync(resolve(root, "node_modules/core-scans-test-"));
    directories.push(directory);
    for (const { name } of scanArguments("dead-code")) {
      writeFileSync(resolve(directory, `${name}.json`), '{"files":["packages/app/src/orphan.ts"],"issues":[]}');
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn();
    const code = run("dead-code", { execute, directory,
      checkBuild: () => ["packages/conversation/dist/index.js"],
    });
    expect(code).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Run `pnpm run build` first"));
    for (const { name } of scanArguments("dead-code")) {
      const report = JSON.parse(readFileSync(resolve(directory, `${name}.json`), "utf8"));
      expect(report).toEqual({ error: expect.stringContaining("packages/conversation/dist/index.js") });
      expect(report).not.toHaveProperty("issues");
    }
  });

  test("cycle scans do not require built entries", () => {
    const checkBuild = vi.fn(() => ["packages/app/dist/index.js"]);
    expect(runWith("cycles", {}, { checkBuild }).code).toBe(0);
    expect(checkBuild).not.toHaveBeenCalled();
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

test("retains only exact existing declaration-preservation aliases at their registered owners", () => {
  const aliases = retainedExports.filter((entry) => entry.declarationPreserving);
  expect(aliases.flatMap((entry) => entry.names.map((name) => `${entry.file}:${name}`)).sort()).toEqual([
    "packages/turn/src/contracts/model.ts:RuntimeSdkId",
    "packages/turn/src/contracts/runtime.ts:AgentRuntimeInstance",
    "packages/turn/src/contracts/runtime.ts:RuntimeBridge",
    "packages/turn/src/contracts/runtime.ts:RuntimeBridgeDescriptor",
  ].sort());
  for (const entry of aliases) {
    const ast = ts.createSourceFile(entry.file, readFileSync(resolve(root, entry.file), "utf8"), ts.ScriptTarget.Latest, true);
    const exports = ast.statements.filter((node) => ts.isTypeAliasDeclaration(node)
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).map((node) => node.name.text);
    for (const name of entry.names) expect(exports, `${entry.file}:${name}`).toContain(name);
    expect(entry.taggedNames).toEqual(entry.names);
    const citation = readFileSync(resolve(root, entry.citation), "utf8");
    for (const name of entry.names) expect(citation, entry.citation).toContain(name);
  }
});

describe("exact erased cycle policy", () => {
  const listed = ["../../web/dist/console-tools.d.ts", "../../web/dist/store.d.ts"];
  const report = (appCycles) => (_command, args) => ({ status: appCycles.length && args.at(-1) === "packages/app/src" ? 1 : 0,
    stdout: JSON.stringify(args.at(-1) === "packages/app/src" ? appCycles : []), stderr: "" });

  test("accepts exactly the listed erased cycle while preserving raw findings", () => {
    const { code, directory } = runWith("cycles", {}, { exceptions: cycleExceptions, execute: report([listed]) });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(resolve(directory, "madge-app.json"), "utf8"))).toEqual([listed]);
    const policy = JSON.parse(readFileSync(resolve(directory, "madge-app.policy.json"), "utf8"));
    expect(policy.matched).toHaveLength(1);
    expect(policy.matched[0].classification).toBe("erased");
    expect(policy.unexpected).toEqual([]);
    expect(policy.stale).toEqual([]);
  });

  test("fails for a new cycle alongside the listed exception", () => {
    expect(runWith("cycles", {}, { exceptions: cycleExceptions, execute: report([listed, ["new.ts", "other.ts"]]) }).code).toBe(1);
  });

  test("fails on a stale listing rather than silently accepting an empty scan", () => {
    const { code, directory } = runWith("cycles", {}, { exceptions: cycleExceptions });
    expect(code).toBe(1);
    expect(JSON.parse(readFileSync(resolve(directory, "madge-app.policy.json"), "utf8")).stale).toEqual(cycleExceptions);
  });

  test("normalizes only cycle rotation, not different paths or additional edges", () => {
    expect(classifyCycles("madge-app", [[...listed].reverse()]).matched).toHaveLength(1);
    for (const cycle of [[listed[0], listed[1], "extra.ts"], ["console-tools.ts", "store.ts"]]) {
      const result = classifyCycles("madge-app", [cycle]);
      expect(result.matched).toEqual([]);
      expect(result.unexpected).toHaveLength(1);
      expect(result.stale).toHaveLength(1);
    }
    expect(() => classifyCycles("madge-app", [[]])).toThrow(/Invalid Madge/);
    expect(() => classifyCycles("madge-app", [], [...cycleExceptions, ...cycleExceptions])).toThrow(/Duplicate/);
  });

  test.each([
    ["static import", 'import "./store.js";'],
    ["value re-export", 'export { value } from "./store.js";'],
    ["dynamic import", 'void import("./store.js");'],
    ["third-module path", 'import "./third.js";'],
  ])("rejects an emitted %s runtime path under the erased exception", (_name, mutation) => {
    const parent = resolve(root, ".worklab-tmp");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(resolve(parent, "cycle-runtime-test-"));
    directories.push(directory);
    const dist = resolve(directory, "packages/web/dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(resolve(dist, "console-tools.js"), "export const operation = true;");
    writeFileSync(resolve(dist, "store.js"), 'import "./console-tools.js"; export const value = true;');
    writeFileSync(resolve(dist, "third.js"), 'export { value } from "./store.js";');
    expect(classifyCycles("madge-app", [listed], cycleExceptions, directory).matched).toHaveLength(1);
    writeFileSync(resolve(dist, "console-tools.js"), mutation);
    expect(() => classifyCycles("madge-app", [listed], cycleExceptions, directory)).toThrow(/emitted runtime path/);
  });

  test("keeps exact source-edge evidence for the erased classification", () => {
    expect(cycleExceptions).toHaveLength(1);
    const entry = cycleExceptions[0];
    expect(entry.scan).toBe("madge-app");
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.edges.map((edge) => edge.kind)).toEqual(["type-only", "runtime"]);
    for (const edge of entry.edges) {
      const source = ts.createSourceFile(edge.from, readFileSync(resolve(root, edge.from), "utf8"), ts.ScriptTarget.Latest, true);
      const imports = source.statements.filter(ts.isImportDeclaration).filter((node) => node.moduleSpecifier.text === `./${edge.to.split("/").at(-1).replace(/\.ts$/, ".js")}`);
      expect(imports, edge.from).toHaveLength(1);
      expect(imports[0].importClause.isTypeOnly, edge.from).toBe(edge.kind === "type-only");
    }
  });
});
