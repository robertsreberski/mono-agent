import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { MonoAgentConfigError } from "@mono-agent/config";

import {
  conversationStatePurgePlanEntries,
  type ConversationStatePurgePlan,
  resolveConversationStatePurgeRoots,
} from "./conversation-state-roots.js";

export const PROCESS_JOBS_DEFAULTS = Object.freeze({
  enabled: false,
  unsafeAllowUnprotectedState: false,
  stateDir: ".mono-agent/process-jobs",
  maxConcurrent: 4,
  maxActivePerConversation: 2,
  maxQueued: 8,
  maxRuntimeMs: 30 * 60 * 1_000,
  maxQueueAgeMs: 5 * 60 * 1_000,
  maxOutputBytes: 1024 * 1024,
  previewChars: 2_000,
  maxChainDepth: 4,
  retention: Object.freeze({
    maxRecords: 1_000,
    maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
    artifactMaxBytes: 256 * 1024 * 1024,
  }),
});

export const PROCESS_JOBS_CAPS = Object.freeze({
  maxConcurrent: 32,
  maxActivePerConversation: 8,
  maxQueued: 64,
  maxRuntimeMs: 24 * 60 * 60 * 1_000,
  maxQueueAgeMs: 60 * 60 * 1_000,
  maxOutputBytes: 8 * 1024 * 1024,
  previewChars: 8_000,
  maxChainDepth: 8,
  retention: Object.freeze({
    maxRecords: 10_000,
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    artifactMaxBytes: 1024 * 1024 * 1024,
  }),
});

export interface ProcessJobsSettings {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly unsafeAllowUnprotectedState: boolean;
  readonly stateDir: string;
  readonly maxConcurrent: number;
  readonly maxActivePerConversation: number;
  readonly maxQueued: number;
  readonly maxRuntimeMs: number;
  readonly maxQueueAgeMs: number;
  readonly maxOutputBytes: number;
  readonly previewChars: number;
  readonly maxChainDepth: number;
  readonly retention: {
    readonly maxRecords: number;
    readonly maxAgeMs: number;
    readonly artifactMaxBytes: number;
  };
}

export interface LoadProcessJobsSettingsOptions {
  /** The exact destructive-root plan already attested by clear-sessions preflight. */
  readonly purgePlan?: ConversationStatePurgePlan;
  /** Check an unconfigured default state root only when destructive reset is imminent. */
  readonly validateDormantStateRoot?: boolean;
  /** One exact config/environment generation shared by destructive preflight. */
  readonly snapshot?: ProcessJobsConfigSnapshot;
}

const MAX_DESTRUCTIVE_CONFIG_BYTES = 1024 * 1024;

