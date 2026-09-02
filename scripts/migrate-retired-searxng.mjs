#!/usr/bin/env node
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
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
  beforeAtomicPublish,
  afterAtomicPublish,
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

  const lexicalParent = path.dirname(absoluteDestination);
  mkdirSync(lexicalParent, { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync(lexicalParent);
  const destinationName = path.basename(absoluteDestination);
  const stableDestination = path.join(canonicalParent, destinationName);
  if (stableDestination !== canonicalDestination
    || isWithin(canonicalRepoRoot, stableDestination)) {
    throw new Error("Destination path changed or resolves inside the mono-agent repository.");
  }
  const parentIdentity = secureDirectoryIdentity(canonicalParent, "destination parent");
  const assertStableCanonicalParent = () => assertSecureDirectoryIdentity(
    canonicalParent,
    parentIdentity,
    "Destination parent changed after validation; no bundle was published.",
    canonicalParent,
  );
  const assertDestinationBoundary = () => {
    assertStableCanonicalParent();
    const currentDestination = resolveProspectivePath(absoluteDestination);
    if (currentDestination !== stableDestination
      || isWithin(canonicalRepoRoot, currentDestination)) {
      throw new Error("Destination path changed or resolves inside the mono-agent repository.");
    }
  };

  assertDestinationBoundary();
  if (entryExists(stableDestination)) {
    if (isCompletedBundle(stableDestination, secret)) {
      return completedResult(absoluteDestination, log, "Verified the already completed");
    }
    throw new Error(`Destination already exists: ${absoluteDestination}`);
  }

  const staging = path.join(
    canonicalParent,
    `.${destinationName}.migrating-${randomUUID()}`,
  );
  let stagingCreated = false;
  let stagingIdentity;
  let published = false;
  let wonPublication = false;
  try {
    assertDestinationBoundary();
    mkdirSync(staging, { mode: 0o700 });
    stagingCreated = true;
    chmodSync(staging, 0o700);
    stagingIdentity = secureDirectoryIdentity(staging, "private staging directory");
    const assertPrivateStaging = () => {
      assertDestinationBoundary();
      assertSecureDirectoryIdentity(
        staging,
        stagingIdentity,
        "Private migration bundle changed before publication.",
        staging,
      );
    };

    // This seam runs while the private directory is still empty. A parent-path
    // swap therefore fails before the secret or any runnable bundle is written.
    beforePublish?.();
    assertPrivateStaging();
    if (readdirSync(staging).length !== 0) {
      throw new Error("Private migration staging directory is no longer empty.");
    }
    writeStagedFile(staging, "compose.yaml", COMPOSE_YAML, 0o644, assertPrivateStaging);
    writeStagedFile(staging, "settings.yml", SETTINGS_YAML, 0o644, assertPrivateStaging);
    writeStagedFile(
      staging,
      ".env",
      `SEARXNG_SECRET=${secret}\n`,
      0o600,
      assertPrivateStaging,
    );
    assertPrivateStaging();
    assertCompleteBundle(staging, secret);

    beforeAtomicPublish?.();
    assertPrivateStaging();
    assertCompleteBundle(staging, secret);
    if (entryExists(stableDestination)) {
      if (!isCompletedBundle(stableDestination, secret)) {
        throw new Error(`Destination already exists: ${absoluteDestination}`);
      }
      cleanupPrivateStaging(staging, stagingIdentity, assertStableCanonicalParent);
      stagingCreated = false;
      return completedResult(absoluteDestination, log, "Accepted the concurrently completed");
    }

    try {
      // The destination is published exactly once. A whole-directory rename
      // does not follow a raced destination symlink and never exposes a partial
      // bundle; a normal concurrent loser validates the non-empty winner below.
      renameSync(staging, stableDestination);
      stagingCreated = false;
      published = true;
      wonPublication = true;
    } catch (error) {
      if (!isCompletedBundle(stableDestination, secret)) throw error;
      cleanupPrivateStaging(staging, stagingIdentity, assertStableCanonicalParent);
      stagingCreated = false;
      published = true;
    }

    afterAtomicPublish?.();
    assertDestinationBoundary();
    if (wonPublication) {
      assertSecureDirectoryIdentity(
        stableDestination,
        stagingIdentity,
        "Published migration bundle changed identity.",
        stableDestination,
      );
    }
    assertCompleteBundle(stableDestination, secret);
  } catch (error) {
    if (!published && stagingCreated && stagingIdentity !== undefined) {
      cleanupPrivateStaging(staging, stagingIdentity, assertStableCanonicalParent);
    }
    throw error;
  }

  return completedResult(absoluteDestination, log, "Migrated the retired");
}

function writeStagedFile(directory, filename, content, mode, assertPrivateStaging) {
  assertPrivateStaging();
  const file = path.join(directory, filename);
  const descriptor = openSync(file, "wx", mode);
  try {
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupPrivateStaging(staging, stagingIdentity, assertStableCanonicalParent) {
  try {
    assertStableCanonicalParent();
    assertSecureDirectoryIdentity(
      staging,
      stagingIdentity,
      "Private staging directory changed before cleanup.",
      staging,
    );
    rmSync(staging, { recursive: true, force: true });
  } catch {
    // Never redirect cleanup through a changed canonical parent or staging path.
  }
}

function assertCompleteBundle(directory, secret) {
  const expected = new Map([
    [".env", { content: `SEARXNG_SECRET=${secret}\n`, mode: 0o600 }],
    ["compose.yaml", { content: COMPOSE_YAML, mode: 0o644 }],
    ["settings.yml", { content: SETTINGS_YAML, mode: 0o644 }],
  ]);
  const directoryDetails = lstatSync(directory);
  if (!directoryDetails.isDirectory()
    || directoryDetails.isSymbolicLink()
    || (directoryDetails.mode & 0o777) !== 0o700) {
    throw new Error("Migration bundle directory permissions or type changed.");
  }
  const entries = readdirSync(directory).sort();
  if (entries.join("\0") !== [...expected.keys()].sort().join("\0")) {
    throw new Error("Private migration bundle is incomplete or contains unexpected entries.");
  }
  for (const [filename, { content, mode }] of expected) {
    const file = path.join(directory, filename);
    const details = lstatSync(file);
    if (!details.isFile()
      || details.isSymbolicLink()
      || (details.mode & 0o777) !== mode
      || readFileSync(file, "utf8") !== content) {
      throw new Error(`Migration bundle file changed: ${filename}`);
    }
  }
}

function isCompletedBundle(destination, secret) {
  try {
    secureDirectoryIdentity(destination, "completed migration destination");
    assertCompleteBundle(destination, secret);
    return true;
  } catch {
    return false;
  }
}

function completedResult(destination, log, action) {
  log(`${action} SearXNG Compose files at ${destination}.`);
  log("No container was started or stopped, and no Docker volume was removed.");
  return {
    destination,
    projectName: "mono-agent-searxng",
    volumeName: "mono-agent-searxng_cache",
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function secureDirectoryIdentity(candidate, label) {
  let details;
  try {
    details = lstatSync(candidate);
  } catch {
    throw new Error(`Could not inspect ${label}: ${candidate}`);
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${candidate}`);
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user: ${candidate}`);
  }
  if ((details.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable: ${candidate}`);
  }
  return { dev: details.dev, ino: details.ino };
}

function assertSecureDirectoryIdentity(candidate, expected, message, expectedCanonicalPath) {
  let details;
  let canonical;
  try {
    details = lstatSync(candidate);
    canonical = realpathSync(candidate);
  } catch {
    throw new Error(message);
  }
  if (details.isSymbolicLink()
    || !details.isDirectory()
    || details.dev !== expected.dev
    || details.ino !== expected.ino
    || canonical !== expectedCanonicalPath
    || (details.mode & 0o022) !== 0
    || (typeof process.getuid === "function" && details.uid !== process.getuid())) {
    throw new Error(message);
  }
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
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

function usage() {
  const bin = fileURLToPath(import.meta.url);
  return [
    "Usage:",
    `  node ${bin} --destination <operator-directory> [--env-file <legacy-env>]`,
    "",
    "Copies the retired SearXNG Compose contract and one validated 64-hex secret into a new",
    "operator-owned directory outside this repository. An existing destination is accepted only",
    "when it is the exact completed bundle from an earlier run. The emitted .env contains no",
    "other legacy or Compose control variables.",
    "The canonical parent must be current-user owned and not group/world writable.",
    "A complete private sibling is renamed once; an exact completed destination is idempotent.",
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
