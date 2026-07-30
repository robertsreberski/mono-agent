#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./package-graph.mjs";
import { validateRelease } from "./validate-release.mjs";

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

export function parsePnpmPackOutput(stdout) {
  const output = stdout.trim();
  if (!output) {
    throw new Error("pnpm pack did not return JSON output");
  }

  // pnpm 10 writes prepack lifecycle output before the JSON document, whereas
  // pnpm 11 emits only JSON for the same `pack --json` command. The JSON object
  // or array begins at column zero; nested values are indented. pnpm also emits
  // diagnostics at column zero that open with the same bracket a JSON array does
  // (`[WARN] This project is configured to use …`), so the first candidate is not
  // necessarily the document — take the first one that actually parses.
  const packed = parseFirstJsonDocument(output);
  if (packed === undefined) {
    throw new Error("pnpm pack did not return JSON output");
  }
  if (Array.isArray(packed)) {
    if (packed.length !== 1) {
      throw new Error(`expected one pnpm pack result; received ${packed.length}`);
    }
    return packed[0];
  }

  return packed;
}

function parseFirstJsonDocument(output) {
  for (const match of output.matchAll(/^[{[]/gmu)) {
    try {
      return JSON.parse(output.slice(match.index));
    } catch {
      // Not the document — keep looking past this line's opening bracket.
    }
  }
  return undefined;
}

function tarballPathFromPackResult(packed, packDestination) {
  if (!packed.filename || typeof packed.filename !== "string") {
    throw new Error(`${packed.name || "package"} pack output did not report a tarball filename`);
  }

  return path.isAbsolute(packed.filename)
    ? packed.filename
    : path.join(packDestination, packed.filename);
}

const BUILD_ARTIFACT_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts", ".js", ".mjs", ".cjs"];
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];
const SOURCE_MAP_SUFFIX = ".map";
const DIST_PREFIX = "dist/";

/**
 * Packed compiled output whose source no longer exists under `src/`.
 *
 * `dist/` is gitignored and no build step clears it, so deleting a source leaves its old
 * `.js`/`.d.ts` behind and `pnpm pack` ships it: @mono-agent/telegram-adapter@0.15.3 published
 * `dist/ask.js` two releases after `src/ask.ts` was removed. Dead output is not merely untidy —
 * it makes greps, audits, and dead-code sweeps report a surface that no longer exists.
 *
 * Only tsc-shaped emit is considered. `webapp/dist` bundles (hashed names, no one-to-one
 * source) sit outside `dist/`, and packages with no `src/` are skipped entirely.
 */
export function orphanedBuildArtifacts(packageDir, filePaths) {
  const sourceDir = path.join(packageDir, "src");
  if (!fs.existsSync(sourceDir)) {
    return [];
  }

  const orphans = [];
  for (const filePath of filePaths) {
    if (!filePath.startsWith(DIST_PREFIX)) continue;
    const emitted = filePath.endsWith(SOURCE_MAP_SUFFIX)
      ? filePath.slice(0, -SOURCE_MAP_SUFFIX.length)
      : filePath;
    const extension = BUILD_ARTIFACT_EXTENSIONS.find((candidate) => emitted.endsWith(candidate));
    if (extension === undefined) continue;
    const stem = emitted.slice(DIST_PREFIX.length, -extension.length);
    const hasSource = SOURCE_EXTENSIONS.some(
      (candidate) => fs.existsSync(path.join(sourceDir, `${stem}${candidate}`)),
    );
    if (!hasSource) {
      orphans.push(filePath);
    }
  }
  return orphans;
}

export function assertPackResult(pkg, packed, packDestination, options = {}) {
  const files = new Set((packed.files || []).map((file) => file.path));
  const requiredFiles = ["package.json", "README.md"];
  if (pkg.name === "@mono-agent/web") {
    requiredFiles.push("webapp/dist/index.html");
  }
  const missing = requiredFiles.filter((file) => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`${pkg.name} pack output is missing ${missing.join(", ")}`);
  }

  const packageDir = options.packageDir ?? path.join(REPO_ROOT, pkg.relativeDir);
  const orphans = orphanedBuildArtifacts(packageDir, files);
  if (orphans.length > 0) {
    throw new Error(
      `${pkg.name} pack output ships build artifacts with no source: ${orphans.join(", ")}. `
      + "Run `pnpm run clean && pnpm run build`, then pack again.",
    );
  }

  const tarballPath = tarballPathFromPackResult(packed, packDestination);
  let stats;
  try {
    stats = fs.statSync(tarballPath);
  } catch (error) {
    throw new Error(`${pkg.name} pack output did not create ${tarballPath}`);
  }

  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`${pkg.name} pack output created an empty tarball at ${tarballPath}`);
  }

  return {
    fileCount: packed.files.length,
    tarballPath,
    tarballSize: stats.size,
  };
}

export function packReleasePackage(pkg, packDestination, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const log = options.log ?? console.log;
  const args = ["--dir", pkg.relativeDir, "pack", "--pack-destination", packDestination, "--json"];
  log(`$ pnpm ${args.join(" ")}`);
  const result = spawn("pnpm", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    const error = new Error(`${pkg.name} pnpm pack failed`);
    error.exitCode = result.status || 1;
    throw error;
  }

  const packed = parsePnpmPackOutput(result.stdout);
  const details = assertPackResult(pkg, packed, packDestination);
  log(`${packed.name}@${packed.version}: ${details.fileCount} files, ${path.basename(details.tarballPath)} (${details.tarballSize} bytes)`);
  return { ...details, name: packed.name, version: packed.version };
}

function runPnpmPack(pkg) {
  const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-pack-"));
  try {
    packReleasePackage(pkg, packDestination);
  } finally {
    fs.rmSync(packDestination, { recursive: true, force: true });
  }
}

async function main() {
  const tag = argValue("--tag") || process.env.GITHUB_REF_NAME;
  const { publishablePackages } = validateRelease({ tag, silent: true });

  for (const pkg of publishablePackages) {
    runPnpmPack(pkg);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(err.exitCode || 1);
  });
}
