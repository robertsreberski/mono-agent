import { compactString } from "./content.js";
import { buildEventDescriptors } from "./event-classify.js";
import { DEFAULT_MAX_STRING_BYTES, isRecord, stringField } from "./guards.js";
import { redactJsonValue } from "./redaction.js";
import type {
  RecordedRunEventCategory,
  RunExportContext,
  RunSummary,
  RunSummaryStatus,
  RuntimeEventLike,
} from "./types.js";

/**
 * Pure, node-free event -> span attribute mapping for the Phoenix/OTLP export
 * surface. Imports ONLY node-free modules (event-classify/guards/redaction/
 * types) so the built `dist/run-export-mapping.js` stays browser-safe and can be
 * imported through the './run-export' subpath without dragging node:fs/node:path
 * into a browser graph. The concrete network transport lives in
 * @mono-agent/observability-otel; this module only shapes attribute bags.
 */

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;

export type SpanKindHint = "TOOL" | "LLM" | "INTERNAL";
export type SpanStatusHint = "ERROR" | "UNSET";

export interface EventSpanMapping {
  readonly name: string;
  readonly category: RecordedRunEventCategory;
  readonly attributes: SpanAttributes;
  /**
   * Only set when sensitive export is opt-in (includeSensitiveData=true). The
   * payload is STILL passed through `redactJsonValue` before it is attached, so
   * sensitive keys collapse to `[redacted]` even in opt-in mode.
   */
  readonly payload?: unknown;
}

/**
 * Build the root run span attribute bag (spec section 7 root keys). Optional
 * context fields are omitted entirely when absent (conditional spreads, never
 * `key: undefined`). `artifact_dir` is gated behind `includeSensitiveData`
 * because it discloses a local filesystem path ("only when explicitly allowed
 * for local debug").
 *
 * `warningsCount` is supplied by the caller via {@link countRuntimeWarnings};
 * it is intentionally EVENT-DERIVED (counting `type === 'runtime_warning'`)
 * rather than read from `summary.runtimeWarnings`, so the exported integer stays
 * stable regardless of the loosely-typed `runtimeWarnings` payload shape.
 */
export function buildRootSpanAttributes(
  summary: RunSummary,
  ctx: RunExportContext,
  warningsCount: number,
): SpanAttributes {
  return {
    "service.name": "mono-agent",
    "mono.agent.run_id": summary.runId,
    "mono.agent.conversation_id": summary.conversationId,
    ...(ctx.sourceId === undefined ? {} : { "mono.agent.source_id": ctx.sourceId }),
    ...(ctx.sourceLabel === undefined ? {} : { "mono.agent.source_label": ctx.sourceLabel }),
    ...(ctx.configPath === undefined ? {} : { "mono.agent.config_path": ctx.configPath }),
    "mono.agent.status": summary.status,
    ...(summary.failureKind === undefined ? {} : { "mono.agent.failure_kind": summary.failureKind }),
    ...(summary.providerSessionId === undefined || summary.providerSessionId === null
      ? {}
      : { "mono.agent.provider_session_id": summary.providerSessionId }),
    "mono.agent.events.count": summary.eventCount,
    "mono.agent.warnings.count": warningsCount,
    ...(ctx.includeSensitiveData && ctx.artifactDir !== undefined
      ? { "mono.agent.artifact_dir": ctx.artifactDir }
      : {}),
  };
}

/**
 * Build a per-event child span mapping. Category/label/summary are derived via
 * {@link buildEventDescriptors} (the single source of truth shared with the
 * recorded-run reader) so the export never re-derives classification logic.
 *
 * Provider/model latency events (e.g. `provider_bridge_latency`, `tool_timing`)
 * ride this generic per-event span path: they classify as `runtime` and become
 * ordinary child spans rather than a bespoke model span, satisfying spec 6.4's
 * "root span event" option without inventing a dedicated latency mapping.
 */
export function buildEventSpanAttributes(
  event: RuntimeEventLike,
  index: number,
  ctx: RunExportContext,
  maxStringBytes: number = DEFAULT_MAX_STRING_BYTES,
): EventSpanMapping {
  const { category, label, summary } = buildEventDescriptors(event, maxStringBytes);
  const eventType = typeof event.type === "string" ? event.type : "";
  const attributes: SpanAttributes = {
    "mono.agent.event.index": index,
    "mono.agent.event.type": eventType,
    "mono.agent.event.category": category,
    // `label` is structural (e.g. "Tool: Read", "Message: assistant") and safe
    // to always export. `summary` is content-derived (assistant text, tool-result
    // JSON, error text, delta), so it is gated behind includeSensitiveData — in
    // metadata-only mode it would otherwise leak run content the same way the raw
    // payload does. The structural `label` remains for navigation.
    "mono.agent.event.label": label,
    ...(ctx.includeSensitiveData ? { "mono.agent.event.summary": summary } : {}),
    "mono.agent.run_id": ctx.runId,
    ...(ctx.sourceId === undefined ? {} : { "mono.agent.source_id": ctx.sourceId }),
  };
  return {
    name: label,
    category,
    attributes,
    // Metadata-only by default: omit the raw payload entirely. When sensitive
    // export is opted in, STILL redact before attaching (spec section 7).
    ...(ctx.includeSensitiveData ? { payload: redactJsonValue(event, maxStringBytes) } : {}),
  };
}

