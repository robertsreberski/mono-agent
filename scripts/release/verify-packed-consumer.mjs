#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MINIMUM_NODE_VERSION, SUPPORTED_NODE_ENGINE } from "../node-version.mjs";
import { packReleasePackage } from "./pack-release.mjs";
import { REPO_ROOT } from "./package-graph.mjs";
import { validateRelease } from "./validate-release.mjs";

const CONSUMER_FIXTURE = path.join(REPO_ROOT, "scripts", "release", "fixtures", "packed-consumer");

export function parsePackedConsumerArgs(argv) {
  let tag = process.env.GITHUB_REF_NAME ?? null;
  let requireMinimum = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--tag") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--tag requires a value.");
      }
      tag = value;
      index += 1;
      continue;
    }
    if (arg === "--require-minimum") {
      requireMinimum = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { tag, requireMinimum };
}

export function assertMinimumNodeRuntime(actual = process.versions.node) {
  if (actual !== MINIMUM_NODE_VERSION) {
    throw new Error(
      `Minimum-version proof must run on Node.js ${MINIMUM_NODE_VERSION}; current Node.js is ${actual}.`,
    );
  }
}

export function buildPackedConsumerManifest(template, packedPackages) {
  if (template.engines?.node !== SUPPORTED_NODE_ENGINE) {
    throw new Error(`Packed consumer template engines.node must be ${SUPPORTED_NODE_ENGINE}.`);
  }
  return {
    ...template,
    dependencies: Object.fromEntries(
      [...packedPackages]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((pkg) => [pkg.name, `file:${pkg.tarballPath}`]),
    ),
  };
}

export function runPackedConsumerVerification(options = {}) {
  const parsed = options.parsed ?? parsePackedConsumerArgs(process.argv.slice(2));
  if (parsed.requireMinimum) assertMinimumNodeRuntime();

  const { publishablePackages, version } = validateRelease({ tag: parsed.tag, silent: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-packed-consumer-"));
  const tarballDir = path.join(temporaryRoot, "tarballs");
  const consumerDir = path.join(temporaryRoot, "consumer");
  fs.mkdirSync(tarballDir);
  fs.cpSync(CONSUMER_FIXTURE, consumerDir, { recursive: true });

  try {
    const packedPackages = publishablePackages.map((pkg) =>
      packReleasePackage(pkg, tarballDir, options.packOptions));
    const templatePath = path.join(consumerDir, "package.json");
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    const consumerManifest = buildPackedConsumerManifest(template, packedPackages);
    fs.writeFileSync(templatePath, `${JSON.stringify(consumerManifest, null, 2)}\n`);

    run("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false"], consumerDir, options.spawn);
    run("npm", ["run", "smoke"], consumerDir, options.spawn);
    console.log(
      `Packed consumer installed ${packedPackages.length} mono-agent ${version} tarballs on Node.js ${process.versions.node}.`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function run(command, args, cwd, spawn = spawnSync) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawn(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_engine_strict: "true",
    },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(" ")} failed`);
    error.exitCode = result.status || 1;
    throw error;
  }
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  try {
    runPackedConsumerVerification();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.exitCode || 1;
  }
}
