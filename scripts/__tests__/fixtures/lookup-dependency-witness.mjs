// Read-only witness for tests that build in synthetic workspaces.
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function dependencySnapshot(root) {
  const modules = join(root, "node_modules"), info = await lstat(modules);
  const metadata = {};
  for (const name of [".modules.yaml", ".pnpm-workspace-state-v1.json"]) {
    try {
      const path = join(modules, name), stat = await lstat(path, { bigint: true });
      metadata[name] = { bytes: await readFile(path), mtimeNs: stat.mtimeNs };
    } catch (error) { if (error.code !== "ENOENT") throw error; metadata[name] = null; }
  }
  let vitest = true;
  try { await access(join(modules, ".bin/vitest")); }
  catch (error) { if (error.code !== "ENOENT") throw error; vitest = false; }
  return { directory: info.isDirectory(), entries: (await readdir(modules)).sort(), metadata, vitest };
}
