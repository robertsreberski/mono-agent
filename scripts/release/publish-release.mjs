#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./package-graph.mjs";
import { validateRelease } from "./validate-release.mjs";

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function cleanRegistryEnv() {
  return {
    ...process.env,
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
}

function packageVersionExists(pkg) {
  const result = spawnSync(
    "npm",
    ["view", `${pkg.name}@${pkg.version}`, "version", "--json", "--registry", "https://registry.npmjs.org/"],
    { cwd: REPO_ROOT, encoding: "utf8", env: cleanRegistryEnv() },
  );
  if (result.status === 0) return true;

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (output.includes("E404") || output.includes("404 Not Found") || output.includes("could not be found")) {
    return false;
  }
  throw new Error(`npm view failed for ${pkg.name}@${pkg.version}:\n${output.trim()}`);
}

function publishedExportsOf(pkg) {
  const result = spawnSync(
    "npm",
    ["view", `${pkg.name}@${pkg.version}`, "exports", "--json", "--registry", "https://registry.npmjs.org/"],
    { cwd: REPO_ROOT, encoding: "utf8", env: cleanRegistryEnv() },
  );
  if (result.status !== 0) {
    // Could not read the published export map; cannot prove drift, so don't block.
    return undefined;
  }
  const trimmed = (result.stdout || "").trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function exportSubpaths(exportsMap) {
  // A missing or string `exports` field exposes only the main entry (".").
  if (exportsMap === undefined || exportsMap === null || typeof exportsMap === "string") {
    return ["."];
  }
  return Object.keys(exportsMap);
}

/**
 * Compare a local package's export subpaths against the export map already
 * published on npm for the SAME version. npm versions are immutable, so when the
 * publish loop SKIPS an already-published version, any new local subpath (e.g.
 * `@mono-agent/observability` gaining `./run-export`) would never reach the
 * registry — yet a freshly published dependent that imports it resolves against
 * the stale npm copy and breaks at install/runtime. Returns a reason string when
 * the local package exposes a subpath the published one lacks, else undefined.
 * Pure (no I/O) so it is unit-testable; the network read lives in
 * {@link publishedExportsOf}.
 */
export function describePublishedExportsDrift(localPkg, publishedExports) {
  const local = exportSubpaths(localPkg.packageJson?.exports);
  const published = exportSubpaths(publishedExports);
  const missing = local.filter((subpath) => !published.includes(subpath));
  if (missing.length === 0) {
    return undefined;
  }
  return (
    `${localPkg.name}@${localPkg.version} is already published, but the npm copy is missing export ` +
    `subpath(s) present locally: ${missing.join(", ")}. Bump the release version so dependents resolve them.`
  );
}

function publishArgs(pkg, { dryRun }) {
  const args = [
    "--filter",
    pkg.name,
    "publish",
    "--access",
    pkg.publishConfig.access,
    "--no-git-checks",
  ];
  if (dryRun) args.push("--dry-run");
  return args;
}

function runPnpmPublish(pkg, { dryRun }) {
  const args = publishArgs(pkg, { dryRun });
  console.log(`$ pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

async function main() {
  const tag = argValue("--tag") || process.env.GITHUB_REF_NAME;
  const dryRun = hasArg("--dry-run");
  const { publishablePackages } = validateRelease({ tag, silent: true });

  if (!dryRun && !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN) {
    throw new Error("NODE_AUTH_TOKEN or NPM_TOKEN is required to publish");
  }

  for (const pkg of publishablePackages) {
    if (packageVersionExists(pkg)) {
      const drift = describePublishedExportsDrift(pkg, publishedExportsOf(pkg));
      if (drift !== undefined) {
        throw new Error(`Refusing to publish: ${drift}`);
      }
      console.log(`${pkg.name}@${pkg.version} already exists on npm; skipping.`);
      continue;
    }
    runPnpmPublish(pkg, { dryRun });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
