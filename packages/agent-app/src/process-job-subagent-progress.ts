import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import { isProcessJobSubagentRoute, type ProcessJobSubagentProgress } from "@mono-agent/agent-contracts";
import { redactProcessOutput, redactProcessOutputLine } from "./process-output-redaction.js";
import { redactSecrets } from "./redact-secrets.js";

/** Private transient descriptors, never provider events or tool result bodies. */
export type SubagentProgressEvent =
  | { readonly type: "started"; readonly profile: string; readonly label?: string }
  | { readonly type: "route"; readonly requested?: unknown; readonly executed?: unknown; readonly disposition?: unknown }
  | { readonly type: "tool_started"; readonly id: string; readonly toolName: string; readonly argsSummary?: string; readonly workdir?: string }
  | { readonly type: "tool_completed"; readonly id: string; readonly failed: boolean; readonly executionMs?: number };

type Call = ProcessJobSubagentProgress["recent"][number];

function utf8Head(value: string, bytes: number): string {
  return Buffer.from(value).subarray(0, bytes).toString("utf8").replace(/�$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, (character) => `\\${character}`);
}

interface PreviewRange {
  readonly start: number;
  readonly end: number;
}

function rangesOverlap(left: PreviewRange, right: PreviewRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function mergeOverlappingRanges(ranges: readonly PreviewRange[]): PreviewRange[] {
  const ordered = [...ranges].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: PreviewRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start >= previous.end) {
      merged.push({ ...range });
    } else if (range.end > previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: range.end };
    }
  }
  return merged;
}

function renderPreviewLiterals(
  scan: string,
  secrets: readonly string[],
  homePattern: RegExp | undefined,
  truncated: boolean,
): string {
  const homeRanges: PreviewRange[] = homePattern === undefined
    ? []
    : [...scan.matchAll(homePattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const literalRanges: PreviewRange[] = [];
  for (const secret of [...new Set(secrets)].filter((candidate) => candidate.length > 0)) {
    let start = scan.indexOf(secret);
    while (start >= 0) {
      literalRanges.push({ start, end: start + secret.length });
      start = scan.indexOf(secret, start + 1);
    }
    if (truncated) {
      const maximumPrefix = Math.min(secret.length - 1, scan.length);
      for (let length = maximumPrefix; length > 0; length -= 1) {
        if (!scan.endsWith(secret.slice(0, length))) continue;
        literalRanges.push({ start: scan.length - length, end: scan.length });
        break;
      }
    }
  }
  const extendingLiterals = literalRanges.filter((literal) =>
    !homeRanges.some((homeRange) => literal.start >= homeRange.start && literal.end <= homeRange.end));
  const survivingHomes = homeRanges.filter((homeRange) =>
    !extendingLiterals.some((literal) => rangesOverlap(homeRange, literal)));
  const survivingLiterals = mergeOverlappingRanges(literalRanges.filter((literal) => {
    const exactHomeLiteral = homeRanges.some((homeRange) =>
      literal.start === homeRange.start && literal.end === homeRange.end);
    return !exactHomeLiteral && !survivingHomes.some((homeRange) =>
      literal.start >= homeRange.start && literal.end <= homeRange.end);
  }));
  const replacements = [
    ...survivingLiterals.map((range) => ({ ...range, value: "[REDACTED]" })),
    ...survivingHomes.map((range) => ({ ...range, value: "~" })),
  ].sort((left, right) => left.start - right.start);
  const literalMarker = secrets.some((secret) => secret.length > 0 && "[REDACTED]".includes(secret)) ? "" : "[REDACTED]";
  let rendered = "";
  let cursor = 0;
  for (const replacement of replacements) {
    rendered += scan.slice(cursor, replacement.start);
    rendered += replacement.value === "[REDACTED]" ? literalMarker : replacement.value;
    cursor = replacement.end;
  }
  return rendered + scan.slice(cursor);
}

function finalizePreviewRedaction(value: string, secrets: readonly string[]): string {
  let current = value;
  // Rendering or a recognizer marker can assemble a known literal or credential
  // shape across a removed span. Iterate the real scrubbers to stability, then
  // fail closed rather than retain a pathological rewrite cycle.
  for (let pass = 0; pass < 8; pass += 1) {
    const recognized = redactProcessOutputLine(current, secrets);
    const literalsScrubbed = renderPreviewLiterals(recognized, secrets, undefined, false);
    if (literalsScrubbed === current) return current;
    current = literalsScrubbed;
  }
  return "[redacted]";
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
  const homePattern = root === "" || root === "/"
    ? undefined
    : new RegExp(`${escapeRegExp(root)}(?=/|$|\\s|["'])`, "gu");
  // Literal and home matches are both decided against the original bytes. An
  // extending literal cancels an overlapping home first; only literals contained
  // by a surviving home are then hidden by `~` (with exact-home literals always
  // suppressed so an overlap does not unnecessarily erase the whole root).
  const relativized = renderPreviewLiterals(scan, secrets, homePattern, truncated);
  const recognized = redactProcessOutputLine(redactProcessOutput(relativized, []), [])
    // `redactProcessOutput` intentionally bounds URL schemes; previews retain
    // the older unbounded userinfo backstop because route-like arguments can use
    // custom schemes of arbitrary length.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s]+)@/giu, "$1[REDACTED]@")
    // Restore the generic opaque-run boundary semantics above the approved
    // 24–39-character slash-bearing relaxation. Exempt only a run whose first
    // character is the slash in a genuine `~/...` path; the opaque lookbehind
    // prevents matching again from later within that same run.
    .replace(/(?!(?<=~)\/)(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-])/gu, "[REDACTED]")
    .replace(/(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{24,}(?![A-Za-z0-9_+=-])/gu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();
  const redacted = finalizePreviewRedaction(recognized, secrets);
  return redacted || "[redacted]";
}

const ROUTE_CREDENTIAL_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|A(?:KIA|SIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/u;
const ROUTE_SENSITIVE_LABEL = /^(?:password|passwd|secret|token|api[_-]?key|authorization|credential)$/iu;

function routeIdentifierIsSensitive(identifier: string, secrets: readonly string[]): boolean {
  const firstSeparator = identifier.indexOf(":");
  const sensitiveLabel = firstSeparator >= 0 && ROUTE_SENSITIVE_LABEL.test(identifier.slice(0, firstSeparator));
  return sensitiveLabel
    || secrets.some((secret) => secret.length > 0 && identifier.includes(secret))
    || ROUTE_CREDENTIAL_SHAPE.test(identifier);
}

function routePart(
  value: unknown,
  keys: readonly string[],
  secrets: readonly string[],
): Record<string, string> | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) return null;
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "string") return null;
    const identifier = record[key];
    // Route identifiers are config-shaped, but still cross a durable UI boundary.
    // Drop known literals and explicit credential shapes. The generic opaque-run
    // heuristic is intentionally excluded: long descriptive model ids are valid.
    if (routeIdentifierIsSensitive(identifier, secrets)) continue;
    result[key] = identifier;
  }
  return result;
}

