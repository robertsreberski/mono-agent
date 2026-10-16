import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

function resolvedGraph(entry, profile) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const seen = new Set(), blocked = [];
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      seen.add(result.url);
      const turn = result.url.includes("/packages/turn/");
      const execution = /\\/ai\\/(?:provider-check\\.js|providers\\/engine-turn\\.js)|\\/tools\\/(?:pi-tools\\.js|commands\\/(?:bash|exec)\\.js|mcp\\/)/u.test(result.url);
      const configForbidden = /\\/src\\/(?:runtime\\.js|ai\\/runtime\\/router\\.js|engine\\/|agent\\/tools\\/|tools\\/)/u.test(result.url);
      if (turn && (execution || (${JSON.stringify(profile)} === "config" && configForbidden))) {
        blocked.push(result.url);
        throw new Error("Lightweight import reached execution: " + result.url);
      }
      return result;
    }});
    await import(${JSON.stringify(entry)});
    // Optional-import catches must not hide a hook rejection.
    assert.deepEqual(blocked, []);
    process.stdout.write(JSON.stringify([...seen]));
  `], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

it.each(["@mono-agent/turn/host/config", "@mono-agent/config"])("keeps built %s on the metadata-only resolved graph", (entry) => {
  const seen = resolvedGraph(entry, "config");
  expect(seen.some((url) => url.endsWith("/dist/host/config.js"))).toBe(true);
  expect(seen.some((url) => url.endsWith("/src/ai/pi-interop.js"))).toBe(true);
});

it("does not load expert execution just by importing the root factories", () => {
  const seen = resolvedGraph("@mono-agent/turn", "root");
  expect(seen.some((url) => url.endsWith("/src/runtime.js"))).toBe(true);
});
