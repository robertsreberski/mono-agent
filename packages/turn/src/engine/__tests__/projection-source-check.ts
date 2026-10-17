import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function findContextBuilderBypasses(root: string) {
  const files: string[] = [];
  async function scan(path: string) {
    let children;
    try { children = await readdir(path, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const child of children) {
      if (["__tests__", "node_modules", "dist"].includes(child.name)) continue;
      const file = join(path, child.name);
      if (child.isDirectory()) await scan(file);
      else if (/\.(?:[cm]?js|tsx?)$/.test(child.name)) files.push(file);
    }
  }
  for (const parent of ["packages", "extras"]) {
    let children;
    try { children = await readdir(join(root, parent), { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const child of children) if (child.isDirectory()) await scan(join(root, parent, child.name, "src"));
  }
  await scan(join(root, "apps"));
  // Match the staged build's bounded product inventory, without hiding files
  // another suite may still be importing. A twin alone does not grant ownership.
  let inventory = "";
  try { inventory = await readFile(join(root, "packages/turn/.gitignore"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const owned = new Set(inventory.split("\n").filter((line) => /^\/src\/(?:[\w-]+\/)*[\w-]+\.(?:d\.ts|js(?:\.map)?)$/.test(line))
    .map((line) => `packages/turn${line}`));
  const authored = new Set(files.map((file) => relative(root, file).split("\\").join("/")));
  const bypasses = [];
  for (const file of files) {
    const path = relative(root, file).split("\\").join("/");
    if (owned.has(path) && (path.endsWith(".d.ts") || (path.endsWith(".js") && authored.has(path.slice(0, -3) + ".ts")))) continue;
    if (/^packages\/turn\/src\/engine\/(?:session-context|request-projection)\.(?:js|ts)$/.test(path)) continue;
    let text = await readFile(file, "utf8");
    if (/^packages\/turn\/src\/(?:engine\/index|execution\/pi\/driver-adapter)\.(?:js|ts)$/.test(path)) {
      text = text.replace(/export \{ buildHarnessSessionContext \} from [^;]+;/g, "");
    }
    if (/\bbuildHarnessSessionContext\b/.test(text)) bypasses.push(path);
  }
  return bypasses.sort();
}
