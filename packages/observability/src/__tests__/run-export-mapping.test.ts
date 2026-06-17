import { describe, expect, it } from "vitest";

import {
  buildEventSpanAttributes,
  buildRootSpanAttributes,
  countRuntimeWarnings,
  spanKindHint,
  spanStatusFor,
} from "../run-export-mapping.js";
import type { RunExportContext, RunSummary } from "../types.js";

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    conversationId: "chat-1",
    status: "succeeded",
    durationMs: 10,
    eventCount: 3,
    artifactPaths: [],
    ...overrides,
  };
}

function makeContext(overrides: Partial<RunExportContext> = {}): RunExportContext {
  return {
    runId: "run-1",
    conversationId: "chat-1",
    includeSensitiveData: false,
    ...overrides,
  };
}

describe("buildRootSpanAttributes", () => {
  it("emits core identifiers and omits optional context when absent", () => {
    const attrs = buildRootSpanAttributes(makeSummary(), makeContext(), 2);
    expect(attrs).toMatchObject({
      "service.name": "mono-agent",
      "mono.agent.run_id": "run-1",
      "mono.agent.conversation_id": "chat-1",
      "mono.agent.status": "succeeded",
      "mono.agent.events.count": 3,
      "mono.agent.warnings.count": 2,
    });
    expect(attrs).not.toHaveProperty("mono.agent.source_id");
    expect(attrs).not.toHaveProperty("mono.agent.source_label");
    expect(attrs).not.toHaveProperty("mono.agent.config_path");
    expect(attrs).not.toHaveProperty("mono.agent.failure_kind");
    expect(attrs).not.toHaveProperty("mono.agent.provider_session_id");
    expect(attrs).not.toHaveProperty("mono.agent.artifact_dir");
  });

  it("includes optional context fields when present", () => {
    const attrs = buildRootSpanAttributes(
      makeSummary({ failureKind: "provider_error", status: "failed", providerSessionId: "sess-9" }),
      makeContext({ sourceId: "src-1", sourceLabel: "Telegram", configPath: "/etc/agent.json" }),
      0,
    );
    expect(attrs).toMatchObject({
      "mono.agent.source_id": "src-1",
      "mono.agent.source_label": "Telegram",
      "mono.agent.config_path": "/etc/agent.json",
      "mono.agent.status": "failed",
      "mono.agent.failure_kind": "provider_error",
      "mono.agent.provider_session_id": "sess-9",
    });
  });

  it("includes artifact_dir only when includeSensitiveData is true", () => {
    const without = buildRootSpanAttributes(makeSummary(), makeContext({ artifactDir: "/runs" }), 0);
    expect(without).not.toHaveProperty("mono.agent.artifact_dir");

    const withSensitive = buildRootSpanAttributes(
      makeSummary(),
      makeContext({ artifactDir: "/runs", includeSensitiveData: true }),
      0,
    );
    expect(withSensitive["mono.agent.artifact_dir"]).toBe("/runs");
  });
});

describe("buildEventSpanAttributes", () => {
  it("classifies a tool event with label and TOOL kind hint", () => {
    const result = buildEventSpanAttributes(
      { type: "tool.call", toolName: "Read", status: "started" },
      0,
      makeContext({ sourceId: "src-1" }),
    );
    expect(result.attributes["mono.agent.event.index"]).toBe(0);
    expect(result.attributes["mono.agent.event.type"]).toBe("tool.call");
    expect(result.attributes["mono.agent.event.category"]).toBe("tool");
    expect(result.attributes["mono.agent.event.label"]).toBe("Tool: Read");
    expect(result.attributes["mono.agent.run_id"]).toBe("run-1");
    expect(result.attributes["mono.agent.source_id"]).toBe("src-1");
    expect(spanKindHint(result.category)).toBe("TOOL");
  });

  it("classifies an assistant text event as message", () => {
    const result = buildEventSpanAttributes(
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      1,
      makeContext(),
    );
    expect(result.category).toBe("message");
    expect(spanKindHint(result.category)).toBe("LLM");
  });

  it("classifies thinking blocks as thinking", () => {
    const result = buildEventSpanAttributes(
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
      2,
      makeContext(),
    );
    expect(result.category).toBe("thinking");
    expect(spanKindHint(result.category)).toBe("LLM");
  });

  it("classifies a real runtime_warning event (with a message field) as runtime, not message", () => {
    // Mirror the canonical harness shape: runtime_warning events carry a
    // `message` string. They must map to a runtime span, not an LLM/message span.
    const result = buildEventSpanAttributes(
      { type: "runtime_warning", warning_kind: "memory_degraded", message: "Memory recall failed; continuing without memory." },
      3,
      makeContext(),
    );
    expect(result.category).toBe("runtime");
    expect(spanStatusFor("succeeded", result.category)).not.toBe("ERROR");
  });

  it("treats provider latency events via the generic runtime span path", () => {
    const result = buildEventSpanAttributes(
      { type: "provider_bridge_latency", latencyMs: 1234 },
      4,
      makeContext(),
    );
    expect(result.category).toBe("runtime");
    expect(spanKindHint(result.category)).toBe("INTERNAL");
  });

  it("omits raw payload when includeSensitiveData is false (metadata-only)", () => {
    const result = buildEventSpanAttributes(
      { type: "tool.call", toolName: "Read", apiKey: "secret-value" },
      0,
      makeContext({ includeSensitiveData: false }),
    );
    expect(result.payload).toBeUndefined();
  });

  it("includes a redacted payload when includeSensitiveData is true", () => {
    const result = buildEventSpanAttributes(
      { type: "tool.call", toolName: "Read", apiKey: "secret-value" },
      0,
      makeContext({ includeSensitiveData: true }),
    );
    expect(result.payload).toBeDefined();
    expect(JSON.stringify(result.payload)).not.toContain("secret-value");
    expect(JSON.stringify(result.payload)).toContain("[redacted]");
  });
});

describe("countRuntimeWarnings", () => {
  it("counts only events whose type is runtime_warning", () => {
    const count = countRuntimeWarnings([
      { type: "runtime_warning", summary: "a" },
      { type: "tool.call" },
      { type: "runtime_warning", summary: "b" },
      { type: "assistant" },
    ]);
    expect(count).toBe(2);
  });

  it("returns 0 when there are no warnings", () => {
    expect(countRuntimeWarnings([{ type: "tool.call" }])).toBe(0);
  });
});

describe("spanStatusFor", () => {
  it("maps failed/cancelled run status to ERROR", () => {
    expect(spanStatusFor("failed", "runtime")).toBe("ERROR");
    expect(spanStatusFor("cancelled", "runtime")).toBe("ERROR");
  });

  it("maps error event category to ERROR", () => {
    expect(spanStatusFor("succeeded", "error")).toBe("ERROR");
  });

  it("maps succeeded run with non-error category to UNSET", () => {
    expect(spanStatusFor("succeeded", "runtime")).toBe("UNSET");
  });
});
