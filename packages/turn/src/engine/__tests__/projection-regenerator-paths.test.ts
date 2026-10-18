import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// Execute only mocked filesystem/child calls, never the manual golden writer.
it.each(["src", "dist"])("keeps the %s regenerator's data and compiled worker rooted in the repository", async (view) => {
  const root = "/fictional/turn-repository/";
  const scratch = join(root, ".worklab-tmp", ".p3a-golden-base-fixture");
  const calls: Array<[string, ...unknown[]]> = [];
  const key = `turn-regenerator-paths-${view}`;
  const fake = {
    execFileSync(command: string, args: string[], options: { cwd: string }) {
      calls.push([command, args, options]);
      return command === process.execPath
        ? JSON.stringify({ runtime: { recovery: { recovered: true }, midRun: { requests: [{}, {}] } } })
        : Buffer.from("fixture archive");
    },
    async mkdir(...args: unknown[]) { calls.push(["mkdir", ...args]); },
    async mkdtemp(prefix: string) { calls.push(["mkdtemp", prefix]); return scratch; },
    async copyFile(...args: unknown[]) { calls.push(["copyFile", ...args]); },
    async symlink(...args: unknown[]) { calls.push(["symlink", ...args]); },
    async writeFile(...args: unknown[]) { calls.push(["writeFile", ...args]); },
    async rm(...args: unknown[]) { calls.push(["rm", ...args]); },
  };
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  globals[key] = fake;
  const mock = (names: string[]) => "data:text/javascript," + encodeURIComponent(names.map((name) => `export const ${name} = globalThis[${JSON.stringify(key)}].${name};`).join("\n"));
  const original = readFileSync(new URL("./fixtures/regenerate-projection-goldens.mjs", import.meta.url), "utf8");
  try {
    for (const needle of ['"node:child_process"', '"node:fs/promises"', 'import.meta.resolve("@mono-agent/turn/engine")']) {
      expect(original.split(needle), `single source replacement: ${needle}`).toHaveLength(2);
    }
    const source = original
      .replace('"node:child_process"', JSON.stringify(mock(["execFileSync"])))
      .replace('"node:fs/promises"', JSON.stringify(mock(["mkdir", "mkdtemp", "copyFile", "symlink", "writeFile", "rm"])))
      .replace('import.meta.resolve("@mono-agent/turn/engine")', JSON.stringify(pathToFileURL(join(root, "packages/turn", view, "engine/index.js")).href));
    await import("data:text/javascript," + encodeURIComponent(source));
    expect(calls.find(([name]) => name === "mkdtemp")).toEqual(["mkdtemp", join(root, ".worklab-tmp", ".p3a-golden-base-")]);
    const fixtures = join(root, "packages/turn/src/engine/__tests__/fixtures");
    const historicalRoots = [...new Set([...source.matchAll(/"(packages\/[^" ]+\/src)"/gu)].map((match) => join(scratch, match[1]!)))];
    expect(historicalRoots).toHaveLength(2);
    for (const version of [3, 4]) {
      const legacy = join(fixtures, `legacy-v${version}.jsonl`);
      expect(calls).toContainEqual(["copyFile", legacy, `${scratch}/storage-${version}-import/legacy/fixture_fixture-session.jsonl`]);
      const child = calls.filter(([name]) => name === process.execPath)[version - 3]!;
      expect(child[1]).toEqual(["--no-warnings", join(root, ".worklab-tmp/turn-test-fixtures/engine/__tests__/fixtures/projection-parity-worker.mjs"), ...historicalRoots, join(scratch, `storage-${version}`), legacy]);
      expect(child[2]).toMatchObject({ cwd: root });
      expect(calls.filter(([name]) => name === "writeFile").map((call) => call[1])).toContain(join(fixtures, `projection-golden-v${version}.json`));
    }
    expect(calls.at(-1)).toEqual(["rm", scratch, { recursive: true, force: true }]);
  } finally { delete globals[key]; }
});
