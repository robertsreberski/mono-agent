import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRunReadableSpans, createDeterministicIdFactory } from "@mono-agent/observability/otel";
import type { RunSummary } from "@mono-agent/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backfillRuns, isRetryable, readRunArtifacts, runStartEndNanos } from "../backfill.js";

const summary: RunSummary = {
  runId: "run-x",
  conversationId: "conv-x",
  status: "succeeded",
  durationMs: 1000,
  eventCount: 2,
  artifactPaths: [],
  startedAt: "2026-06-18T00:00:00.000Z",
  endedAt: "2026-06-18T00:00:01.000Z",
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backfill-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRun(runId: string, sum: RunSummary, eventLines: string[]): Promise<void> {
  await writeRunIn(dir, runId, sum, eventLines);
}

async function writeRunIn(root: string, runId: string, sum: RunSummary, eventLines: string[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${runId}.summary.json`), JSON.stringify(sum));
  if (eventLines.length > 0) {
    await writeFile(join(root, `${runId}.events.jsonl`), eventLines.join("\n") + "\n");
  }
}

describe("readRunArtifacts", () => {
  it("parses the summary and raw event lines", async () => {
    await writeRun("run-x", summary, [
      JSON.stringify({ type: "tool_call", name: "Read" }),
      JSON.stringify({ type: "assistant", text: "hi" }),
    ]);

    const { summary: parsed, events, warnings } = await readRunArtifacts(dir, "run-x");
    expect(parsed.runId).toBe("run-x");
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("tool_call");
    expect(warnings).toHaveLength(0);
  });

  it("skips malformed event lines with a warning", async () => {
    await writeRun("run-x", summary, [JSON.stringify({ type: "tool_call" }), "{not json"]);

    const { events, warnings } = await readRunArtifacts(dir, "run-x");
    expect(events).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/malformed/iu);
  });

  it("tolerates a missing events file (root-span-only) with a warning", async () => {
    await writeRun("run-x", summary, []);

    const { events, warnings } = await readRunArtifacts(dir, "run-x");
    expect(events).toHaveLength(0);
    expect(warnings.join("\n")).toMatch(/no .*events/iu);
  });

  it("finds memory namespace artifacts for an explicit run id", async () => {
    await writeRunIn(join(dir, "memory"), "mem-new", {
      ...summary,
      runId: "mem-new",
      conversationId: "memory:capture:distill",
    }, [JSON.stringify({ type: "assistant", text: "memory" })]);

    const { summary: parsed, events } = await readRunArtifacts(dir, "mem-new");

    expect(parsed.runId).toBe("mem-new");
    expect(parsed.conversationId).toBe("memory:capture:distill");
    expect(events).toHaveLength(1);
  });
});

describe("runStartEndNanos", () => {
  it("derives nanos from startedAt/endedAt", () => {
    const { start, end } = runStartEndNanos(summary);
    expect(start).toBe(BigInt(Date.parse("2026-06-18T00:00:00.000Z")) * 1_000_000n);
    expect(end).toBe(BigInt(Date.parse("2026-06-18T00:00:01.000Z")) * 1_000_000n);
  });

  it("falls back to startedAt + durationMs when endedAt is missing", () => {
    const { endedAt: _omit, ...noEnd } = summary;
    const { start, end } = runStartEndNanos(noEnd as RunSummary);
    expect(start).toBe(BigInt(Date.parse("2026-06-18T00:00:00.000Z")) * 1_000_000n);
    expect(end).toBe(BigInt(Date.parse("2026-06-18T00:00:00.000Z") + 1000) * 1_000_000n);
  });
});

describe("isRetryable", () => {
  it("retries transient OTLP statuses (Phoenix 503 backpressure, 429, 5xx) and network errors", () => {
    expect(isRetryable(new Error("OTLP export failed: http://x responded 503"))).toBe(true);
    expect(isRetryable(new Error("OTLP export failed: http://x responded 429"))).toBe(true);
    expect(isRetryable(new Error("OTLP export failed: http://x responded 500"))).toBe(true);
    expect(isRetryable(new Error("network down"))).toBe(true);
  });

  it("does not retry permanent client errors (415 wrong content type, 422, 404)", () => {
    expect(isRetryable(new Error("OTLP export failed: http://x responded 415"))).toBe(false);
    expect(isRetryable(new Error("OTLP export failed: http://x responded 422"))).toBe(false);
    expect(isRetryable(new Error("OTLP export failed: http://x responded 404"))).toBe(false);
  });
});

describe("backfill mapping integration", () => {
  it("maps parsed artifacts to one root span plus one child per event", async () => {
    await writeRun("run-x", summary, [
      JSON.stringify({ type: "tool_call", name: "Read" }),
      JSON.stringify({ type: "assistant", text: "hi" }),
    ]);
    const { summary: parsed, events } = await readRunArtifacts(dir, "run-x");
    const { start, end } = runStartEndNanos(parsed);
    const spans = buildRunReadableSpans({
      summary: parsed,
      events,
      context: { runId: parsed.runId, conversationId: parsed.conversationId, includeSensitiveData: false },
      projectName: "local-agent-alpha",
      startTimeUnixNanos: start,
      endTimeUnixNanos: end,
      idFactory: createDeterministicIdFactory(parsed.runId),
    });
    expect(spans).toHaveLength(1 + events.length);
    // Historical timestamps, not wall-clock now().
    expect(spans[0]!.startTime[0]).toBe(Math.trunc(Date.parse("2026-06-18T00:00:00.000Z") / 1000));
  });

  it("exports agent runs by default for --all and includes memory runs with includeMemory", async () => {
    const cwd = join(dir, "consumer");
    await mkdir(cwd, { recursive: true });
    const artifactDir = join(cwd, "artifacts");
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(join(cwd, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeFile(configPath, JSON.stringify({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      artifacts: { dir: "./artifacts" },
      observability: { exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:9/v1/traces" }] },
    }), "utf8");
    await writeRunIn(artifactDir, "run-agent", { ...summary, runId: "run-agent", conversationId: "chat" }, []);
    await writeRunIn(artifactDir, "mem-legacy", {
      ...summary,
      runId: "mem-legacy",
      conversationId: "memory:capture:distill",
    }, []);
    await writeRunIn(join(artifactDir, "memory"), "mem-new", {
      ...summary,
      runId: "mem-new",
      conversationId: "memory:capture:entities",
    }, []);

    const input = { env: {}, cwd, configPath };
    const agentOnly = await backfillRuns(input, { all: true, dryRun: true });
    const all = await backfillRuns(input, { all: true, dryRun: true, includeMemory: true });
    const explicitMemory = await backfillRuns(input, { run: "mem-new", dryRun: true });

    expect(agentOnly.outcomes.map((outcome) => outcome.runId)).toEqual(["run-agent"]);
    expect(all.outcomes.map((outcome) => outcome.runId).sort()).toEqual(["mem-legacy", "mem-new", "run-agent"]);
    expect(explicitMemory.outcomes).toHaveLength(1);
    expect(explicitMemory.outcomes[0]).toMatchObject({ runId: "mem-new", status: "ok" });
  });
});
