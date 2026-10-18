import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { findUndeclaredWorkspaceImports, workspaceImportSpecifiers, WORKSPACE_IMPORT_EXCEPTIONS, workspaceFileInventory } from "../lib/workspace-imports.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dependency = "@mono-agent/other";
function check(files, dependencies = {}, options = {}) {
  const { packagePath = "packages/fixture", name = "@mono-agent/fixture", trackedFiles } = options;
  const root = mkdtempSync(join(tmpdir(), "workspace-import-tests-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, packagePath, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return findUndeclaredWorkspaceImports({ root, packagePath,
    manifest: { name, ...dependencies }, workspaceNames: new Set([dependency, name, "@mono-agent/app", "@mono-agent/conversation", "@mono-agent/turn"]), trackedFiles,
    workspacePackages: [{ name: dependency, path: "packages/other" }, { name, path: packagePath },
      { name: "@mono-agent/conversation", path: "packages/conversation" }, { name: "@mono-agent/app", path: "packages/app" }],
  });
}

it.each([
  ['src/__tests__/case.test.ts', `import type { Shape } from "${dependency}/types";`],
  ['src/type.ts', `type Shape = import("${dependency}").Shape;`],
  ['src/type.ts', `type Module = typeof import("${dependency}");`],
  ['src/dynamic.ts', `const module = await import("${dependency}");`],
  ['src/require.cjs', `const module = require("${dependency}");`],
  ['src/resolve.cjs', `const path = require.resolve("${dependency}");`],
  ['src/resolve.mjs', `const path = import.meta.resolve("${dependency}");`],
  ['src/__tests__/mock.test.ts', `vi.mock("${dependency}");`],
  ['src/__tests__/mock.test.ts', `const module = await vi.importActual("${dependency}");`],
  ['src/import.cts', `import module = require("${dependency}");`],
  ['src/export.ts', `export { Shape } from "${dependency}";`],
  ['src/export.ts', `export type { Shape } from "${dependency}";`],
  ['src/export.ts', `export * from "${dependency}";`],
  ['src/side-effect.ts', `import "${dependency}";`],
  ['src/worker.mts', `import { worker } from "${dependency}";`],
  ['src/worker.cts', `import { worker } from "${dependency}";`],
  ['src/doc.js', `/** @type {import("${dependency}").Shape} */\nlet shape;`],
  ['src/doc.ts', `/** @param {import("${dependency}").Shape} shape */\nfunction run(shape) {}`],
  ['src/doc.js', `/** @import { Shape } from "${dependency}" */\nlet shape;`],
])("rejects an undeclared reference in %s: %s", (file, text) => {
  const errors = check({ [file]: text });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(`packages/fixture/${file}:1 imports ${dependency}`);
});

it.each(["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx", "d.ts"])("walks authored .%s files", (extension) => {
  expect(check({ [`src/module.${extension}`]: `export * from "${dependency}";` })).toHaveLength(1);
});

it.each(["dependencies", "peerDependencies", "optionalDependencies"])("allows a production declaration in %s", (field) => {
  expect(check({ "src/index.ts": `export * from "${dependency}/types";` }, { [field]: { [dependency]: "workspace:*" } })).toEqual([]);
});

it("rejects production source relying only on a devDependency", () => {
  expect(check({ "src/index.ts": `import type { Shape } from "${dependency}";` },
    { devDependencies: { [dependency]: "workspace:*" } })).toHaveLength(1);
});

it.each(["src/__tests__/case.ts", "src/case.test.ts", "src/case.spec.mts", "tests/case.ts", "scripts/proof.mjs", "vitest.config.ts"])("allows a test/script devDependency in %s", (file) => {
  expect(check({ [file]: `type Shape = import("${dependency}").Shape;` },
    { devDependencies: { [dependency]: "workspace:*" } })).toEqual([]);
});

it("allows self references and non-workspace packages without false positives from prose", () => {
  expect(check({ "src/index.ts": `import "@mono-agent/fixture/subpath"; import "external"; import "@mono-agent/not-a-workspace";
// import "${dependency}";
const example = 'import "${dependency}"';` })).toEqual([]);
});

it("ignores generated/vendor directories but not large authored source files", () => {
  const text = `import "${dependency}";`;
  expect(check({ "dist/index.js": text, "node_modules/vendor/index.js": text, "coverage/fixture.js": text,
    "src/large.ts": `// ${"x".repeat(1_000_001)}\n${text}` })).toHaveLength(1);
});

it("keeps every reference and its source line", () => {
  expect(workspaceImportSpecifiers("fixture.ts", `import "${dependency}";\ntype Shape = import("${dependency}/types").Shape;`)).toEqual([
    { specifier: dependency, line: 1 }, { specifier: `${dependency}/types`, line: 2 },
  ]);
});

it("wires the new check into the architecture gate", () => {
  // An AST-based library test alone must not leave CI's entrypoint unchanged.
  const script = fileURLToPath(new URL("../check-package-architecture.mjs", import.meta.url));
  expect(readFileSync(script, "utf8")).toContain("errors.push(...findUndeclaredWorkspaceImports({");
});


