#!/usr/bin/env node
/**
 * Build every workspace in topological dependency order.
 *
 * `npm run build --workspaces` runs alphabetically, which fails when a
 * dependent (e.g. config-ui-demo) is built before its dependency
 * (config-ui) has emitted dist/. This script computes the @worklab-ai/*
 * dependency graph from each package.json and runs the build script in
 * Kahn-topological order so a fresh `npm ci && npm run build` works
 * first time without manual ordering.
 *
 * Skips packages that have no `build` script. Forwards `--script <name>`
 * so the same helper can drive `typecheck` and `test` if desired.
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const packagesDir = resolve(repoRoot, "packages");

const args = process.argv.slice(2);
const scriptIndex = args.indexOf("--script");
const script = scriptIndex >= 0 ? args[scriptIndex + 1] : "build";

const SCOPE_PREFIX = "@worklab-ai/";

/**
 * Read every workspace's package.json and return a map keyed by package name.
 */
function loadWorkspaces() {
  const entries = readdirSync(packagesDir, { withFileTypes: true });
  const out = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const pkgPath = join(dir, "package.json");
    let pkg;
    try {
      statSync(pkgPath);
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof pkg.name !== "string") continue;
    out.set(pkg.name, {
      name: pkg.name,
      dir,
      dirName: entry.name,
      hasScript: Boolean(pkg.scripts && typeof pkg.scripts[script] === "string"),
      deps: collectWorkspaceDeps(pkg),
    });
  }
  return out;
}

function collectWorkspaceDeps(pkg) {
  const merged = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  const out = new Set();
  for (const dep of Object.keys(merged)) {
    if (dep.startsWith(SCOPE_PREFIX)) {
      out.add(dep);
    }
  }
  return out;
}

/**
 * Kahn's algorithm — produce a stable topological order. Packages with
 * unresolved local deps come last; alphabetical break ties so the
 * order is deterministic.
 */
function topologicalOrder(workspaces) {
  const ordered = [];
  const remaining = new Map();
  for (const ws of workspaces.values()) {
    // Only count deps that exist in our workspace map; external deps
    // (e.g. @worklab-ai/agent-runtime which is published) don't block us.
    const resolved = new Set();
    for (const dep of ws.deps) {
      if (workspaces.has(dep)) resolved.add(dep);
    }
    remaining.set(ws.name, resolved);
  }
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      const cycle = [...remaining.keys()].join(", ");
      throw new Error(`Cyclic workspace dependencies among: ${cycle}`);
    }
    for (const name of ready) {
      ordered.push(workspaces.get(name));
      remaining.delete(name);
      for (const deps of remaining.values()) {
        deps.delete(name);
      }
    }
  }
  return ordered;
}

function main() {
  const workspaces = loadWorkspaces();
  const ordered = topologicalOrder(workspaces);
  const runnable = ordered.filter((ws) => ws.hasScript);
  if (runnable.length === 0) {
    console.log(`No workspaces have a "${script}" script — nothing to do.`);
    return;
  }
  console.log(
    `Running "${script}" across ${runnable.length} workspace(s) in topological order:`,
  );
  for (const ws of runnable) {
    console.log(`  - ${ws.name}`);
  }
  for (const ws of runnable) {
    console.log(`\n→ ${ws.name} (${ws.dirName}): npm run ${script}`);
    execSync(`npm run ${script} --workspace=${ws.name}`, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
