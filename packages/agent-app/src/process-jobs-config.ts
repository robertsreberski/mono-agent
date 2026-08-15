import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { MonoAgentConfigError } from "@mono-agent/config";

import { resolveConversationStatePurgeRoots } from "./conversation-state-roots.js";

export const PROCESS_JOBS_DEFAULTS = Object.freeze({
  enabled: false,
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

/** Load the host-only process-job block and fail closed on every unknown key. */
export async function loadProcessJobsSettings(input: {
  readonly cwd: string;
  readonly configPath: string;
  readonly env?: Record<string, string | undefined>;
}): Promise<ProcessJobsSettings> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(input.configPath, "utf8")) as unknown;
  } catch {
    // The core loader owns malformed/missing config reporting. This optional
    // host block remains disabled until that loader accepts the file.
  }
  const root = objectOf(raw);
  const value = root.processJobs;
  if (value === undefined) return await resolvedSettings(input, false, {});
  const block = requireObject(value, "processJobs");
  rejectUnknownKeys(block, "processJobs", [
    "enabled",
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
  return await resolvedSettings(input, true, block);
}

async function resolvedSettings(
  input: {
    readonly cwd: string;
    readonly configPath: string;
    readonly env?: Record<string, string | undefined>;
  },
  configured: boolean,
  block: Record<string, unknown>,
): Promise<ProcessJobsSettings> {
  const enabled = optionalBoolean(block.enabled, "processJobs.enabled") ?? PROCESS_JOBS_DEFAULTS.enabled;
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
  if (configured) {
    await assertStateDirOutsideConversationPurgeRoots(stateDir, {
      cwd: input.cwd,
      configPath: input.configPath,
      env: input.env ?? {},
    });
  }

  const retentionValue = block.retention;
  const retention = retentionValue === undefined
    ? {}
    : requireObject(retentionValue, "processJobs.retention");
  rejectUnknownKeys(retention, "processJobs.retention", ["maxRecords", "maxAgeMs", "artifactMaxBytes"]);

  return {
    configured,
    enabled,
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
): Promise<void> {
  const roots = await resolveConversationStatePurgeRoots(input);
  const canonicalStateDir = await canonicalConfigPath(stateDir, "processJobs.stateDir");
  const purgeRoots = [
    { kind: "Pi provider sessions", path: roots.sessions },
    { kind: "durable session/tool history", path: roots.history },
    { kind: "ACP sessions", path: roots.acpSessions },
  ] as const;

  for (const purgeRoot of purgeRoots) {
    if (purgeRoot.path === undefined) continue;
    const canonicalPurgeRoot = await canonicalConfigPath(
      purgeRoot.path,
      `restart --clear-sessions ${purgeRoot.kind} purge root`,
    );
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
