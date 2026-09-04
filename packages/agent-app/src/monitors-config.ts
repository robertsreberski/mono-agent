import { readFile } from "node:fs/promises";

/**
 * Host-only `monitors` configuration.
 *
 * Monitors are a STREAMING class of the background process-job substrate: they
 * reuse its protected private-state root, its registration proof, its sandbox
 * protection, and its origin binding, and therefore require
 * `processJobs.enabled`. What they do not share is capacity — a persistent watch
 * that held an ordinary background slot would starve real background work — so
 * every limit below is counted independently of `processJobs.*`.
 */
export const MONITORS_DEFAULTS = Object.freeze({
  enabled: false,
  maxActive: 8,
  maxActivePerConversation: 2,
  /** Ceiling for a timed monitor; `timeout_ms` may lower it, never raise it. */
  maxRuntimeMs: 60 * 60 * 1_000,
  /** Ceiling for a `persistent: true` monitor. */
  persistentMaxRuntimeMs: 24 * 60 * 60 * 1_000,
  /** Stdout lines produced within this window are delivered as one batch. */
  coalesceMs: 200,
  maxBatchLines: 200,
  maxBatchBytes: 64 * 1024,
  maxLineBytes: 4 * 1024,
  maxChainDepth: 4,
  rateLimit: Object.freeze({
    windowMs: 1_000,
    maxLinesPerWindow: 200,
    sustainedWindows: 5,
  }),
});

export const MONITORS_CAPS = Object.freeze({
  maxActive: 32,
  maxActivePerConversation: 8,
  maxRuntimeMs: 60 * 60 * 1_000,
  persistentMaxRuntimeMs: 24 * 60 * 60 * 1_000,
  coalesceMs: 5_000,
  maxBatchLines: 2_000,
  maxBatchBytes: 1024 * 1024,
  maxLineBytes: 64 * 1024,
  maxChainDepth: 8,
  rateLimit: Object.freeze({
    windowMs: 60_000,
    maxLinesPerWindow: 20_000,
    sustainedWindows: 60,
  }),
});

/** Terminal monitors retained only until their single final wake settles. */
export const MONITORS_MAX_TERMINAL_RECORDS = 32;

export interface MonitorsRateLimitSettings {
  readonly windowMs: number;
  readonly maxLinesPerWindow: number;
  readonly sustainedWindows: number;
}

export interface MonitorsSettings {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly maxActive: number;
  readonly maxActivePerConversation: number;
  readonly maxRuntimeMs: number;
  readonly persistentMaxRuntimeMs: number;
  readonly coalesceMs: number;
  readonly maxBatchLines: number;
  readonly maxBatchBytes: number;
  readonly maxLineBytes: number;
  readonly maxChainDepth: number;
  readonly rateLimit: MonitorsRateLimitSettings;
}

const MONITORS_KEYS = [
  "enabled",
  "maxActive",
  "maxActivePerConversation",
  "maxRuntimeMs",
  "persistentMaxRuntimeMs",
  "coalesceMs",
  "maxBatchLines",
  "maxBatchBytes",
  "maxLineBytes",
  "maxChainDepth",
  "rateLimit",
] as const;

const RATE_LIMIT_KEYS = ["windowMs", "maxLinesPerWindow", "sustainedWindows"] as const;

/** Load the host-only monitor block, failing closed on every unknown key. */
export async function loadMonitorsSettings(input: {
  readonly configPath: string;
}): Promise<MonitorsSettings> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(input.configPath, "utf8")) as unknown;
  } catch {
    // The core loader owns malformed/missing config reporting. This optional
    // host block stays disabled until that loader accepts the file.
  }
  return parseMonitorsSettings(raw);
}

/** Parse one already-loaded config object; unknown keys fail closed. */
export function parseMonitorsSettings(raw: unknown): MonitorsSettings {
  const root = objectOf(raw);
  const value = root.monitors;
  if (value === undefined) return resolved(false, {});
  const block = requireObject(value, "monitors");
  rejectUnknownKeys(block, "monitors", MONITORS_KEYS);
  return resolved(true, block);
}

function resolved(configured: boolean, block: Record<string, unknown>): MonitorsSettings {
  const rateLimitValue = block.rateLimit;
  const rateLimit = rateLimitValue === undefined
    ? {}
    : requireObject(rateLimitValue, "monitors.rateLimit");
  rejectUnknownKeys(rateLimit, "monitors.rateLimit", RATE_LIMIT_KEYS);
  return {
    configured,
    enabled: optionalBoolean(block.enabled, "monitors.enabled") ?? MONITORS_DEFAULTS.enabled,
    maxActive: bounded(block.maxActive, "monitors.maxActive", MONITORS_DEFAULTS.maxActive, MONITORS_CAPS.maxActive),
    maxActivePerConversation: bounded(
      block.maxActivePerConversation,
      "monitors.maxActivePerConversation",
      MONITORS_DEFAULTS.maxActivePerConversation,
      MONITORS_CAPS.maxActivePerConversation,
    ),
    maxRuntimeMs: bounded(
      block.maxRuntimeMs,
      "monitors.maxRuntimeMs",
      MONITORS_DEFAULTS.maxRuntimeMs,
      MONITORS_CAPS.maxRuntimeMs,
    ),
    persistentMaxRuntimeMs: bounded(
      block.persistentMaxRuntimeMs,
      "monitors.persistentMaxRuntimeMs",
      MONITORS_DEFAULTS.persistentMaxRuntimeMs,
      MONITORS_CAPS.persistentMaxRuntimeMs,
    ),
    coalesceMs: bounded(block.coalesceMs, "monitors.coalesceMs", MONITORS_DEFAULTS.coalesceMs, MONITORS_CAPS.coalesceMs),
    maxBatchLines: bounded(
      block.maxBatchLines,
      "monitors.maxBatchLines",
      MONITORS_DEFAULTS.maxBatchLines,
      MONITORS_CAPS.maxBatchLines,
    ),
    maxBatchBytes: bounded(
      block.maxBatchBytes,
      "monitors.maxBatchBytes",
      MONITORS_DEFAULTS.maxBatchBytes,
      MONITORS_CAPS.maxBatchBytes,
    ),
    maxLineBytes: bounded(
      block.maxLineBytes,
      "monitors.maxLineBytes",
      MONITORS_DEFAULTS.maxLineBytes,
      MONITORS_CAPS.maxLineBytes,
    ),
    maxChainDepth: bounded(
      block.maxChainDepth,
      "monitors.maxChainDepth",
      MONITORS_DEFAULTS.maxChainDepth,
      MONITORS_CAPS.maxChainDepth,
    ),
    rateLimit: {
      windowMs: bounded(
        rateLimit.windowMs,
        "monitors.rateLimit.windowMs",
        MONITORS_DEFAULTS.rateLimit.windowMs,
        MONITORS_CAPS.rateLimit.windowMs,
      ),
      maxLinesPerWindow: bounded(
        rateLimit.maxLinesPerWindow,
        "monitors.rateLimit.maxLinesPerWindow",
        MONITORS_DEFAULTS.rateLimit.maxLinesPerWindow,
        MONITORS_CAPS.rateLimit.maxLinesPerWindow,
      ),
      sustainedWindows: bounded(
        rateLimit.sustainedWindows,
        "monitors.rateLimit.sustainedWindows",
        MONITORS_DEFAULTS.rateLimit.sustainedWindows,
        MONITORS_CAPS.rateLimit.sustainedWindows,
      ),
    },
  };
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
