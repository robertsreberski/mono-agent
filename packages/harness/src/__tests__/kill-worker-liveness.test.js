import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

it("kill-worker fixture parking keeps an event-loop handle, not just an unsettled promise", async () => {
  const packages = fileURLToPath(new URL("../../../", import.meta.url)), checked = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (/\.(?:mjs|cjs)$/u.test(entry.name)) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toMatch(/await\s+new\s+Promise\(\(\)\s*=>\s*\{\s*\}\)/u);
        if (source.includes("setInterval")) checked.push(path);
      }
    }
  }
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (entry.isDirectory()) await scan(join(packages, entry.name, "src", "__tests__", "fixtures"));
  }
  expect(checked.length).toBeGreaterThan(0);
});