it.each(["src/example.stories.tsx", "nested/.storybook/main.ts", "nested/vite.config.ts", "nested/vitest.browser.config.ts", "nested/custom.config.mts"])("treats %s as development at any depth", (file) => {
  expect(check({ [file]: `import "${dependency}";` }, { devDependencies: { [dependency]: "workspace:*" } })).toEqual([]);
});

it("uses a nested package's own dependency declarations, not its parent's", () => {
  expect(check({
    "webapp/package.json": JSON.stringify({ name: "fixture-webapp", dependencies: { [dependency]: "workspace:*" } }),
    "webapp/src/index.ts": `import "${dependency}";`,
  })).toEqual([]);
  const errors = check({
    "webapp/package.json": JSON.stringify({ name: "fixture-webapp" }),
    "webapp/src/index.ts": `import "${dependency}";`,
  }, { dependencies: { [dependency]: "workspace:*" } });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("of packages/fixture/webapp/package.json");
});

it("applies development classification relative to nested package scopes", () => {
  expect(check({
    "webapp/package.json": JSON.stringify({ name: "fixture-webapp", devDependencies: { [dependency]: "workspace:*" } }),
    "webapp/.storybook/main.ts": `import "${dependency}";`,
    "webapp/src/view.stories.tsx": `import "${dependency}";`,
    "webapp/vitest.browser.config.ts": `import "${dependency}";`,
    "webapp/src/index.ts": `import "${dependency}";`,
  })).toHaveLength(1);
});

it("counts exact and wildcard paths aliases in a nested project, including referenced configs and extends", () => {
  const files = {
    "webapp/package.json": JSON.stringify({ name: "fixture-webapp" }),
    "webapp/tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
    "webapp/tsconfig.base.json": JSON.stringify({ compilerOptions: { paths: { [`${dependency}/aliased`]: ["./src/local.ts"], [`${dependency}/wild/*`]: ["./src/*"] } } }),
    "webapp/tsconfig.app.json": JSON.stringify({ extends: "./tsconfig.base.json", include: ["src"] }),
    "webapp/src/index.ts": `import "${dependency}/aliased"; import "${dependency}/wild/value";`,
  };
  expect(check(files)).toEqual([]);
  expect(check({ ...files, "webapp/src/other.ts": `import "${dependency}/not-aliased";` })).toHaveLength(1);
  expect(check({ ...files, "src/other.ts": `import "${dependency}/aliased";` })).toHaveLength(1);
});

it("scans only the supplied tracked inventory, not generated local output", () => {
  const text = `import "${dependency}";`;
  expect(check({ "src/index.ts": text, "types/index.d.ts": text, "webapp/storybook-static/bundle.js": text, "webapp/.vite/deps.js": text }, {},
    { trackedFiles: ["packages/fixture/src/index.ts"] })).toHaveLength(1);
});

it.each(["src/index.ts", "src/types.d.ts", "src/__tests__/case.test.ts"])("flags undeclared relative workspace targets in %s", (file) => {
  const specifier = file.includes("__tests__") ? "../../../other/dist/index.js" : "../../other/src/index.js";
  const errors = check({ [file]: `type Shape = import("${specifier}").Shape;` });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(`${dependency} is not declared`);
});

it("allows declared relative targets and rejects production use of dev-only relative targets", () => {
  const files = { "src/index.ts": 'export * from "../../other/dist/index.js";' };
  expect(check(files, { dependencies: { [dependency]: "workspace:*" } })).toEqual([]);
  expect(check(files, { devDependencies: { [dependency]: "workspace:*" } })).toHaveLength(1);
  expect(check({ "src/__tests__/case.ts": 'export * from "../../../other/dist/index.js";' },
    { devDependencies: { [dependency]: "workspace:*" } })).toEqual([]);
});

it("does not flag relative imports into repository scripts or the same package", () => {
  expect(check({ "src/index.ts": 'import "../../../scripts/proof.mjs"; import "./local.js";' })).toEqual([]);
});

it("checks relative targets using the nested source package's manifest", () => {
  expect(check({
    "webapp/package.json": JSON.stringify({ name: "fixture-webapp" }),
    "webapp/src/index.ts": 'export * from "../../../other/dist/index.js";',
  }, { dependencies: { [dependency]: "workspace:*" } })).toHaveLength(1);
});

it("limits crash-worker exceptions to their exact files and relative edges", () => {
  for (const entry of WORKSPACE_IMPORT_EXCEPTIONS) {
    expect(entry.reason.length).toBeGreaterThan(20);
    for (const specifier of entry.specifiers) {
      const file = entry.file.replace("packages/web/", "");
      const options = { packagePath: "packages/web", name: "@mono-agent/web" };
      expect(check({ [file]: `import "${specifier}";` }, {}, options)).toEqual([]);
      expect(check({ [file.replace("-worker.mjs", "-new-worker.mjs")]: `import "${specifier}";` }, {}, options)).toHaveLength(1);
      expect(check({ [file]: 'import "../../../../app/dist/new-entry.js";' }, {}, options)).toHaveLength(1);
      expect(check({ [file]: 'import "@mono-agent/app";' }, {}, options)).toHaveLength(1);
    }
  }
});


