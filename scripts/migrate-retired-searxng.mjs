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
const DEFAULT_GET_CURRENT_UID = typeof process.getuid === "function"
  ? process.getuid.bind(process)
  : undefined;

class RetiredSearxngStagingCleanupError extends Error {
  constructor({ destination, stagingPath, cleanup }) {
    super(
      `A valid SearXNG bundle is published at ${destination}, but private staging cleanup `
      + `reported an anomaly. ${describeStagingState(cleanup.status, stagingPath)}`,
      { cause: cleanup.cause },
    );
    this.name = "RetiredSearxngStagingCleanupError";
    this.code = "SEARXNG_STAGING_CLEANUP_FAILED";
    this.published = true;
    this.destination = destination;
    this.stagingPath = stagingPath;
    this.stagingState = cleanup.status;
    this.cleanupCause = cleanup.cause;
    this.inspectionCause = cleanup.inspectionCause;
  }
}

class RetiredSearxngUnpublishedStagingCleanupError extends AggregateError {
  constructor({ destination, stagingPath, operationCause, cleanup }) {
    const causes = [operationCause, cleanup.cause];
    if (cleanup.inspectionCause !== undefined) causes.push(cleanup.inspectionCause);
    super(
      causes,
      `The SearXNG migration did not publish a bundle at ${destination}, and private staging `
      + `cleanup reported an anomaly. ${describeStagingState(cleanup.status, stagingPath)}`,
      { cause: operationCause },
    );
    this.name = "RetiredSearxngUnpublishedStagingCleanupError";
    this.code = "SEARXNG_UNPUBLISHED_STAGING_CLEANUP_FAILED";
    this.published = false;
    this.destination = destination;
    this.stagingPath = stagingPath;
    this.stagingState = cleanup.status;
    this.operationCause = operationCause;
    this.cleanupCause = cleanup.cause;
    this.inspectionCause = cleanup.inspectionCause;
  }
}

