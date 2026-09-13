import type { ProcessJobSubagentProgress } from "@mono-agent/agent-contracts";
import { redactProcessOutput, redactProcessOutputLine } from "./process-output-redaction.js";
import { redactSecrets } from "./redact-secrets.js";

/** Private transient descriptors, never provider events or tool result bodies. */
export type SubagentProgressEvent =
  | { readonly type: "started"; readonly profile: string; readonly label?: string }
  | { readonly type: "tool_started"; readonly id: string; readonly toolName: string; readonly argsSummary?: string }
  | { readonly type: "tool_completed"; readonly id: string; readonly failed: boolean; readonly executionMs?: number };

type Call = ProcessJobSubagentProgress["recent"][number];

function utf8Head(value: string, bytes: number): string {
  return Buffer.from(value).subarray(0, bytes).toString("utf8").replace(/�$/u, "");
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
    } else {
      // IDs are opaque correlation only, never rendered; reject oversized ids rather than collide by truncation.
      if (typeof event.id !== "string" || Buffer.byteLength(event.id) > 256 || !event.id.trim()) return false;
      const index = previous.recent.findIndex((call) => call.id === event.id);
      if (event.type === "tool_started") {
        if (index !== -1) return false;
        const call: Call = { id: event.id, toolName: this.safe(event.toolName, 128), status: "running",
          ...(event.argsSummary ? { argsSummary: this.safe(event.argsSummary, 256) } : {}) };
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
