#!/usr/bin/env node
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const LEGACY_ENV = path.join("demos", "searxng", ".env");

// This is the last repository-owned Compose contract. The fixed project, service, and volume
// names let an operator re-home an existing deployment without silently creating a parallel one.
const COMPOSE_YAML = `name: mono-agent-searxng

services:
  searxng:
    image: docker.io/searxng/searxng:2026.7.26-b060c780d@sha256:d0aaeb14880e6e92bde1518fcc7261e995783367d63d95203383607bef9c6516
    restart: unless-stopped
    ports:
      - "127.0.0.1:8088:8080"
    environment:
      SEARXNG_BASE_URL: "http://127.0.0.1:8088/"
      SEARXNG_BIND_ADDRESS: "0.0.0.0"
      SEARXNG_IMAGE_PROXY: "false"
      SEARXNG_LIMITER: "false"
      SEARXNG_PORT: "8080"
      SEARXNG_PUBLIC_INSTANCE: "false"
      SEARXNG_SECRET: "\${SEARXNG_SECRET:?The migrated .env must set SEARXNG_SECRET}"
    volumes:
      - "./settings.yml:/etc/searxng/settings.yml:ro"
      - "cache:/var/cache/searxng"
    healthcheck:
      test:
        - CMD
        - python
        - -c
        - >-
          import urllib.request;
          urllib.request.urlopen("http://127.0.0.1:8080/", timeout=3).read(1)
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s

volumes:
  cache:
`;

const SETTINGS_YAML = `use_default_settings:
  engines:
    keep_only:
      - yahoo

general:
  debug: false
  instance_name: "mono-agent local search"

search:
  safe_search: 0
  formats:
    - html
    - json

server:
  secret_key: "overridden-by-SEARXNG_SECRET"
  limiter: false
  public_instance: false
  image_proxy: false
  method: "POST"

outgoing:
  enable_http2: false

engines:
  - name: yahoo
    disabled: false
`;

export function parseArgs(argv) {
  let destination;
  let envFile;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg !== "--destination" && arg !== "--env-file") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a path.`);
    }
    if (arg === "--destination") destination = value;
    else envFile = value;
    index += 1;
  }
  if (destination === undefined) {
    throw new Error("--destination is required.");
  }
  return { help: false, destination, envFile };
}

export function migrateRetiredSearxng({
  repoRoot = REPO_ROOT,
  destination,
  envFile,
  log = console.log,
  beforePublish,
} = {}) {
  if (typeof destination !== "string" || destination.trim().length === 0) {
    throw new Error("destination is required.");
  }
  const absoluteRepoRoot = path.resolve(repoRoot);
  const absoluteDestination = path.resolve(destination);
  const canonicalRepoRoot = realpathSync(absoluteRepoRoot);
  const canonicalDestination = resolveProspectivePath(absoluteDestination);
  if (isWithin(canonicalRepoRoot, canonicalDestination)) {
    throw new Error("Destination must be outside the mono-agent repository.");
  }
  if (entryExists(absoluteDestination)) {
    throw new Error(`Destination already exists: ${absoluteDestination}`);
  }

  const absoluteEnvFile = path.resolve(envFile ?? path.join(absoluteRepoRoot, LEGACY_ENV));
  let envText;
  try {
    envText = readFileSync(absoluteEnvFile, "utf8");
  } catch {
    throw new Error(
      "Legacy SearXNG .env not found. Pass its path with --env-file; no files were written.",
    );
  }
  const secretAssignments = envText
    .split(/\r?\n/u)
    .filter((line) => /^SEARXNG_SECRET=/u.test(line));
  const secret = secretAssignments.length === 1
    ? secretAssignments[0].match(/^SEARXNG_SECRET=([0-9a-f]{64})$/iu)?.[1]
    : undefined;
  if (secret === undefined) {
    throw new Error(
      "Legacy SearXNG .env must contain exactly one 64-hex SEARXNG_SECRET; no files were written.",
    );
  }

  const parent = path.dirname(absoluteDestination);
  const staging = path.join(parent, `.${path.basename(absoluteDestination)}.migrating-${randomUUID()}`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalDestinationAfterMkdir = path.join(realpathSync(parent), path.basename(absoluteDestination));
  if (canonicalDestinationAfterMkdir !== canonicalDestination
    || isWithin(canonicalRepoRoot, canonicalDestinationAfterMkdir)) {
    throw new Error("Destination path changed or resolves inside the mono-agent repository.");
  }
  let stagingCreated = false;
  let destinationCreated = false;
  try {
    mkdirSync(staging, { mode: 0o700 });
    stagingCreated = true;
    writeFileSync(path.join(staging, "compose.yaml"), COMPOSE_YAML, { mode: 0o644 });
    writeFileSync(path.join(staging, "settings.yml"), SETTINGS_YAML, { mode: 0o644 });
    writeFileSync(path.join(staging, ".env"), `SEARXNG_SECRET=${secret}\n`, { mode: 0o600 });
    beforePublish?.();
    try {
      mkdirSync(absoluteDestination, { mode: 0o700 });
      destinationCreated = true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`Destination already exists: ${absoluteDestination}`);
      }
      throw error;
    }
    for (const filename of ["compose.yaml", "settings.yml", ".env"]) {
      renameSync(path.join(staging, filename), path.join(absoluteDestination, filename));
    }
    rmSync(staging, { recursive: true, force: true });
    stagingCreated = false;
  } catch (error) {
    if (destinationCreated) rmSync(absoluteDestination, { recursive: true, force: true });
    if (stagingCreated) rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  log(`Migrated the retired SearXNG Compose files to ${absoluteDestination}.`);
  log("No container was started or stopped, and no Docker volume was removed.");
  return {
    destination: absoluteDestination,
    projectName: "mono-agent-searxng",
    volumeName: "mono-agent-searxng_cache",
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveProspectivePath(candidate) {
  let existingAncestor = candidate;
  const missingComponents = [];
  while (!entryExists(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Could not resolve destination ancestor for ${candidate}.`);
    }
    missingComponents.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  return path.join(realpathSync(existingAncestor), ...missingComponents);
}

function entryExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function usage() {
  const bin = fileURLToPath(import.meta.url);
  return [
    "Usage:",
    `  node ${bin} --destination <operator-directory> [--env-file <legacy-env>]`,
    "",
    "Copies the retired SearXNG Compose contract and one validated 64-hex secret into a new",
    "operator-owned directory. The destination must resolve outside this repository and must",
    "not already exist; the emitted .env contains no other legacy or Compose control variables.",
    "This command never invokes Docker, stops a service, or removes a volume.",
  ].join("\n");
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      migrateRetiredSearxng(parsed);
    }
  } catch (error) {
    process.stderr.write(`${reasonOf(error)}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}
