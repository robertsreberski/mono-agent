import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const { computeRuntimeDependencyDigest } = await import(new URL("../../../../scripts/lib/build-provenance.mjs", import.meta.url).href) as {
  computeRuntimeDependencyDigest(directory: string): string;
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("emits outside attested trees without changing the root runtime dependency digest", () => {
  mkdirSync(join(root, ".worklab-tmp"), { recursive: true });
  const repository = mkdtempSync(join(root, ".worklab-tmp/fixture-provenance-"));
  directories.push(repository);
  const turn = join(repository, "packages/turn");
  const put = (name: string, text: string) => {
    const file = join(turn, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  mkdirSync(join(repository, "node_modules"), { recursive: true });
  mkdirSync(join(repository, "extras"));
  put("package.json", '{"name":"@fixture/turn","type":"module","version":"1.0.0","exports":"./src/runtime/leaf.js"}');
  put("tsconfig.fixtures.json", JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true,
    checkJs: false, skipLibCheck: true, rootDir: "src",
  }, include: ["src/**/__tests__/**/fixtures/**/*.mts"] }));
  put("src/engine/__tests__/fixtures/projection-parity-worker.mts", 'import { version } from "typescript"; const name = "typescript"; const sdk = await import(`${name}`); const marker: string = (await import("../../../runtime/leaf.js")).marker; console.log(sdk.version === version && marker === "compiled" ? version : "mismatch");\n');
  put("src/__tests__/ai/fixtures/worker.mts", 'import { marker } from "../../../runtime/leaf.js"; console.log(marker);\n');
  put("src/__tests__/ai/fixtures/frozen.json", '{"nested":true}\n');
  put("src/runtime/leaf.js", 'export const marker = "legacy";\n');
  put("src/runtime/leaf.ts", 'export const marker: string = "source";\n');
  put("dist/runtime/leaf.js", 'export const marker = "compiled";\n');
  put("src/engine/__tests__/fixtures/frozen.json", '{"format":"frozen"}\n');
  put("src/__tests__/ai/fixtures/require-worker.mts", `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(join(turn, "package.json"))}); console.log(require.resolve("@fixture/turn"));\n`);
  const before = computeRuntimeDependencyDigest(repository);
  execFileSync(process.execPath, [join(root, "packages/turn/scripts/emit-test-fixtures.mjs"), turn], { cwd: root });
  expect(computeRuntimeDependencyDigest(repository)).toBe(before);
  const output = join(repository, ".worklab-tmp/turn-test-fixtures");
  expect(existsSync(join(output, "node_modules"))).toBe(false);
  expect(existsSync(join(output, "runtime/leaf.js"))).toBe(false);
  const worker = join(output, "engine/__tests__/fixtures/projection-parity-worker.mjs");
  expect(readFileSync(worker, "utf8")).toContain("file:");
  expect(execFileSync(process.execPath, ["--import", join(output, "resolve-fixture-imports.mjs"), worker], { cwd: root, encoding: "utf8" })).toMatch(/^\d+\.\d+\.\d+/u);
  expect(execFileSync(process.execPath, ["--import", join(output, "resolve-fixture-imports.mjs"), join(output, "__tests__/ai/fixtures/worker.mjs")], { cwd: root, encoding: "utf8" })).toBe("compiled\n");
  expect(execFileSync(process.execPath, ["--import", join(output, "resolve-fixture-imports.mjs"), join(output, "__tests__/ai/fixtures/require-worker.mjs")], { cwd: root, encoding: "utf8" }).trim()).toBe(join(turn, "dist/runtime/leaf.js"));
  expect(readFileSync(join(output, "__tests__/ai/fixtures/frozen.json"), "utf8")).toBe('{"nested":true}\n');
  expect(readFileSync(join(output, "engine/__tests__/fixtures/frozen.json"), "utf8")).toBe('{"format":"frozen"}\n');
});
