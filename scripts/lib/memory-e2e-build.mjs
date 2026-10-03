import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";

export const BUILD_POLICY = "fresh-clean-head-agent-app-closure-v1";
const FILTER = "@mono-agent/agent-app...";
const BUILD_ARGS = ["--filter", FILTER, "run", "build"];

export function sourceState(root, exec = execFileSync) {
  const git = (args) => exec("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { head: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain=v1"]).length > 0 };
}
export function assertSource(root, head, exec = execFileSync) {
  const state = sourceState(root, exec);
  if (state.head !== head || state.dirty) throw new Error("build_source_changed_or_dirty");
}

async function outputDigest(root, outputRoots) {
  const hash = createHash("sha256");
  const visit = async (path) => {
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (info.isFile()) {
      const bytes = await readFile(path);
      hash.update(JSON.stringify([relative(root, path), bytes.length])); hash.update(bytes);
    } else throw new Error("unsafe_build_output");
  };
  for (const path of outputRoots) await visit(join(root, path));
  return hash.digest("hex");
}

/** The direct real entrypoint always rebuilds; ignored dist is never source evidence. */
export async function prepareRealBuild(root, head, { exec = execFileSync } = {}) {
  assertSource(root, head, exec);
  const listed = JSON.parse(exec("pnpm", ["--filter", FILTER, "list", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const packages = listed.map((entry) => relative(root, entry.path)).sort();
  if (!packages.includes("packages/agent-app") || new Set(packages).size !== packages.length) throw new Error("invalid_build_closure");
  for (const path of packages) {
    if (!/^(packages|extras)\/[a-z0-9-]+$/u.test(path) || await realpath(join(root, path)) !== join(root, path)) throw new Error("unsafe_build_closure");
  }
  // agent-runtime ships tracked JavaScript and generates declarations in types/;
  // the other app-closure packages compile to dist/. Source HEAD pins that JS.
  const outputRoots = packages.map((path) => `${path}/${path === "packages/agent-runtime" ? "types" : "dist"}`);
  assertSource(root, head, exec);
  // tsc does not remove deleted-source outputs. Clean only this dependency closure's
  // generated dist/types, never benchmark artifacts or unrelated workspace outputs.
  for (const path of outputRoots) await rm(join(root, path), { recursive: true, force: true });
  exec("pnpm", BUILD_ARGS, { cwd: root, timeout: 120000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  assertSource(root, head, exec);
  const build = { policy: BUILD_POLICY, sourceHead: head, command: ["pnpm", ...BUILD_ARGS], packages, outputRoots, outputSha256: await outputDigest(root, outputRoots), node: process.version };
  assertSource(root, head, exec);
  return build;
}

export async function verifyRealBuild(root, build, { exec = execFileSync } = {}) {
  assertSource(root, build.sourceHead, exec);
  if (await outputDigest(root, build.outputRoots) !== build.outputSha256) throw new Error("build_output_changed");
  assertSource(root, build.sourceHead, exec);
}