it("checks the embedded webapp's bare imports against web's manifest plus its own aliases", () => {
  const options = { packagePath: "packages/web", name: "@mono-agent/web" };
  const files = {
    "webapp/package.json": JSON.stringify({ name: "embedded-webapp" }),
    "webapp/tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { [`${dependency}/aliased`]: ["./src/local.ts"] } } }),
    "webapp/src/index.ts": `import "${dependency}"; import "${dependency}/aliased"; import "../../src/contracts.js";`,
  };
  expect(check(files, { dependencies: { [dependency]: "workspace:*" } }, options)).toEqual([]);
  const errors = check(files, {}, options);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("of packages/web/package.json");
  expect(check({ ...files, "webapp/package.json": JSON.stringify({ name: "embedded-webapp", dependencies: { [dependency]: "workspace:*" } }) }, {}, options)).toHaveLength(1);
});

it.each(["src/index.ts", "src/app.config.ts"])("rejects webapp production %s using web's devDependency", (file) => {
  const errors = check({
    "webapp/package.json": JSON.stringify({ name: "embedded-webapp" }),
    [`webapp/${file}`]: 'import "@mono-agent/turn";',
  }, { devDependencies: { "@mono-agent/turn": "workspace:*" } }, { packagePath: "packages/web", name: "@mono-agent/web" });
  expect(errors).toHaveLength(1);
  expect(errors[0]).not.toContain("or devDependencies");
});

it.each(["src/view.test.ts", "src/view.stories.tsx", ".storybook/main.ts", "vitest.browser.config.ts", "src/vite.config.ts"])("allows webapp development %s using web's devDependency", (file) => {
  expect(check({
    "webapp/package.json": JSON.stringify({ name: "embedded-webapp" }),
    [`webapp/${file}`]: 'import "@mono-agent/turn";',
  }, { devDependencies: { "@mono-agent/turn": "workspace:*" } }, { packagePath: "packages/web", name: "@mono-agent/web" })).toEqual([]);
});

it("does not classify a production app.config module as tooling", () => {
  expect(check({ "src/app.config.ts": `import "${dependency}";` }, { devDependencies: { [dependency]: "workspace:*" } })).toHaveLength(1);
});

it("no longer excepts conversation edges: they require web's declared devDependency", () => {
  expect(WORKSPACE_IMPORT_EXCEPTIONS).toHaveLength(1);
  expect(WORKSPACE_IMPORT_EXCEPTIONS[0].specifiers).toEqual(["../../../../app/dist/mcp/interaction-bridge.js"]);
  for (const name of ["ask-user", "live-input"]) {
    const files = { [`src/__tests__/fixtures/${name}-kill-worker.mjs`]: 'import "../../../../conversation/dist/index.js";' };
    const options = { packagePath: "packages/web", name: "@mono-agent/web" };
    expect(check(files, {}, options)).toHaveLength(1);
    expect(check(files, { devDependencies: { "@mono-agent/conversation": "workspace:*" } }, options)).toEqual([]);
  }
});

it("inventories tracked and new nonignored files but omits deleted or ignored files", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-inventory-")); roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, "deleted.ts"), "export {};\n");
  execFileSync("git", ["add", "deleted.ts"], { cwd: root });
  rmSync(join(root, "deleted.ts"));
  writeFileSync(join(root, "new.ts"), `import "${dependency}";`);
  writeFileSync(join(root, ".gitignore"), "generated/\n");
  mkdirSync(join(root, "generated"));
  writeFileSync(join(root, "generated/output.ts"), `import "${dependency}";`);
  expect(workspaceFileInventory(root)).toEqual(expect.arrayContaining(["new.ts", ".gitignore"]));
  expect(workspaceFileInventory(root)).not.toContain("deleted.ts");
  expect(workspaceFileInventory(root)).not.toContain("generated/output.ts");
});

it("does not try reading a deleted file supplied in an inventory", () => {
  expect(check({ "src/current.ts": `import "${dependency}";` }, {},
    { trackedFiles: ["packages/fixture/src/deleted.ts", "packages/fixture/src/current.ts"] })).toHaveLength(1);
});

it.each(["git executable missing", "not a git repository"])("warns and falls back to a fresh-tree walk when %s", (message) => {
  const warnings = [];
  const files = workspaceFileInventory(tmpdir(), { runGit: () => { throw new Error(message); }, warn: (warning) => warnings.push(warning) });
  expect(files).toBeUndefined();
  expect(warnings).toEqual(["Workspace import check: Git inventory unavailable; falling back to the filesystem walker."]);
  expect(check({ "src/new.ts": `import "${dependency}";` }, {}, { trackedFiles: files })).toHaveLength(1);
});


it("keeps generated root types out of the fallback walk without hiding authored src/types", () => {
  expect(check({
    "types/generated.d.ts": `import "${dependency}";`,
    "src/types/authored.d.ts": `import "${dependency}";`,
  })).toHaveLength(1);
});