/** Keep only an honestly priced, contract-bounded detached turn cost. */
export function pricedSubagentCostUsd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
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
      const requested = routePart(event.requested, ["model", "effort"], this.secrets);
      const executed = event.executed === undefined
        ? undefined
        : routePart(event.executed, ["model", "effort", "effectiveEffort"], this.secrets);
      if (requested === null || executed === null) return false;
      // Retain a fresh primitive-only snapshot. Empty executed objects add no
      // evidence and would incorrectly override a known requested route.
      const candidate = { requested: { ...requested },
        ...(executed === undefined || Object.keys(executed).length === 0 ? {} : { executed: { ...executed } }),
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
          ...(event.argsSummary ? { argsSummary: utf8Head(redactSubagentArgumentPreview(event.argsSummary, this.secrets), 256) } : {}),
          ...(event.workdir ? { workdir: utf8Head(redactSubagentArgumentPreview(event.workdir, this.secrets), 256) } : {}) };
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

  finish(answer?: string, costUsd?: number): ProcessJobSubagentProgress {
    if (!this.sealed) {
      this.sealed = true;
      const open = this.value.recent.filter((call) => call.status === "running").length;
      const answerHead = answer === undefined ? undefined : this.safe(answer, 8_000, true);
      const pricedCost = pricedSubagentCostUsd(costUsd);
      this.value = { ...this.value, revision: this.value.revision + 1,
        failedCalls: Math.min(this.value.toolCalls, this.value.failedCalls + open),
        recent: this.value.recent.map((call) => call.status === "running" ? { ...call, status: "failed" } : call),
        ...(pricedCost === undefined ? {} : { costUsd: pricedCost }),
        ...(answerHead === undefined ? {} : { answerHead, answerTruncated: Buffer.byteLength(answer!) > 8_000 }) };
    }
    return this.snapshot();
  }
}
