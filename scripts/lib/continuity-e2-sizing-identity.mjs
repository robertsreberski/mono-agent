// Content-free binding to exactly the source and built app closure used in sizing.
// No rebuild, credential/registry access, provider calls or authorization.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ROOT } from "./continuity-observation-input.mjs";
import { sourceState } from "./memory-e2e-build.mjs";
export async function e2SizingIdentity() {
  const before = sourceState(ROOT);
  const listed = JSON.parse(execFileSync("pnpm", ["--filter", "@mono-agent/app...", "list", "--depth", "-1", "--json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const packages = listed.map(p => relative(ROOT, p.path)).sort(), hash = createHash("sha256");
  if (!packages.includes("packages/app") || packages.some(p => !/^(packages|extras)\/[a-z0-9-]+$/u.test(p))) throw Error("E2_PROTECTED_SIZING_INVALID");
  async function visit(path) {
    const info = await lstat(path);
    if (info.isDirectory()) { for (const name of (await readdir(path)).sort()) await visit(join(path, name)); }
    else if (info.isFile()) { const bytes = await readFile(path); hash.update(JSON.stringify([relative(ROOT, path), bytes.length])); hash.update(bytes); }
    else throw Error("E2_PROTECTED_SIZING_INVALID");
  }
  for (const p of packages) await visit(join(ROOT, p, "dist"));
  const { e2CodeDigest } = await import("./continuity-e2-registration.mjs");
  const codeSha256 = await e2CodeDigest(), after = sourceState(ROOT);
  if (before.head !== after.head || before.dirty !== after.dirty) throw Error("E2_PROTECTED_SIZING_INVALID");
  return { sourceHead: before.head, sourceDirty: before.dirty, codeSha256, buildOutputSha256: hash.digest("hex"), node: process.version };
}

export function assertE2SizingIdentity(before, after) {
  if (!["sourceHead", "sourceDirty", "codeSha256", "buildOutputSha256", "node"].every(key => before[key] === after[key])) throw Error("E2_PROTECTED_SIZING_INVALID");
}

let firstLoadIdentity;
const identityKeys = ["sourceHead", "sourceDirty", "codeSha256", "buildOutputSha256", "node"];
// ESM exposes no complete public cache inventory. Only the direct, preload-free
// CLI process can prove arbitrary product modules were not imported earlier;
// embedded/programmatic runs remain useful estimates but never qualify.
const freshCLI = (() => {
  try {
    return process.execArgv.length === 0 && !(process.env.NODE_OPTIONS ?? "").trim()
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(new URL("../continuity-e2.mjs", import.meta.url)));
  } catch { return false; }
})();
export function pinE2SizingLoadIdentity(identity, modulesAlreadyLoaded) {
  firstLoadIdentity ??= { identity: Object.freeze({ ...identity }), cold: !modulesAlreadyLoaded };
  return freshCLI && firstLoadIdentity.cold && identityKeys.every(k => firstLoadIdentity.identity[k] === identity[k]);
}
