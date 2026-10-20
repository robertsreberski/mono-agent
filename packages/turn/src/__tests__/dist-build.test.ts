import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
function files(directory: string, source = true): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => source && entry.name === "__tests__" ? []
    : entry.isDirectory() ? files(join(directory, entry.name), source) : [join(directory, entry.name)]);
}

it("builds one strict production graph with complete runtime, declaration and map inventories", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(manifest.scripts.build).toBe("tsc -p tsconfig.build.json");
  expect(manifest.scripts.typecheck).toBe("tsc -p tsconfig.test.json --noEmit");
  expect(Object.keys(manifest.exports)).toHaveLength(11);
  expect(Object.keys(manifest.imports)).toHaveLength(16);
  for (const entry of [...Object.values(manifest.exports), ...Object.values(manifest.imports)] as { types: string; default: string }[]) {
    expect(entry.types).toMatch(/^\.\/dist\/.+\.d\.ts$/u);
    expect(entry.default).toMatch(/^\.\/dist\/.+\.js$/u);
    expect(existsSync(join(root, entry.types))).toBe(true);
    expect(existsSync(join(root, entry.default))).toBe(true);
  }
  expect(manifest.main).toBe("./dist/index.js");
  expect(manifest.types).toBe("./dist/index.d.ts");
  const build = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf8"));
  expect(build).toEqual({ extends: "./tsconfig.json", compilerOptions: { noEmit: false, noEmitOnError: true } });
  const source = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
  expect(source.extends).toBe("../../tsconfig.base.json");
  expect(source.compilerOptions.allowJs).toBe(false);
  expect(source.compilerOptions.declarationDir).toBeUndefined();
  expect(source.exclude).toContain("src/**/__tests__/**");
  const expected: string[] = [];
  for (const file of files(join(root, "src"))) {
    expect(file).toMatch(/\.(?:ts|mts)$/u);
    const stem = relative(join(root, "src"), file).replace(/\.(?:ts|mts)$/u, "");
    const runtime = `${stem}.${file.endsWith(".mts") ? "mjs" : "js"}`;
    const declaration = `${stem}.d.${file.endsWith(".mts") ? "mts" : "ts"}`;
    expected.push(runtime, declaration, `${runtime}.map`, `${declaration}.map`);
    for (const output of [runtime, declaration]) {
      const path = join(root, "dist", output);
      const map = JSON.parse(readFileSync(`${path}.map`, "utf8"));
      expect(map.sources.map((name: string) => resolve(dirname(path), name))).toEqual([file]);
    }
  }
  expect(files(join(root, "dist"), false).map((file) => relative(join(root, "dist"), file)).sort()).toEqual(expected.sort());
  expect(readFileSync(join(root, "dist/host/sandbox/srt-embed-runner.mjs"), "utf8")).toMatch(/^#!/u);
  for (const retired of ["types", "scripts/staged-build.mjs", "tsconfig.host.json", "tsconfig.host.build.json", "tsconfig.types.json"]) {
    expect(existsSync(join(root, retired)), retired).toBe(false);
  }
});
