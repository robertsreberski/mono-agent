import { NOTHING_TO_REPORT_SENTINEL } from "@mono-agent/agent-contracts";

import { compactString } from "./content.js";
import { isRecord } from "./guards.js";
import { deriveRunSource } from "./run-source.js";
import type { RunSummary, RuntimeEventLike } from "./types.js";

/**
 * Pure run -> UI "Session" mapping. Turns a recorded run ({@link RunSummary} plus
 * its raw {@link RuntimeEventLike} stream) into the {@link Session} model the web
 * visualizer renders. The event walk mirrors the export path's
 * `buildEventSpans` block folding (thinking/text coalesced, `tool_use` +
 * `tool_timing` + `tool_result` merged by `tool_use_id`) so the two surfaces
 * always agree on how a run decomposes.
 *
 * Tolerant of a partial/in-progress run: a `status:"running"` summary with no
 * usage/cost and a truncated event stream maps without throwing (open tool calls
 * keep `ok` undefined, a run with no assistant text is provisionally `silent`),
 * so the same function serves a live-streaming path.
 *
 * Not a redaction boundary: input events are assumed already redacted by the
 * caller (see `raw` on {@link SessionToolCall}); this function only shapes.
 */

/** Marker userInput carries when recalled long-term memory was appended to the trigger prompt. */
const RECALLED_MEMORY_MARKER = "[Recalled long-term memory";

/** Display cap for step/prompt/result/final text bodies. */
const TEXT_MAX_CHARS = 20_000;
/** Cap for a tool call's full (already-redacted) argument JSON string. */
const RAW_MAX_CHARS = 8_000;
/** Cap for a one-line digest of args/result. */
const DIGEST_MAX_CHARS = 120;
/** Cap for the derived run title. */
const TITLE_MAX_CHARS = 80;

export type SessionOutcome = "silent" | "notified";

/** One coalesced run of assistant thinking within an {@link SessionStep} assistant step. */
export interface SessionThink {
  readonly t: string;
  /** Set when `t` was capped for display. */
  readonly tr?: boolean;
}

/** A single tool invocation issued within an assistant step. */
export interface SessionToolCall {
  readonly id: string;
  readonly name: string;
  /** One-line digest of the arguments (first line, truncated ~120 chars). */
  readonly dig: string;
  /** Full (already-redacted) argument JSON string. */
  readonly raw: string;
  /** Set when `dig`/`raw` was capped for display. */
  readonly tr?: boolean;
  /** Resolved once the call's `tool_result`/`tool_timing` arrives; undefined while in-flight. */
  readonly ok?: boolean;
  /** Execution latency (ms) folded from a `tool_timing` event, when present. */
  readonly durMs?: number;
}

/** Per-assistant-step token/cost usage. Best-effort; omitted when not readily associable. */
export interface SessionStepUsage {
  readonly i: number;
  readonly o: number;
  readonly c: number;
  readonly cost: number;
}

/** Aggregate counters for a session. */
export interface SessionTotals {
  readonly asst: number;
  readonly tcalls: number;
  readonly think: number;
  readonly tokIn: number;
  readonly tokOut: number;
  readonly tokCache: number;
  readonly cost: number;
  readonly steps: number;
}

/** A single timeline entry in a {@link Session}. Discriminated on `k`. */
export type SessionStep =
  | {
      readonly k: "prompt";
      readonly ts: string;
      readonly text: string;
      readonly tr?: boolean;
      readonly chars?: number;
    }
  | {
      readonly k: "assistant";
      readonly ts: string;
      readonly think: readonly SessionThink[];
      readonly calls: readonly SessionToolCall[];
      readonly text: string;
      readonly ttr?: boolean;
      readonly model?: string;
      readonly stop?: string;
      readonly u?: SessionStepUsage;
    }
  | {
      readonly k: "result";
      readonly ts: string;
      readonly tcid: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly dig: string;
      readonly text: string;
      readonly tr?: boolean;
      readonly chars?: number;
    };