class RetiredSearxngDestinationRevalidationError extends AggregateError {
  constructor({ destination, stagingPath, destinationCause, cleanup }) {
    const causes = [destinationCause];
    if (cleanup.cause !== undefined) causes.push(cleanup.cause);
    if (cleanup.inspectionCause !== undefined) causes.push(cleanup.inspectionCause);
    super(
      [...new Set(causes)],
      `The concurrently completed SearXNG bundle at ${destination} changed during private `
      + "staging cleanup; no valid published destination is claimed. "
      + describeStagingState(cleanup.status, stagingPath),
      { cause: destinationCause },
    );
    this.name = "RetiredSearxngDestinationRevalidationError";
    this.code = "SEARXNG_DESTINATION_REVALIDATION_FAILED";
    this.published = false;
    this.destination = destination;
    this.destinationState = "indeterminate";
    this.stagingPath = stagingPath;
    this.stagingState = cleanup.status;
    this.operationCause = destinationCause;
    this.destinationCause = destinationCause;
    this.cleanupCause = cleanup.cause;
    this.inspectionCause = cleanup.inspectionCause;
  }
}

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
  getCurrentUid = DEFAULT_GET_CURRENT_UID,
  removeStaging = rmSync,
  renameStaging = renameSync,
} = {}) {
  if (typeof destination !== "string" || destination.trim().length === 0) {
    throw new Error("destination is required.");
  }
  const currentUid = requirePosixCurrentUid(getCurrentUid);
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
  const parentIdentity = secureDirectoryIdentity(
    canonicalParent,
    "destination parent",
    currentUid,
  );
  const assertStableCanonicalParent = () => assertSecureDirectoryIdentity(
    canonicalParent,
    parentIdentity,
    "Destination parent changed after validation; no bundle was published.",
    canonicalParent,
    currentUid,
  );
  const assertDestinationBoundary = () => {
    assertStableCanonicalParent();
    const currentDestination = resolveProspectivePath(absoluteDestination);
    if (currentDestination !== stableDestination
      || isWithin(canonicalRepoRoot, currentDestination)) {
      throw new Error("Destination path changed or resolves inside the mono-agent repository.");
    }
  };
  const revalidateConcurrentDestination = (expectedIdentity, cleanup, stagingPath) => {
    try {
      assertDestinationBoundary();
      assertSecureDirectoryIdentity(
        stableDestination,
        expectedIdentity,
        "Concurrently completed migration destination changed identity during staging cleanup.",
        stableDestination,
        currentUid,
      );
      assertCompleteBundle(stableDestination, secret);
    } catch (destinationCause) {
      throw new RetiredSearxngDestinationRevalidationError({
        destination: absoluteDestination,
        stagingPath,
        destinationCause,
        cleanup,
      });
    }
  };

  assertDestinationBoundary();
  if (entryExists(stableDestination)) {
    if (isCompletedBundle(stableDestination, secret, currentUid)) {
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
  let publishedDestinationIdentity;
  try {
    assertDestinationBoundary();
    mkdirSync(staging, { mode: 0o700 });
    stagingCreated = true;
    chmodSync(staging, 0o700);
    stagingIdentity = secureDirectoryIdentity(
      staging,
      "private staging directory",
      currentUid,
    );
    const assertPrivateStaging = () => {
      assertDestinationBoundary();
      assertSecureDirectoryIdentity(
        staging,
        stagingIdentity,
        "Private migration bundle changed before publication.",
        staging,
        currentUid,
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
      const concurrentIdentity = completedBundleIdentityIfValid(
        stableDestination,
        secret,
        currentUid,
      );
      if (concurrentIdentity === undefined) {
        throw new Error(`Destination already exists: ${absoluteDestination}`);
      }
      const cleanup = cleanupPrivateStaging(
        staging,
        stagingIdentity,
        assertStableCanonicalParent,
        currentUid,
        removeStaging,
      );
      published = true;
      stagingCreated = cleanup.status !== "removed";
      revalidateConcurrentDestination(concurrentIdentity, cleanup, staging);
      throwIfStagingCleanupFailed(cleanup, absoluteDestination, staging);
      stagingCreated = false;
      return completedResult(absoluteDestination, log, "Accepted the concurrently completed");
    }

    try {
      // The destination is published exactly once. A whole-directory rename
      // does not follow a raced destination symlink and never exposes a partial
      // bundle; a normal concurrent loser validates the non-empty winner below.
      renameStaging(staging, stableDestination);
      stagingCreated = false;
      published = true;
      publishedDestinationIdentity = stagingIdentity;
    } catch (error) {
      const concurrentIdentity = completedBundleIdentityIfValid(
        stableDestination,
        secret,
        currentUid,
      );
      if (concurrentIdentity === undefined) throw error;
      published = true;
      publishedDestinationIdentity = concurrentIdentity;
      const cleanup = cleanupPrivateStaging(
        staging,
        stagingIdentity,
        assertStableCanonicalParent,
        currentUid,
        removeStaging,
      );
      stagingCreated = cleanup.status !== "removed";
      revalidateConcurrentDestination(concurrentIdentity, cleanup, staging);
      throwIfStagingCleanupFailed(cleanup, absoluteDestination, staging);
      stagingCreated = false;
    }

    afterAtomicPublish?.();
    assertDestinationBoundary();
    assertSecureDirectoryIdentity(
      stableDestination,
      publishedDestinationIdentity,
      "Published migration bundle changed identity.",
      stableDestination,
      currentUid,
    );
    assertCompleteBundle(stableDestination, secret);
  } catch (operationCause) {
    if (!published && stagingCreated && stagingIdentity !== undefined) {
      const cleanup = cleanupPrivateStaging(
        staging,
        stagingIdentity,
        assertStableCanonicalParent,
        currentUid,
        removeStaging,
      );
      if (cleanup.status !== "removed" || cleanup.cause !== undefined) {
        throw new RetiredSearxngUnpublishedStagingCleanupError({
          destination: absoluteDestination,
          stagingPath: staging,
          operationCause,
          cleanup,
        });
      }
    }
    throw operationCause;
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

function cleanupPrivateStaging(
  staging,
  stagingIdentity,
  assertStableCanonicalParent,
  currentUid,
  removeStaging,
) {
  let cleanupCause;
  try {
    assertStableCanonicalParent();
    assertSecureDirectoryIdentity(
      staging,
      stagingIdentity,
      "Private staging directory changed before cleanup.",
      staging,
      currentUid,
    );
    removeStaging(staging, { recursive: true, force: true });
  } catch (error) {
    cleanupCause = error;
  }

  let parentInspectionCause;
  try {
    // A missing lexical staging path is meaningful only while it is still reached through the
    // exact canonical parent validated before cleanup. Otherwise the original private directory
    // may merely have moved with that parent.
    assertStableCanonicalParent();
  } catch (error) {
    parentInspectionCause = error;
  }
  const state = parentInspectionCause === undefined
    ? inspectPrivateStagingAfterCleanup(staging, stagingIdentity, currentUid)
    : { status: "indeterminate", inspectionCause: parentInspectionCause };
  if (cleanupCause !== undefined) return { ...state, cause: cleanupCause };
  if (state.status === "removed") return state;
  return {
    ...state,
    cause: new Error(
      state.status === "retained"
        ? "Private staging remover returned without removing the directory."
        : "Private staging cleanup outcome could not be verified safely.",
    ),
  };
}

function throwIfStagingCleanupFailed(cleanup, destination, stagingPath) {
  if (cleanup.status === "removed" && cleanup.cause === undefined) return;
  throw new RetiredSearxngStagingCleanupError({
    destination,
    stagingPath,
    cleanup,
  });
}

function inspectPrivateStagingAfterCleanup(staging, expectedIdentity, currentUid) {
  let details;
  try {
    details = lstatSync(staging);
  } catch (inspectionCause) {
    if (isMissingPathError(inspectionCause)) return { status: "removed" };
    return { status: "indeterminate", inspectionCause };
  }

  let canonical;
  try {
    canonical = realpathSync(staging);
  } catch (inspectionCause) {
    return { status: "indeterminate", inspectionCause };
  }

  if (!details.isSymbolicLink()
    && details.isDirectory()
    && details.dev === expectedIdentity.dev
    && details.ino === expectedIdentity.ino
    && details.uid === currentUid
    && (details.mode & 0o777) === 0o700
    && canonical === staging) {
    return { status: "retained" };
  }
  return { status: "indeterminate" };
}

function describeStagingState(state, stagingPath) {
  if (state === "removed") {
    return `The staging path was confirmed absent after the cleanup anomaly: ${stagingPath}. `
      + "No retained staging directory is claimed.";
  }
  if (state === "retained") {
    return `The same staging directory was observed at ${stagingPath} with the expected owner `
      + "and mode 0700; its contents may be partial or changed.";
  }
  return `The post-error staging state is indeterminate. Do not assume the path is absent, `
    + `unchanged, or protected: ${stagingPath}.`;
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

function completedBundleIdentityIfValid(destination, secret, currentUid) {
  try {
    const identity = secureDirectoryIdentity(
      destination,
      "completed migration destination",
      currentUid,
    );
    assertCompleteBundle(destination, secret);
    return identity;
  } catch {
    return undefined;
  }
}

function isCompletedBundle(destination, secret, currentUid) {
  return completedBundleIdentityIfValid(destination, secret, currentUid) !== undefined;
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

function requirePosixCurrentUid(getCurrentUid) {
  if (typeof getCurrentUid !== "function") {
    throw new Error(
      "SearXNG migration requires POSIX ownership and mode checks; unsupported platform; no files were written.",
    );
  }
  let currentUid;
  try {
    currentUid = getCurrentUid();
  } catch {
    throw new Error(
      "SearXNG migration could not determine the current POSIX user; no files were written.",
    );
  }
  if (!Number.isSafeInteger(currentUid) || currentUid < 0) {
    throw new Error(
      "SearXNG migration could not determine the current POSIX user; no files were written.",
    );
  }
  return currentUid;
}

function secureDirectoryIdentity(candidate, label, currentUid) {
  let details;
  try {
    details = lstatSync(candidate);
  } catch {
    throw new Error(`Could not inspect ${label}: ${candidate}`);
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${candidate}`);
  }
  if (details.uid !== currentUid) {
    throw new Error(`${label} must be owned by the current user: ${candidate}`);
  }
  if ((details.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable: ${candidate}`);
  }
  return { dev: details.dev, ino: details.ino };
}

function assertSecureDirectoryIdentity(
  candidate,
  expected,
  message,
  expectedCanonicalPath,
  currentUid,
) {
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
    || details.uid !== currentUid) {
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

function isMissingPathError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
    "Requires a POSIX local filesystem; unsupported platforms fail before any file is written.",
    "A complete private sibling is renamed once; an exact completed destination is idempotent.",
    "This command never invokes Docker, stops a service, or removes a volume.",
  ].join("\n");
}

function reasonOf(error) {
  if (!(error instanceof Error)) return String(error);
  if (!(error instanceof RetiredSearxngStagingCleanupError)
    && !(error instanceof RetiredSearxngUnpublishedStagingCleanupError)
    && !(error instanceof RetiredSearxngDestinationRevalidationError)) {
    return error.message;
  }

  const lines = [`[${error.code}] ${error.message}`];
  if (error.operationCause !== undefined) {
    lines.push(`Operation cause: ${safeCauseSummary(error.operationCause)}`);
  }
  if (error.cleanupCause !== undefined) {
    lines.push(`Cleanup cause: ${safeCauseSummary(error.cleanupCause)}`);
  }
  if (error.inspectionCause !== undefined) {
    lines.push(`Inspection cause: ${safeCauseSummary(error.inspectionCause)}`);
  }
  return lines.join("\n");
}

function safeCauseSummary(cause) {
  if (!(cause instanceof Error)) return "non-Error failure";
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u.test(cause.name) ? cause.name : "Error";
  const code = typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(cause.code)
    ? ` (${cause.code})`
    : "";
  const message = cause.message
    .replace(/SEARXNG_SECRET\s*=\s*[^\s,;]*/giu, "SEARXNG_SECRET=[redacted]")
    .replace(/[0-9a-f]{64}/giu, "[redacted-64-hex]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const boundedMessage = message.length > 200 ? `${message.slice(0, 199)}…` : message;
  return `${name}${code}${boundedMessage.length > 0 ? `: ${boundedMessage}` : ""}`;
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
