import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

it("kill-worker fixture parking keeps an event-loop handle, not just an unsettled promise", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url)), packages = join(root, "packages"), checked = [], inspected = [];
  async function scan(dir, inTests = false, inFixtures = false) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "coverage", ".git", ".cache"].includes(entry.name)) continue;
        await scan(path, inTests || entry.name === "__tests__", inFixtures || (inTests && entry.name === "fixtures"));
      } else if (inFixtures && /\.(?:mjs|cjs|js|ts)$/u.test(entry.name)) {
        inspected.push(path);
        const source = await readFile(path, "utf8");
        expect(source, path).not.toMatch(/await\s+new\s+Promise\(\(\)\s*=>\s*\{\s*\}\)/u);
        if (source.includes("setInterval")) checked.push(path);
      }
    }
  }
  await scan(packages); await scan(join(root, "extras"));
  expect(inspected).toContain(join(packages, "agent-runtime", "src", "__tests__", "ai", "fixtures", "native-journal-storage-worker.mjs"));
  expect(inspected).toContain(join(packages, "agent-app", "src", "__tests__", "fixtures", "configured-switch-kill.ts"));
  expect(checked.length).toBeGreaterThan(0);
});
