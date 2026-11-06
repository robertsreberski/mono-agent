// Read-only dependency verification and explicit pnpm 11 no-install policy.
import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";

export const PNPM_NO_INSTALL = Object.freeze(["--config.verify-deps-before-run=false", "--config.manage-package-manager-versions=false", "--config.offline=true"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const need = ok => {if (!ok) throw Error("lookup_dependency_lock_mismatch");};
export async function lookupDependencyWitness(root) {
  const lockBytes = await readFile(join(root, "pnpm-lock.yaml")), installed = await readFile(join(root, "node_modules/.pnpm/lock.yaml"));
  need(lockBytes.equals(installed));
  const lock = parse(lockBytes.toString()), manifest = JSON.parse(await readFile(join(root, "package.json")));
  const workspace = parse(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
  need(JSON.stringify(lock.overrides ?? {}) === JSON.stringify(workspace.overrides ?? {}));
  const importer = lock.importers["."], links = [];
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    need(JSON.stringify(Object.keys(manifest[group] ?? {}).sort()) === JSON.stringify(Object.keys(importer[group] ?? {}).sort()));
    for (const [name, entry] of Object.entries(importer[group] ?? {})) {
      need(entry.specifier === (workspace.overrides?.[name] ?? manifest[group][name]));
      const path = await realpath(join(root, "node_modules", name)), pkg = JSON.parse(await readFile(join(path, "package.json")));
      if (entry.version.startsWith("link:")) need(path === await realpath(join(root, entry.version.slice(5))));
      else need(pkg.version === entry.version.split("(")[0]);
      need(pkg.name === name); links.push({name, version: pkg.version, path});
    }
  }
  const metadata = {};
  for (const name of [".modules.yaml", ".pnpm-workspace-state-v1.json", ".package-map.json", ".pnpm/lock.yaml"]) {
    try {const path = join(root, "node_modules", name), stat = await lstat(path, {bigint: true}); metadata[name] = {sha256: hash(await readFile(path)), mtimeNs: String(stat.mtimeNs), ino: String(stat.ino)};}
    catch (error) {if (error.code !== "ENOENT") throw error; metadata[name] = null;}
  }
  return {lockfileSha256: hash(lockBytes), installedLockfileSha256: hash(installed), links, metadata, entries: (await readdir(join(root, "node_modules"))).sort()};
}
