import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const webapp = process.cwd();
const specifier = "@mono-agent/agent-contracts/provider-usage";
const canonical = resolve(webapp, "../../agent-contracts/src/provider-usage.ts");

describe("standalone browser contract resolution", () => {
  it.each(["vite.config.ts", "vitest.browser.config.ts"])("maps the exact pure contract source in %s", async (configFile) => {
    // Resolve real configs in Node, not jsdom's mixed typed-array realm (which
    // esbuild correctly rejects). This does not start a dev/test server.
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { resolveConfig } from "vite";
      const config = await resolveConfig({ configFile: ${JSON.stringify(resolve(webapp, configFile))} }, "serve");
      const alias = config.resolve.alias.find(({ find }) => find instanceof RegExp && find.test(${JSON.stringify(specifier)}));
      console.log(JSON.stringify(alias ? {
        replacement: alias.replacement,
        matchesBarrel: alias.find.test("@mono-agent/agent-contracts"),
        matchesNested: alias.find.test(${JSON.stringify(`${specifier}/other`)}),
      } : null));
    `], { cwd: webapp, encoding: "utf8", timeout: 30_000 });
    expect(JSON.parse(result)).toEqual({ replacement: canonical, matchesBarrel: false, matchesNested: false });
  });

  it("keeps TypeScript on the same canonical source without contracts dist", () => {
    const configFile = resolve(webapp, "tsconfig.app.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    expect(config.compilerOptions.paths[specifier]).toHaveLength(1);
    expect(resolve(dirname(configFile), config.compilerOptions.paths[specifier][0])).toBe(canonical);
    expect(config.include.map((path: string) => resolve(webapp, path))).toContain(canonical);
  });
});