/** The UI "Session" model the web visualizer renders. */
export interface Session {
  readonly id: string;
  /** Trace-source id of the producing agent instance, when known. */
  readonly sourceId?: string;
  readonly cwd: string;
  readonly instance: string;
  readonly startTs: string;
  readonly durMs: number;
  readonly kind?: string;
  readonly trigger?: string;
  /** One of cron|webhook|chat|memory|slack|telegram|a2a|openai|tui|other. */
  readonly source: string;
  readonly title: string;
  readonly outcome: SessionOutcome;
  readonly model?: string;
  readonly provider?: string;
  readonly api?: string;
  readonly effort?: string;
  /** Trigger prompt (userInput minus the recalled-memory tail). */
  readonly instr: string;
  readonly instrTr?: boolean;
  readonly recalled?: string;
  readonly hasRecall: boolean;
  /** Last assistant text block content. */
  readonly finalText: string;
  readonly finalTr?: boolean;
  readonly status: string;
  readonly totals: SessionTotals;
  readonly toolCounts: Readonly<Record<string, number>>;
  readonly steps: readonly SessionStep[];
}

export interface MapRunToSessionOptions {
  /** Trace-source id of the producing agent instance, used for stable cross-instance identity. */
  readonly sourceId?: string;
  /** Which agent instance this run belongs to (display label). */
  readonly instanceLabel: string;
  /** Working directory the run executed in, when known. */
  readonly cwd?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A bare slug id: letters/digits with -/_ separators, no channel prefix. */
const SLUG_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i;

/**
 * A run's channel `source`, robust to legacy summaries that predate per-run
 * source stamping. Prefers the persisted `summary.source`; else derives it from
 * the conversationId:
 *  - Daily session rollover appends a "#<partition>" suffix (e.g.
 *    "p2-notifications-check#2026-07-02"); it is not channel-specific, so it is
 *    stripped before classification.
 *  - A recognised channel prefix ("cron:"/"memory:"/"telegram:"/"slack:"/…) wins
 *    (via {@link deriveRunSource}).
 *  - A remaining BARE slug id (no prefix, not a UUID) is, in practice, a cron job
 *    id — scheduled jobs (each a fixed slug that runs repeatedly) are the
 *    overwhelming majority of runs recorded before source stamping. A "…-tui"
 *    slug is a TUI session. Prefixed and UUID ids never reach this branch, so
 *    real chat/webhook/openai runs (UUID or prefixed conversationIds) stay
 *    correctly classified rather than being swept into cron.
 */
function refineRunSource(summary: RunSummary): string {
  if (summary.source !== undefined && summary.source.length > 0) {
    return summary.source;
  }
  const cid = summary.conversationId ?? "";
  const hashIdx = cid.indexOf("#");
  const base = hashIdx >= 0 ? cid.slice(0, hashIdx) : cid;
  const derived = deriveRunSource(base);
  if (derived !== "other") {
    return derived;
  }
  if (base.length > 0 && !base.includes(":") && !UUID_RE.test(base) && SLUG_RE.test(base)) {
    return /(?:^|[-_])tui$/i.test(base) ? "tui" : "cron";
  }
  return "other";
}

/**
 * Map a recorded run into the UI {@link Session} model. Pure and total: never
 * throws on a partial/running summary or a truncated event stream.
 */
export function mapRunToSession(
  summary: RunSummary,
  events: readonly RuntimeEventLike[],
  opts: MapRunToSessionOptions,
): Session {
  const { instrRaw, recalledRaw, hasRecall } = splitUserInput(summary.userInput);
  const walk = walkEvents(summary, events);

  const finalClamp = clampText(walk.finalTextRaw, TEXT_MAX_CHARS);
  const outcome = resolveOutcome(walk.finalTextRaw);

  const instrClamp = clampText(instrRaw, TEXT_MAX_CHARS);
  const steps: SessionStep[] = [...walk.steps];
  if (instrRaw.trim().length > 0) {
    steps.unshift({
      k: "prompt",
      ts: summary.startedAt ?? "",
      text: instrClamp.text,
      ...(instrClamp.truncated ? { tr: true } : {}),
      chars: instrRaw.length,
    });
  }

  const totals: SessionTotals = {
    asst: walk.asstCount,
    tcalls: walk.tcallCount,
    think: walk.thinkCount,
    ...tokenTotals(summary.usage),
    cost: resolveCost(summary),
    steps: events.length,
  };

  const modelRef = parseModelRef(summary.model);
  const titleSource = instrRaw.trim().length > 0 ? instrRaw : walk.finalTextRaw;
  const title = compactString(titleSource, TITLE_MAX_CHARS) || summary.runId;

  return {
    id: summary.runId,
    ...(opts.sourceId === undefined ? {} : { sourceId: opts.sourceId }),
    cwd: opts.cwd ?? "",
    instance: opts.instanceLabel,
    startTs: summary.startedAt ?? "",
    durMs: summary.durationMs,
    ...(summary.sourceDetail === undefined ? {} : { trigger: summary.sourceDetail }),
    source: refineRunSource(summary),
    title,
    outcome,
    ...(summary.model === undefined ? {} : { model: summary.model }),
    ...modelRef,
    ...(summary.effort === undefined ? {} : { effort: summary.effort }),
    instr: instrClamp.text,
    ...(instrClamp.truncated ? { instrTr: true } : {}),
    ...(recalledRaw === undefined ? {} : { recalled: clampText(recalledRaw, TEXT_MAX_CHARS).text }),
    hasRecall,
    finalText: finalClamp.text,
    ...(finalClamp.truncated ? { finalTr: true } : {}),
    status: summary.status,
    totals,
    toolCounts: walk.toolCounts,
    steps,
  };
}

interface MutableToolCall {
  id: string;
  name: string;
  input: unknown;
  ok?: boolean;
  durMs?: number;
}

interface AssistantWork {
  readonly ts: string;
  readonly think: string[];
  readonly calls: MutableToolCall[];
  readonly textParts: string[];
  // Nullable-required (not optional) so `undefined` can be reassigned on commit
  // under exactOptionalPropertyTypes.
  buffer: { kind: "thinking" | "text"; texts: string[] } | undefined;
}

/**
 * A step captured mid-walk. An assistant step keeps LIVE {@link MutableToolCall}
 * references (not finalized snapshots) so a `tool_result`/`tool_timing` arriving
 * AFTER the step is flushed — e.g. the second half of a parallel tool batch —
 * still backfills the call's `ok`/`durMs`. Calls are finalized once, after the
 * whole stream is walked. Result steps are already immutable at capture time.
 */
type PendingStep =
  | {
      readonly p: "assistant";
      readonly ts: string;
      readonly think: readonly SessionThink[];
      readonly calls: readonly MutableToolCall[];
      readonly text: string;
      readonly ttr: boolean;
    }
  | { readonly p: "result"; readonly step: Extract<SessionStep, { k: "result" }> };

interface WalkResult {
  readonly steps: readonly SessionStep[];
  readonly toolCounts: Readonly<Record<string, number>>;
  readonly asstCount: number;
  readonly tcallCount: number;
  readonly thinkCount: number;
  readonly finalTextRaw: string;
}

/**
 * Walk the raw event stream into semantic {@link SessionStep}s. Adjacent
 * thinking/text chunks of the same kind coalesce (streaming deltas), `tool_use`
 * blocks accumulate into the open assistant step, and a `tool_result` both emits
 * a `result` step and closes the assistant turn that issued the call — the next
 * assistant content starts a fresh step. `tool_timing` folds latency/error into
 * the matching call by `tool_use_id` (which may already sit in a flushed step —
 * the call object is shared by reference, so the backfill still lands).
 */
function walkEvents(summary: RunSummary, events: readonly RuntimeEventLike[]): WalkResult {
  const pending: PendingStep[] = [];
  const callsById = new Map<string, MutableToolCall>();
  const toolCounts: Record<string, number> = {};
  const fallbackTs = summary.startedAt ?? "";
  let asstCount = 0;
  let tcallCount = 0;
  let thinkCount = 0;
  let finalTextRaw = "";
  let current: AssistantWork | undefined;

  const commitBuffer = (work: AssistantWork): void => {
    if (work.buffer === undefined) return;
    const joined = work.buffer.texts.join("");
    if (work.buffer.kind === "thinking") work.think.push(joined);
    else work.textParts.push(joined);
    work.buffer = undefined;
  };

  const ensureCurrent = (ts: string): AssistantWork => {
    if (current === undefined) current = { ts, think: [], calls: [], textParts: [], buffer: undefined };
    return current;
  };

  const appendChunk = (ts: string, kind: "thinking" | "text", text: string): void => {
    const work = ensureCurrent(ts);
    if (work.buffer !== undefined && work.buffer.kind !== kind) commitBuffer(work);
    if (work.buffer === undefined) work.buffer = { kind, texts: [] };
    work.buffer.texts.push(text);
  };

  const flushCurrent = (): void => {
    if (current === undefined) return;
    const work = current;
    current = undefined;
    commitBuffer(work);
    const textFull = work.textParts.join("");
    if (work.think.length === 0 && work.calls.length === 0 && textFull.length === 0) {
      return; // nothing of substance — don't emit an empty assistant step
    }
    const think: SessionThink[] = work.think.map((run) => {
      const clamp = clampText(run, TEXT_MAX_CHARS);
      return { t: clamp.text, ...(clamp.truncated ? { tr: true } : {}) };
    });
    thinkCount += think.length;
    const textClamp = clampText(textFull, TEXT_MAX_CHARS);
    if (textFull.length > 0) finalTextRaw = textFull;
    // Keep the live call references — finalized after the walk so late
    // tool_result/tool_timing backfills land (see PendingStep).
    pending.push({ p: "assistant", ts: work.ts, think, calls: work.calls, text: textClamp.text, ttr: textClamp.truncated });
    asstCount += 1;
  };

  events.forEach((event, index) => {
    const type = typeof event.type === "string" ? event.type : "";
    const ts = eventTimestamp(event, fallbackTs);

    if (type === "tool_timing") {
      const id = readString(event.tool_use_id);
      const call = id === undefined ? undefined : callsById.get(id);
      if (call !== undefined) {
        const ms = event.execution_ms;
        if (typeof ms === "number" && Number.isFinite(ms)) call.durMs = ms;
        if (typeof event.is_error === "boolean") call.ok = !event.is_error;
      }
      return; // folds into the call; no standalone step
    }

    const message = isRecord(event.message) ? event.message : undefined;
    const content = message !== undefined && Array.isArray(message.content) ? message.content : undefined;
    if (content === undefined) return; // lifecycle/warning/foreign event — no semantic step

    for (const [blockIndex, block] of content.entries()) {
      if (!isRecord(block)) continue;
      const isAssistantEvent = type === "assistant";
      if (block.type === "thinking") {
        if (!isAssistantEvent) continue;
        appendChunk(ts, "thinking", blockText(block));
      } else if (block.type === "text") {
        if (!isAssistantEvent) continue;
        if (readString(block.phase) === "commentary") continue;
        appendChunk(ts, "text", blockText(block));
      } else if (block.type === "tool_use") {
        if (!isAssistantEvent) continue;
        const work = ensureCurrent(ts);
        commitBuffer(work);
        const id = readString(block.id) ?? `tool-${index}-${blockIndex}`;
        const name = readString(block.name) ?? "tool";
        const call: MutableToolCall = { id, name, input: block.input };
        work.calls.push(call);
        callsById.set(id, call);
        tcallCount += 1;
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      } else if (block.type === "tool_result") {
        flushCurrent();
        const tcid = readString(block.tool_use_id) ?? "";
        const linked = tcid.length === 0 ? undefined : callsById.get(tcid);
        const isError = block.is_error === true;
        if (linked !== undefined && linked.ok === undefined) linked.ok = !isError;
        const contentText = toolResultText(block.content);
        const clamp = clampText(contentText, TEXT_MAX_CHARS);
        pending.push({
          p: "result",
          step: {
            k: "result",
            ts,
            tcid,
            tool: linked?.name ?? "tool",
            ok: !isError,
            dig: digest(contentText).dig,
            text: clamp.text,
            ...(clamp.truncated ? { tr: true } : {}),
            chars: contentText.length,
          },
        });
      }
    }
  });

  flushCurrent();

  // All backfills have landed; snapshot each live call into its immutable step.
  const steps: SessionStep[] = pending.map((item) =>
    item.p === "result"
      ? item.step
      : {
          k: "assistant",
          ts: item.ts,
          think: item.think,
          calls: item.calls.map(finalizeCall),
          text: item.text,
          ...(item.ttr ? { ttr: true } : {}),
          ...(summary.model === undefined ? {} : { model: summary.model }),
        },
  );

  return { steps, toolCounts, asstCount, tcallCount, thinkCount, finalTextRaw };
}

function finalizeCall(call: MutableToolCall): SessionToolCall {
  const rawFull = stringifyInput(call.input);
  const rawClamp = clampText(rawFull, RAW_MAX_CHARS);
  const dig = digest(rawFull);
  const truncated = rawClamp.truncated || dig.truncated;
  return {
    id: call.id,
    name: call.name,
    dig: dig.dig,
    raw: rawClamp.text,
    ...(truncated ? { tr: true } : {}),
    ...(call.ok === undefined ? {} : { ok: call.ok }),
    ...(call.durMs === undefined ? {} : { durMs: call.durMs }),
  };
}

/** Split userInput into the trigger prompt (`instr`) and the recalled-memory tail. */
function splitUserInput(userInput: string | undefined): {
  readonly instrRaw: string;
  readonly recalledRaw?: string;
  readonly hasRecall: boolean;
} {
  const raw = userInput ?? "";
  const idx = raw.indexOf(RECALLED_MEMORY_MARKER);
  if (idx >= 0) {
    return { instrRaw: raw.slice(0, idx).trimEnd(), recalledRaw: raw.slice(idx), hasRecall: true };
  }
  return { instrRaw: raw.trimEnd(), hasRecall: false };
}

/** Silent when the final assistant text is empty or the NOTHING_TO_REPORT sentinel (trimmed, case-insensitive). */
function resolveOutcome(finalTextRaw: string): SessionOutcome {
  const trimmed = finalTextRaw.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === NOTHING_TO_REPORT_SENTINEL.toLowerCase()) {
    return "silent";
  }
  return "notified";
}

