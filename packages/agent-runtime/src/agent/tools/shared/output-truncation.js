import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./constants.js";
import { boundedInt } from "./dedup.js";
import { readToolRuntime } from "./runtime-context.js";

function sanitizeName(value) {
  return String(value || "tool").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "tool";
}

/**
 * Persist a truncated tool's full output so the retained text can reference it.
 *
 * Two sinks, in order of preference:
 * 1. The run-bound host sink (`ctx.persistArtifact`, attached per run by the
 *    turn runner). It is the same `persistArtifact({filename, buffer, toolName,
 *    toolUseId}) -> path | null` callback the tool-payload guard and the Agent
 *    tool use, so the file lands in the run's validated tool-output directory.
 *    This is the sink a configured app actually provides.
 * 2. A configured `toolArtifactDir` (deep-path hosts via configureToolRuntime),
 *    written directly under `<dir>/tool-output/<runId>/`.
 *
 * Null when neither is available or the write fails; callers then omit the
 * "saved to" line rather than naming a file that does not exist.
 *
 * @param {string} label
 * @param {string} text
 * @param {any} [ctx]
 * @returns {{path: string, bytes: number}|null}
 */
export function writeToolArtifact(label, text, ctx) {
  const { toolArtifactDir, runId, persistArtifact } = ctx ?? readToolRuntime();
  const body = String(text || "");
  const filename = `${Date.now()}-${sanitizeName(label)}-${randomUUID()}.txt`;
  if (typeof persistArtifact === "function") {
    try {
      const path = persistArtifact({
        filename,
        buffer: Buffer.from(body, "utf8"),
        toolName: sanitizeName(label),
        toolUseId: null,
      });
      if (typeof path === "string" && path.length > 0) return { path, bytes: Buffer.byteLength(body, "utf8") };
    } catch {
      /* fall through to the directory sink, then null */
    }
  }
  if (!toolArtifactDir) return null;
  try {
    const safeRunId = sanitizeName(runId || "manual");
    const dir = resolve(toolArtifactDir, "tool-output", safeRunId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, body, "utf8");
    return { path, bytes: Buffer.byteLength(body, "utf8") };
  } catch {
    return null;
  }
}

export function truncationSuffix({ label, shown, total, artifact, hint }) {
  return [
    "",
    `[truncated ${label} output: showing ${shown} of ${total} characters.]`,
    artifact ? `Full output saved to: ${artifact.path}` : null,
    hint || "Use a narrower path, range, command, or query for the missing detail.",
  ].filter(Boolean).join("\n");
}

/**
 * @param {string} text
 * @param {{label?: string, maxChars?: number, strategy?: string, hint?: string, ctx?: any}} [options]
 */
export function capChars(text, {
  label = "tool",
  maxChars = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  strategy = "head",
  hint,
  ctx,
} = {}) {
  const value = String(text || "");
  const limit = boundedInt(maxChars, DEFAULT_MAX_TOOL_OUTPUT_CHARS, { min: 200 });
  if (value.length <= limit) return value;
  const artifact = writeToolArtifact(label, value, ctx);
  const suffix = truncationSuffix({ label, shown: limit, total: value.length, artifact, hint });
  const budget = Math.max(0, limit - suffix.length);
  if (strategy === "head_tail" && budget > 200) {
    const head = Math.floor(budget * 0.6);
    const tail = Math.max(0, budget - head - 40);
    return `${value.slice(0, head)}\n\n[... middle omitted ...]\n\n${value.slice(Math.max(0, value.length - tail))}${suffix}`;
  }
  return `${value.slice(0, budget)}${suffix}`;
}
