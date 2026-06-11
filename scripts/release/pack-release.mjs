#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./package-graph.mjs";
import { validateRelease } from "./validate-release.mjs";

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function runPnpmPack(pkg) {
  const args = ["--dir", pkg.relativeDir, "pack", "--dry-run", "--json"];
  console.log(`$ pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }

  const packed = JSON.parse(result.stdout);
  const files = new Set((packed.files || []).map((file) => file.path));
  const missing = ["package.json", "README.md"].filter((file) => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`${pkg.name} pack output is missing ${missing.join(", ")}`);
  }

  console.log(`${packed.name}@${packed.version}: ${packed.files.length} files`);
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
    process.exit(1);
  });
}