/**
 * Best-effort parse of a `sdk:provider:model` reference. `api` = the sdk segment
 * (e.g. "pi"), `provider` = the provider segment (e.g. "ollama"). Omits both when
 * the reference has fewer than two colon-separated segments (unparseable) — the
 * UI shows "—" for absent fields.
 */
function parseModelRef(ref: string | undefined): { readonly api?: string; readonly provider?: string } {
  if (ref === undefined) return {};
  const parts = ref.split(":");
  if (parts.length < 2) return {};
  const api = parts[0]?.trim();
  const provider = parts[1]?.trim();
  return {
    ...(api === undefined || api.length === 0 ? {} : { api }),
    ...(provider === undefined || provider.length === 0 ? {} : { provider }),
  };
}

/**
 * Token totals from the run's usage record. Usage values may be redaction
 * placeholders (e.g. the string "[redacted]") or null on a partial run, so every
 * field coerces non-finite input to 0. `tokCache` sums cache read + creation.
 */
function tokenTotals(usage: unknown): { readonly tokIn: number; readonly tokOut: number; readonly tokCache: number } {
  const record = isRecord(usage) ? usage : {};
  return {
    tokIn: finiteNumber(record.input_tokens) ?? 0,
    tokOut: finiteNumber(record.output_tokens) ?? 0,
    tokCache: (finiteNumber(record.cache_read_tokens) ?? 0) + (finiteNumber(record.cache_creation_tokens) ?? 0),
  };
}