const EXPORT_CONTENT_MAX_CHARS = 4_000;
const MIME_TEXT = "text/plain";
const MIME_JSON = "application/json";

/** OpenInference span kind for Phoenix rendering (LLM/TOOL/CHAIN) from a category. */
function openInferenceKind(category: RecordedRunEventCategory): string {
  switch (spanKindHint(category)) {
    case "TOOL":
      return "TOOL";
    case "LLM":
      return "LLM";
    case "INTERNAL":
      return "CHAIN";
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Serialize tool args/results to a bounded, redacted display string. */
function toContentString(value: unknown, maxStringBytes: number): string {
  const raw = typeof value === "string" ? value : JSON.stringify(redactJsonValue(value, maxStringBytes));
  return compactString(raw ?? "", EXPORT_CONTENT_MAX_CHARS);
}

function blockText(block: Record<string, unknown>): string {
  return asString(block.text) ?? asString(block.thinking) ?? asString(block.content) ?? "";
}

interface SpanDraft {
  readonly orderIndex: number;
  readonly mapping: EventSpanMapping;
}

interface ToolDraft {
  orderIndex: number;
  name: string;
  input: unknown;
  output?: unknown;
  executionMs?: number;
  isError?: boolean;
  toolUseId: string;
}

/**
 * Build child-span mappings for a run as a SEMANTIC timeline rather than one span
 * per raw event. Three things make the trace render nicely in Phoenix:
 *  - Streaming assistant deltas of the same kind are coalesced into one
 *    "Assistant thoughts" / "Assistant message" span carrying the full text.
 *  - A tool invocation's four raw events (assistant `tool_use`, `tool_timing`,
 *    and the `user` `tool_result`) are merged by `tool_use_id` into ONE TOOL
 *    span whose input is the tool args and output is the tool result.
 *  - Everything else (provider lifecycle, errors) passes through as a single
 *    CHAIN span via the shared classifier.
 * Each span carries OpenInference attributes (`openinference.span.kind`,
 * `input.value`/`output.value`) so Phoenix shows LLM/Tool/Chain blocks with real
 * content. Content is gated behind `includeSensitiveData`; structural labels are
 * always present. Output order follows each unit's first contributing event.
 */
export function buildEventSpans(
  events: readonly RuntimeEventLike[],
  ctx: RunExportContext,
  maxStringBytes: number = DEFAULT_MAX_STRING_BYTES,
): readonly EventSpanMapping[] {
  const drafts: SpanDraft[] = [];
  const tools = new Map<string, ToolDraft>();
  let buffer: { kind: "thinking" | "text"; orderIndex: number; texts: string[] } | undefined;

  const flushBuffer = (): void => {
    if (buffer === undefined) {
      return;
    }
    const isThinking = buffer.kind === "thinking";
    const category: RecordedRunEventCategory = isThinking ? "thinking" : "message";
    const label = isThinking ? "Assistant thoughts" : "Assistant message";
    const text = compactString(buffer.texts.join(""), EXPORT_CONTENT_MAX_CHARS);
    const sourceCount = buffer.texts.length;
    drafts.push({
      orderIndex: buffer.orderIndex,
      mapping: {
        name: label,
        category,
        attributes: {
          ...baseAttrs(ctx, buffer.orderIndex, isThinking ? "thinking" : "message", category, label),
          ...(sourceCount > 1 ? { "mono.agent.event.source_count": sourceCount } : {}),
          ...openInferenceAttrs(category, label, ctx.includeSensitiveData ? text : label, MIME_TEXT),
          ...(ctx.includeSensitiveData ? { "mono.agent.event.summary": text } : {}),
        },
      },
    });
    buffer = undefined;
  };

  const appendChunk = (kind: "thinking" | "text", orderIndex: number, text: string): void => {
    if (buffer !== undefined && buffer.kind !== kind) {
      flushBuffer();
    }
    if (buffer === undefined) {
      buffer = { kind, orderIndex, texts: [] };
    }
    buffer.texts.push(text);
  };

  const emitTool = (tool: ToolDraft): void => {
    const label = `Tool: ${tool.name}`;
    const inputValue = ctx.includeSensitiveData ? toContentString(tool.input, maxStringBytes) : label;
    const outputValue = ctx.includeSensitiveData
      ? toContentString(tool.output, maxStringBytes)
      : tool.isError === true
        ? "error"
        : "ok";
    drafts.push({
      orderIndex: tool.orderIndex,
      mapping: {
        name: label,
        category: "tool",
        attributes: {
          ...baseAttrs(ctx, tool.orderIndex, "tool", "tool", label),
          "mono.agent.tool.name": tool.name,
          "mono.agent.tool.use_id": tool.toolUseId,
          ...(tool.executionMs === undefined ? {} : { "mono.agent.tool.execution_ms": tool.executionMs }),
          ...(tool.isError === undefined ? {} : { "mono.agent.tool.is_error": tool.isError }),
          "tool.name": tool.name,
          ...openInferenceAttrs("tool", inputValue, outputValue, ctx.includeSensitiveData ? MIME_JSON : MIME_TEXT),
        },
      },
    });
  };

  events.forEach((event, index) => {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "tool_timing") {
      const id = stringField(event, "tool_use_id");
      const tool = id === undefined ? undefined : tools.get(id);
      if (tool !== undefined) {
        const ms = event.execution_ms;
        if (typeof ms === "number") {
          tool.executionMs = ms;
        }
        if (typeof event.is_error === "boolean") {
          tool.isError = event.is_error;
        }
      }
      return; // folds into the tool span; no standalone span
    }

    const message = isRecord(event.message) ? event.message : undefined;
    const content = message !== undefined && Array.isArray(message.content) ? message.content : undefined;
    if (content !== undefined) {
      let handled = false;
      for (const block of content) {
        if (!isRecord(block)) {
          continue;
        }
        if (block.type === "thinking") {
          appendChunk("thinking", index, blockText(block));
          handled = true;
        } else if (block.type === "text") {
          appendChunk("text", index, blockText(block));
          handled = true;
        } else if (block.type === "tool_use") {
          flushBuffer();
          const id = asString(block.id) ?? `tool-${index}`;
          tools.set(id, {
            orderIndex: index,
            name: asString(block.name) ?? "tool",
            input: block.input,
            toolUseId: id,
          });
          handled = true;
        } else if (block.type === "tool_result") {
          flushBuffer();
          const id = asString(block.tool_use_id);
          const tool = id === undefined ? undefined : tools.get(id);
          if (tool !== undefined) {
            tool.output = block.content;
            emitTool(tool);
            tools.delete(id!);
            handled = true;
          }
        }
      }
      if (handled) {
        return;
      }
    }

    // Generic event (provider lifecycle, errors, plain messages): one span.
    flushBuffer();
    const { category, label, summary } = buildEventDescriptors(event, maxStringBytes);
    drafts.push({
      orderIndex: index,
      mapping: {
        name: label,
        category,
        attributes: {
          ...baseAttrs(ctx, index, type, category, label),
          ...openInferenceAttrs(category, label, ctx.includeSensitiveData ? summary : label, MIME_TEXT),
          ...(ctx.includeSensitiveData ? { "mono.agent.event.summary": summary } : {}),
        },
        ...(ctx.includeSensitiveData ? { payload: redactJsonValue(event, maxStringBytes) } : {}),
      },
    });
  });

  flushBuffer();
  // Tools whose result never arrived still get a span (with what we captured).
  for (const tool of tools.values()) {
    emitTool(tool);
  }

  return drafts.sort((a, b) => a.orderIndex - b.orderIndex).map((draft) => draft.mapping);
}

function baseAttrs(
  ctx: RunExportContext,
  index: number,
  type: string,
  category: RecordedRunEventCategory,
  label: string,
): SpanAttributes {
  return {
    "mono.agent.event.index": index,
    "mono.agent.event.type": type,
    "mono.agent.event.category": category,
    "mono.agent.event.label": label,
    "mono.agent.run_id": ctx.runId,
    ...(ctx.sourceId === undefined ? {} : { "mono.agent.source_id": ctx.sourceId }),
  };
}

function openInferenceAttrs(
  category: RecordedRunEventCategory,
  inputValue: string,
  outputValue: string,
  inputMime: string = MIME_TEXT,
): SpanAttributes {
  return {
    "openinference.span.kind": openInferenceKind(category),
    "input.value": inputValue,
    "input.mime_type": inputMime,
    "output.value": outputValue,
    "output.mime_type": MIME_TEXT,
  };
}

/**
 * Count runtime warnings from the buffered event stream. Intentionally
 * event-derived (`type === 'runtime_warning'`) so the integer is stable and does
 * not depend on the loosely-typed `RunSummary.runtimeWarnings` payload shape.
 */
export function countRuntimeWarnings(events: readonly RuntimeEventLike[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "runtime_warning") {
      count += 1;
    }
  }
  return count;
}

/** Suggest an OTel span kind for a recorded-event category. */
export function spanKindHint(category: RecordedRunEventCategory): SpanKindHint {
  switch (category) {
    case "tool":
      return "TOOL";
    case "message":
    case "thinking":
      return "LLM";
    case "runtime":
    case "error":
      return "INTERNAL";
  }
}

/**
 * Derive a span status. A failed/cancelled run, or an `error`-category event,
 * maps to ERROR; everything else is UNSET. A `runtime_warning` event (which
 * classifies as `runtime`) on a succeeded run therefore never forces ERROR.
 */
export function spanStatusFor(
  status: RunSummaryStatus,
  category: RecordedRunEventCategory,
): SpanStatusHint {
  if (status === "failed" || status === "cancelled" || category === "error") {
    return "ERROR";
  }
  return "UNSET";
}
