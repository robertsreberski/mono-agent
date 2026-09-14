import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import { isProcessJobSubagentRoute, type ProcessJobSubagentProgress } from "@mono-agent/agent-contracts";
import { redactProcessOutput, redactProcessOutputLine } from "./process-output-redaction.js";
import { redactSecrets } from "./redact-secrets.js";

/** Private transient descriptors, never provider events or tool result bodies. */
export type SubagentProgressEvent =
  | { readonly type: "started"; readonly profile: string; readonly label?: string }
  | { readonly type: "route"; readonly requested?: unknown; readonly executed?: unknown; readonly disposition?: unknown }
  | { readonly type: "tool_started"; readonly id: string; readonly toolName: string; readonly argsSummary?: string }
  | { readonly type: "tool_completed"; readonly id: string; readonly failed: boolean; readonly executionMs?: number };

type Call = ProcessJobSubagentProgress["recent"][number];

function utf8Head(value: string, bytes: number): string {
  return Buffer.from(value).subarray(0, bytes).toString("utf8").replace(/�$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, (character) => `\\${character}`);
}

/**
 * Redacts a tool-argument preview while preserving ordinary slash-delimited paths.
 * Only unlabelled 24–39-character opaque runs containing slashes stop matching;
 * literal secrets, credential shapes, and any opaque path segment still redact.
 */
export function redactSubagentArgumentPreview(
  value: string,
  secrets: readonly string[],
  home: string = homedir(),
): string {
  const scan = value.slice(0, 16_384);
  const truncated = scan.length < value.length;
  const root = home.endsWith("/") ? home.slice(0, -1) : home;
  const relativized = root === "" || root === "/"
    ? scan
    : scan.replace(new RegExp(`${escapeRegExp(root)}(?=/|$|\\s|["'])`, "gu"), "~");
  const redacted = redactProcessOutputLine(redactProcessOutput(relativized, secrets, truncated), secrets)
    .replace(/(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{24,}(?![A-Za-z0-9_+=-])/gu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();
  return redacted || "[redacted]";
}

function routePart(value: unknown, keys: readonly string[]): Record<string, string> | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) return null;
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "string") return null;
    result[key] = record[key];
  }
  return result;
}

/** Keeps only safe snapshots. The child collector owns exactly-once call events. */
export class SubagentJobProgress {
  private value: ProcessJobSubagentProgress = { revision: 0, profile: "Subagent", toolCalls: 0, failedCalls: 0, recent: [] };
  private sealed = false;

  constructor(private readonly secrets: readonly string[]) {}

  private safe(value: string, bytes: number, multiline = false): string {
    const scan = value.slice(0, 16_384);
    const redacted = redactProcessOutputLine(redactProcessOutput(scan, this.secrets, scan.length < value.length), this.secrets);
    return utf8Head(multiline ? redacted : redactSecrets(redacted, { fallback: "[redacted]", maxChars: bytes }), bytes);
  }

  snapshot(): ProcessJobSubagentProgress { return structuredClone(this.value); }

  report(event: SubagentProgressEvent): boolean {
    if (this.sealed) return false;
    const previous = this.value;
    if (event.type === "started") {
      this.value = { ...previous, profile: this.safe(event.profile, 128),
        ...(event.label ? { label: this.safe(event.label, 256) } : {}) };
    } else if (event.type === "route") {
      const requested = routePart(event.requested, ["model", "effort"]);
      const executed = event.executed === undefined
        ? undefined
        : routePart(event.executed, ["model", "effort", "effectiveEffort"]);
      if (requested === null || executed === null) return false;
      const candidate = { requested, ...(executed === undefined ? {} : { executed }),
        ...(event.disposition === undefined ? {} : { disposition: event.disposition }) };
      if (!isProcessJobSubagentRoute(candidate) || isDeepStrictEqual(candidate, previous.route)) return false;
      this.value = { ...previous, route: candidate };
    } else {
      // IDs are opaque correlation only, never rendered; reject oversized ids rather than collide by truncation.
      if (typeof event.id !== "string" || Buffer.byteLength(event.id) > 256 || !event.id.trim()) return false;
      const index = previous.recent.findIndex((call) => call.id === event.id);
      if (event.type === "tool_started") {
        if (index !== -1) return false;
        const call: Call = { id: event.id, toolName: this.safe(event.toolName, 128), status: "running",
          ...(event.argsSummary ? { argsSummary: utf8Head(redactSubagentArgumentPreview(event.argsSummary, this.secrets), 256) } : {}) };
        this.value = { ...previous, toolCalls: previous.toolCalls + 1, recent: [...previous.recent, call].slice(-50) };
      } else {
        if (index !== -1 && previous.recent[index]?.status !== "running") return false;
        this.value = { ...previous, failedCalls: Math.min(previous.toolCalls, previous.failedCalls + (event.failed ? 1 : 0)),
          recent: previous.recent.map((call, i) => i !== index ? call : { ...call,
            status: event.failed ? "failed" : "complete",
            ...(Number.isFinite(event.executionMs) && event.executionMs! >= 0
              ? { executionMs: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(event.executionMs!)) } : {}) }) };
      }
    }
    this.value = { ...this.value, revision: previous.revision + 1 };
    return true;
  }

  finish(answer?: string): ProcessJobSubagentProgress {
    if (!this.sealed) {
      this.sealed = true;
      const open = this.value.recent.filter((call) => call.status === "running").length;
      const answerHead = answer === undefined ? undefined : this.safe(answer, 8_000, true);
      this.value = { ...this.value, revision: this.value.revision + 1,
        failedCalls: Math.min(this.value.toolCalls, this.value.failedCalls + open),
        recent: this.value.recent.map((call) => call.status === "running" ? { ...call, status: "failed" } : call),
        ...(answerHead === undefined ? {} : { answerHead, answerTruncated: Buffer.byteLength(answer!) > 8_000 }) };
    }
    return this.snapshot();
  }
}