export interface ProcessJobsConfigSnapshot {
  readonly path: string;
  readonly json: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly fingerprint: string;
  readonly missing: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Resolve only the workspace needed by destructive registry validation. */
export function resolveProcessJobsRegistryWorkspace(
  snapshot: ProcessJobsConfigSnapshot,
  cwd: string,
): string {
  const runtime = snapshot.json.runtime;
  if (runtime !== undefined
    && (typeof runtime !== "object" || runtime === null || Array.isArray(runtime))) {
    throw new MonoAgentConfigError("invalid_json", "runtime must be an object.", { path: "runtime" });
  }
  const configured = runtime === undefined
    ? undefined
    : (runtime as Readonly<Record<string, unknown>>).workspace;
  if (configured !== undefined && typeof configured !== "string") {
    throw new MonoAgentConfigError(
      "invalid_json",
      "runtime.workspace must be a string.",
      { path: "runtime.workspace" },
    );
  }
  // An explicitly supplied environment value wins even when blank; the core
  // loader normalizes that case back to cwd instead of falling through to JSON.
  const selected = snapshot.env.MONO_AGENT_WORKSPACE !== undefined
    ? snapshot.env.MONO_AGENT_WORKSPACE
    : configured;
  const normalized = selected?.trim();
  return normalized === undefined || normalized.length === 0
    ? resolve(cwd)
    : resolve(cwd, normalized);
}

/** Read one strict, bounded, no-follow config generation for destructive preflight. */
export async function readProcessJobsConfigSnapshot(input: {
  readonly configPath: string;
  readonly env?: Record<string, string | undefined>;
}): Promise<ProcessJobsConfigSnapshot> {
  const path = resolve(input.configPath);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      try {
        await lstat(path);
      } catch (secondError) {
        if (isErrno(secondError, "ENOENT")) {
          return {
            path,
            json: Object.freeze({}),
            digest: "",
            fingerprint: "missing",
            missing: true,
            env: Object.freeze({ ...(input.env ?? {}) }),
          };
        }
        throw secondError;
      }
      throw new Error("restart --clear-sessions config appeared while absence was validated.");
    }
    if (isErrno(error, "ELOOP") || isErrno(error, "EMLINK")) {
      throw new Error("restart --clear-sessions config must not be a symbolic link.");
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertConfigFile(before);
    if (before.size > BigInt(MAX_DESTRUCTIVE_CONFIG_BYTES)) {
      throw new Error(`restart --clear-sessions config exceeds ${String(MAX_DESTRUCTIVE_CONFIG_BYTES)} bytes.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    assertConfigFile(after);
    assertConfigFile(named);
    if (!sameConfigFile(before, after) || !sameConfigFile(after, named)
      || bytes.byteLength !== Number(after.size)) {
      throw new Error("restart --clear-sessions config changed while it was read.");
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("restart --clear-sessions config is not valid UTF-8.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new Error("restart --clear-sessions config is not valid JSON.", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("restart --clear-sessions config must contain one JSON object.");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      path,
      json: parsed as Readonly<Record<string, unknown>>,
      digest,
      fingerprint: configFingerprint(after, digest),
      missing: false,
      env: Object.freeze({ ...(input.env ?? {}) }),
    };
  } finally {
    await handle.close();
  }
}

export async function assertProcessJobsConfigSnapshotUnchanged(
  expected: ProcessJobsConfigSnapshot,
): Promise<void> {
  let current: ProcessJobsConfigSnapshot;
  try {
    current = await readProcessJobsConfigSnapshot({
      configPath: expected.path,
      env: { ...expected.env },
    });
  } catch (error) {
    throw new Error(
      "restart --clear-sessions config changed after validation; no conversation state was deleted.",
      { cause: error },
    );
  }
  if (current.missing !== expected.missing
    || current.digest !== expected.digest
    || current.fingerprint !== expected.fingerprint) {
    throw new Error("restart --clear-sessions config changed after validation; no conversation state was deleted.");
  }
}

/** Load the host-only process-job block and fail closed on every unknown key. */
export async function loadProcessJobsSettings(input: {
  readonly cwd: string;
  readonly configPath: string;
  readonly env?: Record<string, string | undefined>;
}, options: LoadProcessJobsSettingsOptions = {}): Promise<ProcessJobsSettings> {
  let raw: unknown = {};
  if (options.snapshot !== undefined) {
    raw = options.snapshot.json;
  } else {
    try {
      raw = JSON.parse(await readFile(input.configPath, "utf8")) as unknown;
    } catch {
      // The core loader owns malformed/missing config reporting. This optional
      // host block remains disabled until that loader accepts the file.
    }
  }
  const root = objectOf(raw);
  const value = root.processJobs;
  if (value === undefined) return await resolvedSettings(input, false, {}, options);
  const block = requireObject(value, "processJobs");
  rejectUnknownKeys(block, "processJobs", [
    "enabled",
    "unsafeAllowUnprotectedState",
    "stateDir",
    "maxConcurrent",
    "maxActivePerConversation",
    "maxQueued",
    "maxRuntimeMs",
    "maxQueueAgeMs",
    "maxOutputBytes",
    "previewChars",
    "maxChainDepth",
    "retention",
  ]);
  return await resolvedSettings(input, true, block, options);
}

async function resolvedSettings(
  input: {
    readonly cwd: string;
    readonly configPath: string;
    readonly env?: Record<string, string | undefined>;
  },
  configured: boolean,
  block: Record<string, unknown>,
  options: LoadProcessJobsSettingsOptions,
): Promise<ProcessJobsSettings> {
  const enabled = optionalBoolean(block.enabled, "processJobs.enabled") ?? PROCESS_JOBS_DEFAULTS.enabled;
  const unsafeAllowUnprotectedState = optionalBoolean(
    block.unsafeAllowUnprotectedState,
    "processJobs.unsafeAllowUnprotectedState",
  ) ?? PROCESS_JOBS_DEFAULTS.unsafeAllowUnprotectedState;
  const rawStateDir = optionalString(block.stateDir, "processJobs.stateDir") ?? PROCESS_JOBS_DEFAULTS.stateDir;
  if (isAbsolute(rawStateDir)) {
    throw new Error("processJobs.stateDir must be relative to the agent root.");
  }
  const agentRoot = await realpath(resolve(input.cwd)).catch(() => resolve(input.cwd));
  const stateDir = resolve(agentRoot, rawStateDir);
  const escaped = relative(agentRoot, stateDir);
  if (escaped.length === 0) {
    throw new Error("processJobs.stateDir must be a child directory of the agent root.");
  }
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error("processJobs.stateDir must stay inside the agent root.");
  }
  const validateStateDir = configured
    || (options.validateDormantStateRoot === true && await pathExists(stateDir));
  if (validateStateDir) {
    await assertStateDirOutsideConversationPurgeRoots(stateDir, {
      cwd: input.cwd,
      configPath: input.configPath,
      env: input.env ?? {},
    }, options.purgePlan);
  }

  const retentionValue = block.retention;
  const retention = retentionValue === undefined
    ? {}
    : requireObject(retentionValue, "processJobs.retention");
  rejectUnknownKeys(retention, "processJobs.retention", ["maxRecords", "maxAgeMs", "artifactMaxBytes"]);

  return {
    configured,
    enabled,
    unsafeAllowUnprotectedState,
    stateDir,
    maxConcurrent: bounded(block.maxConcurrent, "processJobs.maxConcurrent", PROCESS_JOBS_DEFAULTS.maxConcurrent, PROCESS_JOBS_CAPS.maxConcurrent),
    maxActivePerConversation: bounded(
      block.maxActivePerConversation,
      "processJobs.maxActivePerConversation",
      PROCESS_JOBS_DEFAULTS.maxActivePerConversation,
      PROCESS_JOBS_CAPS.maxActivePerConversation,
    ),
    maxQueued: bounded(block.maxQueued, "processJobs.maxQueued", PROCESS_JOBS_DEFAULTS.maxQueued, PROCESS_JOBS_CAPS.maxQueued),
    maxRuntimeMs: bounded(block.maxRuntimeMs, "processJobs.maxRuntimeMs", PROCESS_JOBS_DEFAULTS.maxRuntimeMs, PROCESS_JOBS_CAPS.maxRuntimeMs),
    maxQueueAgeMs: bounded(block.maxQueueAgeMs, "processJobs.maxQueueAgeMs", PROCESS_JOBS_DEFAULTS.maxQueueAgeMs, PROCESS_JOBS_CAPS.maxQueueAgeMs),
    maxOutputBytes: bounded(block.maxOutputBytes, "processJobs.maxOutputBytes", PROCESS_JOBS_DEFAULTS.maxOutputBytes, PROCESS_JOBS_CAPS.maxOutputBytes),
    previewChars: bounded(block.previewChars, "processJobs.previewChars", PROCESS_JOBS_DEFAULTS.previewChars, PROCESS_JOBS_CAPS.previewChars),
    maxChainDepth: bounded(block.maxChainDepth, "processJobs.maxChainDepth", PROCESS_JOBS_DEFAULTS.maxChainDepth, PROCESS_JOBS_CAPS.maxChainDepth),
    retention: {
      maxRecords: bounded(retention.maxRecords, "processJobs.retention.maxRecords", PROCESS_JOBS_DEFAULTS.retention.maxRecords, PROCESS_JOBS_CAPS.retention.maxRecords),
      maxAgeMs: bounded(retention.maxAgeMs, "processJobs.retention.maxAgeMs", PROCESS_JOBS_DEFAULTS.retention.maxAgeMs, PROCESS_JOBS_CAPS.retention.maxAgeMs),
      artifactMaxBytes: bounded(
        retention.artifactMaxBytes,
        "processJobs.retention.artifactMaxBytes",
        PROCESS_JOBS_DEFAULTS.retention.artifactMaxBytes,
        PROCESS_JOBS_CAPS.retention.artifactMaxBytes,
      ),
    },
  };
}

async function assertStateDirOutsideConversationPurgeRoots(
  stateDir: string,
  input: {
    readonly cwd: string;
    readonly configPath: string;
    readonly env: Record<string, string | undefined>;
  },
  purgePlan?: ConversationStatePurgePlan,
): Promise<void> {
  const canonicalStateDir = await canonicalConfigPath(stateDir, "processJobs.stateDir");
  const purgeRoots = purgePlan === undefined
    ? await configuredPurgeRoots(input)
    : conversationStatePurgePlanEntries(purgePlan).map((root) => ({
      kind: root.kind,
      path: root.path,
      canonicalPath: root.canonicalPath,
    }));

  for (const purgeRoot of purgeRoots) {
    const canonicalPurgeRoot = purgeRoot.canonicalPath;
    if (!pathsContainEachOther(canonicalStateDir, canonicalPurgeRoot)) continue;
    const message = `processJobs.stateDir must be disjoint from the restart --clear-sessions ${purgeRoot.kind} purge root; neither path may contain the other.`;
    throw new MonoAgentConfigError("invalid_json", message, {
      path: "processJobs.stateDir",
      reason: message,
      stateDir: canonicalStateDir,
      purgeRoot: canonicalPurgeRoot,
      purgeRootKind: purgeRoot.kind,
    });
  }
}

async function configuredPurgeRoots(input: {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
}): Promise<readonly {
  readonly kind: "Pi provider sessions" | "durable session/tool history" | "ACP sessions";
  readonly path: string;
  readonly canonicalPath: string;
}[]> {
  const roots = await resolveConversationStatePurgeRoots(input);
  const values = [
    ...(roots.sessions === undefined ? [] : [{
      kind: "Pi provider sessions" as const,
      path: roots.sessions,
    }]),
    { kind: "durable session/tool history", path: roots.history },
    { kind: "ACP sessions", path: roots.acpSessions },
  ] as const;
  return await Promise.all(values.map(async (root) => ({
    kind: root.kind,
    path: root.path,
    canonicalPath: await canonicalConfigPath(
      root.path,
      `restart --clear-sessions ${root.kind} purge root`,
    ),
  })));
}

async function canonicalConfigPath(path: string, label: string): Promise<string> {
  let cursor = resolve(path);
  const missingSuffix: string[] = [];
  while (true) {
    try {
      const canonicalPrefix = await realpath(cursor);
      return resolve(canonicalPrefix, ...missingSuffix);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        const reason = error instanceof Error ? error.message : String(error);
        const message = `${label} could not be canonicalized: ${reason}`;
        throw new MonoAgentConfigError("invalid_json", message, {
          path: "processJobs.stateDir",
          reason: message,
        });
      }
      try {
        await lstat(cursor);
        const message = `${label} exists but could not be canonicalized.`;
        throw new MonoAgentConfigError("invalid_json", message, {
          path: "processJobs.stateDir",
          reason: message,
        });
      } catch (lstatError) {
        if (lstatError instanceof MonoAgentConfigError) throw lstatError;
        if (!isErrno(lstatError, "ENOENT")) {
          const reason = lstatError instanceof Error ? lstatError.message : String(lstatError);
          const message = `${label} could not be inspected while canonicalizing it: ${reason}`;
          throw new MonoAgentConfigError("invalid_json", message, {
            path: "processJobs.stateDir",
            reason: message,
          });
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        const message = `${label} could not be canonicalized because no existing ancestor was found.`;
        throw new MonoAgentConfigError("invalid_json", message, {
          path: "processJobs.stateDir",
          reason: message,
        });
      }
      missingSuffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function pathsContainEachOther(first: string, second: string): boolean {
  return pathContains(first, second) || pathContains(second, first);
}

function pathContains(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate.length === 0
    || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function bounded(value: unknown, path: string, fallback: number, cap: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${path} must be a positive safe integer.`);
  }
  if (Number(value) > cap) throw new Error(`${path} cannot exceed ${String(cap)}.`);
  return Number(value);
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} has unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}.`);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function assertConfigFile(details: BigIntStats): void {
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1n) {
    throw new Error("restart --clear-sessions config must be one regular file with one link.");
  }
}

function sameConfigFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink;
}

function configFingerprint(details: BigIntStats, digest: string): string {
  return [
    details.dev,
    details.ino,
    details.size,
    details.mtimeNs,
    details.ctimeNs,
    details.mode,
    details.uid,
    details.nlink,
    digest,
  ].join(":");
}