/** Prefer the observer aggregate `cost.cumulativeUsd`, else `usage.cost_usd`, else 0. */
function resolveCost(summary: RunSummary): number {
  const fromCost = isRecord(summary.cost) ? finiteNumber(summary.cost.cumulativeUsd) : undefined;
  if (fromCost !== undefined) return fromCost;
  const fromUsage = isRecord(summary.usage) ? finiteNumber(summary.usage.cost_usd) : undefined;
  return fromUsage ?? 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function blockText(block: Record<string, unknown>): string {
  return readString(block.text) ?? readString(block.thinking) ?? readString(block.content) ?? "";
}

/** Serialize a tool's arguments to a string. Strings pass through; objects JSON-encode (empty on failure). */
function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "";
  }
}

/**
 * Render a `tool_result.content` to display text. The pi runtime shape is a
 * `[{type:"text",text}]` array (join all when EVERY block is text, so a partial
 * join never silently drops non-text content); codex-style results carry a plain
 * string. Anything else JSON-encodes.
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else {
        return safeJson(content);
      }
    }
    return texts.join("");
  }
  return safeJson(content);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

/** Cap a display string to `max` characters, reporting whether it was truncated. Preserves newlines. */
function clampText(value: string, max: number): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

/** One-line digest: the first line, capped to {@link DIGEST_MAX_CHARS}. `truncated` when content was dropped. */
function digest(value: string): { readonly dig: string; readonly truncated: boolean } {
  const newlineAt = value.search(/\r?\n/u);
  const firstLine = newlineAt === -1 ? value : value.slice(0, newlineAt);
  const hadMore = firstLine.length < value.length;
  if (firstLine.length <= DIGEST_MAX_CHARS) {
    return { dig: firstLine, truncated: hadMore };
  }
  return { dig: `${firstLine.slice(0, DIGEST_MAX_CHARS)}…`, truncated: true };
}

/**
 * Extract an event timestamp (raw events carry `timestamp`/`createdAt`/`time` as
 * an ISO string or an epoch number), falling back to the run's start. Best-effort:
 * an unrecognized shape yields the fallback rather than an error.
 */
function eventTimestamp(event: RuntimeEventLike, fallback: string): string {
  const raw = event.timestamp ?? event.createdAt ?? event.time;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  return fallback;
}
