import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function findContextBuilderBypasses(root) {
  const files = [];
  async function scan(path) {
    let children;
    try { children = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const child of children) {
      if (["__tests__", "node_modules", "dist"].includes(child.name)) continue;
      const file = join(path, child.name);
      if (child.isDirectory()) await scan(file);
      else if (/\.(?:[cm]?js|tsx?)$/.test(child.name)) files.push(file);
    }
  }
  for (const parent of ["packages", "extras"]) {
    let children;
    try { children = await readdir(join(root, parent), { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const child of children) if (child.isDirectory()) await scan(join(root, parent, child.name, "src"));
  }
  await scan(join(root, "apps"));
  const bypasses = [];
  for (const file of files) {
    const path = relative(root, file).split("\\").join("/");
    if (["packages/harness/src/session-context.js", "packages/harness/src/request-projection.js"].includes(path)) continue;
    let text = await readFile(file, "utf8");
    if (["packages/harness/src/index.js", "packages/agent-runtime/src/ai/providers/pi-native/harness-adapter.js"].includes(path)) {
      text = text.replace(/export \{ buildHarnessSessionContext \} from [^;]+;/g, "");
    }
    if (/\bbuildHarnessSessionContext\b/.test(text)) bypasses.push(path);
  }
  return bypasses.sort();
}
