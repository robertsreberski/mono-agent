import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mapRunToSession } from "../session-mapping.js";
import type { SessionStep } from "../session-mapping.js";
import type { RunSummary, RuntimeEventLike } from "../types.js";

/** Load a fixture summary + its raw event stream (one JSON object per JSONL line). */
function loadFixture(name: string): { summary: RunSummary; events: RuntimeEventLike[] } {
  const summaryUrl = new URL(`./fixtures/${name}.summary.json`, import.meta.url);
  const eventsUrl = new URL(`./fixtures/${name}.events.jsonl`, import.meta.url);
  const summary = JSON.parse(readFileSync(fileURLToPath(summaryUrl), "utf8")) as RunSummary;
  const events = readFileSync(fileURLToPath(eventsUrl), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RuntimeEventLike);
  return { summary, events };
}

const OPTS = { instanceLabel: "downloads-curator", cwd: "/repo" } as const;

/** Narrow a step union to its assistant variant for typed assertions. */
function assistantSteps(steps: readonly SessionStep[]): Extract<SessionStep, { k: "assistant" }>[] {
  return steps.filter((step): step is Extract<SessionStep, { k: "assistant" }> => step.k === "assistant");
}

function resultSteps(steps: readonly SessionStep[]): Extract<SessionStep, { k: "result" }>[] {
  return steps.filter((step): step is Extract<SessionStep, { k: "result" }> => step.k === "result");
}

function boundarySteps(steps: readonly SessionStep[]): Extract<SessionStep, { k: "boundary" }>[] {
  return steps.filter((step): step is Extract<SessionStep, { k: "boundary" }> => step.k === "boundary");
}

describe("mapRunToSession", () => {
  it("maps a real notified run with a tool call, coercing redacted token usage to 0", () => {
    const { summary, events } = loadFixture("notified");
    const session = mapRunToSession(summary, events, OPTS);

    expect(session.id).toBe("run-mpcec5td-r4cw4p");
    expect(session.instance).toBe("downloads-curator");
    expect(session.cwd).toBe("/repo");
    expect(session.status).toBe("succeeded");
    // A UUID conversationId (no channel prefix, not a bare slug) -> "other".
    expect(session.source).toBe("other");

    // Last assistant text block is the final answer -> notified.
    expect(session.finalText).toBe("Hey. What do you want to clean up or work on?");
    expect(session.outcome).toBe("notified");
    expect(session.hasRecall).toBe(false);
    expect(session.instr).toBe("");

    // Redaction caveat: usage token fields are "[redacted]" strings -> coerced to 0.
    // cost_usd is a real number and flows through.
    expect(session.totals.tokIn).toBe(0);
    expect(session.totals.tokOut).toBe(0);
    expect(session.totals.tokCache).toBe(0);
    expect(session.totals.cost).toBeCloseTo(0.028859, 6);

    expect(session.totals.asst).toBe(2); // tool-call turn + final-answer turn
    expect(session.totals.tcalls).toBe(1);
    expect(session.totals.think).toBe(0);
    expect(session.totals.steps).toBe(events.length);
    expect(session.toolCounts).toEqual({ command_execution: 1 });

    // No model on this older summary -> provider/api omitted.
    expect(session.model).toBeUndefined();
    expect(session.provider).toBeUndefined();
    expect(session.api).toBeUndefined();

    // The tool-call assistant step carries a digest + full raw args, with the
    // call resolved ok:true once its (non-error) tool_result folds in.
    const callStep = assistantSteps(session.steps).find((step) => step.calls.length > 0);
    expect(callStep).toBeDefined();
    const call = callStep!.calls[0]!;
    expect(call.name).toBe("command_execution");
    expect(call.ok).toBe(true);
    expect(call.raw.startsWith('{"command"')).toBe(true);
    expect(call.dig.length).toBeLessThanOrEqual(DIGEST_CAP);
    expect(call.tr).toBe(true); // command line longer than the digest cap

    const result = resultSteps(session.steps)[0]!;
    expect(result.tool).toBe("command_execution");
    expect(result.ok).toBe(true);
    expect(result.tcid).toBe("call_tw067vx18AOnjQ9yBu4K8WQ4");
  });

  it("splits recalled memory, treats the NOTHING_TO_REPORT sentinel as silent, and marks a failed tool ok:false", () => {
    const { summary, events } = loadFixture("silent-recall");
    const session = mapRunToSession(summary, events, OPTS);

    // Recalled-memory tail split off the trigger prompt.
    expect(session.hasRecall).toBe(true);
    expect(session.instr).toBe("Summarize overnight logs.");
    expect(session.recalled?.startsWith("[Recalled long-term memory")).toBe(true);

    // Sentinel final text -> silent outcome.
    expect(session.finalText).toBe("NOTHING_TO_REPORT");
    expect(session.outcome).toBe("silent");

    // Trigger/source + model-ref parse (sdk:provider:model).
    expect(session.source).toBe("cron");
    expect(session.trigger).toBe("nightly-report");
    expect(session.model).toBe("pi:ollama:gemma4:31b");
    expect(session.api).toBe("pi");
    expect(session.provider).toBe("ollama");
    expect(session.effort).toBe("high");

    // cost prefers cost.cumulativeUsd over usage.cost_usd; tokCache sums read+creation.
    expect(session.totals.cost).toBeCloseTo(0.02, 6);
    expect(session.totals.tokIn).toBe(1200);
    expect(session.totals.tokOut).toBe(300);
    expect(session.totals.tokCache).toBe(150);

    // First step is the trigger prompt.
    expect(session.steps[0]!.k).toBe("prompt");

    // Errored tool_result -> result ok:false AND the linked call backfilled ok:false.
    const result = resultSteps(session.steps)[0]!;
    expect(result.ok).toBe(false);
    expect(result.tcid).toBe("t1");
    // Array-of-text-blocks content is joined into display text.
    expect(result.text).toBe("ENOENT: no such file or directory, open '/var/log/overnight.log'");

    const call = assistantSteps(session.steps).flatMap((step) => step.calls).find((c) => c.id === "t1");
    expect(call?.ok).toBe(false);
  });

  it("tolerates a partial/running run: coalesced thinking, an open (unresolved) tool call, no crash", () => {
    const { summary, events } = loadFixture("running");
    const session = mapRunToSession(summary, events, OPTS);

    expect(session.status).toBe("running");
    expect(session.source).toBe("tui"); // conversationId "tui-local"
    // No final assistant text yet -> provisionally silent.
    expect(session.finalText).toBe("");
    expect(session.outcome).toBe("silent");

    // No usage/cost on a partial summary -> zeros, not NaN.
    expect(session.totals.cost).toBe(0);
    expect(session.totals.tokIn).toBe(0);

    // Two streamed thinking deltas coalesce into one think run.
    expect(session.totals.think).toBe(1);
    expect(session.totals.tcalls).toBe(1);

    const step = assistantSteps(session.steps)[0]!;
    expect(step.think[0]!.t).toBe("Looking at the logs");
    // The tool call never received a result/timing -> ok stays undefined (in-flight).
    expect(step.calls[0]!.id).toBe("r1");
    expect(step.calls[0]!.ok).toBeUndefined();
  });

  it("degrades gracefully with an empty event stream (running summary, no events)", () => {
    const summary: RunSummary = {
      runId: "run-empty",
      conversationId: "telegram:42",
      status: "running",
      durationMs: 0,
      eventCount: 0,
      artifactPaths: [],
    };
    const session = mapRunToSession(summary, [], OPTS);

    expect(session.steps).toEqual([]);
    expect(session.outcome).toBe("silent");
    expect(session.finalText).toBe("");
    expect(session.source).toBe("telegram");
    expect(session.totals).toMatchObject({ asst: 0, tcalls: 0, think: 0, steps: 0, cost: 0 });
    expect(session.title).toBe("run-empty"); // no prompt/final text -> falls back to runId
  });

  it("derives finalText only from assistant text, not user/commentary text blocks", () => {
    const summary: RunSummary = {
      runId: "run-final-role",
      conversationId: "chat:roles",
      status: "succeeded",
      durationMs: 0,
      eventCount: 3,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      { type: "assistant", message: { content: [{ type: "text", text: "Actual answer." }] } },
      { type: "commentary", message: { content: [{ type: "text", text: "Internal progress update." }] } },
      { type: "user", message: { content: [{ type: "text", text: "User follow-up should not be final." }] } },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.finalText).toBe("Actual answer.");
    expect(session.outcome).toBe("notified");
    expect(assistantSteps(session.steps)).toHaveLength(1);
  });

  it("does not treat commentary-phase assistant text as final output", () => {
    const summary: RunSummary = {
      runId: "run-commentary-phase",
      conversationId: "chat:commentary-phase",
      status: "succeeded",
      durationMs: 0,
      eventCount: 1,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", phase: "commentary", text: "I am checking the files now." }],
        },
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.finalText).toBe("");
    expect(session.outcome).toBe("silent");
    expect(assistantSteps(session.steps)).toHaveLength(0);
  });

  it("maps session identity fields and session boundary events", () => {
    const summary: RunSummary = {
      runId: "run-boundary",
      conversationId: "chat:next",
      status: "succeeded",
      startedAt: "2026-07-06T10:00:00.000Z",
      durationMs: 1000,
      eventCount: 2,
      artifactPaths: [],
      providerSessionId: "provider-next",
      isolated: true,
    };
    const events: RuntimeEventLike[] = [
      {
        type: "session_boundary",
        kind: "rollover",
        previousConversationId: "chat:previous",
        conversationId: "chat:next",
        providerSessionId: "provider-next",
        reason: "daily partition changed",
        timestamp: "2026-07-06T10:00:00.500Z",
      },
      { type: "assistant", message: { content: [{ type: "text", text: "Ready in the new session." }] } },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.conversationId).toBe("chat:next");
    expect(session.providerSessionId).toBe("provider-next");
    expect(session.isolated).toBe(true);
    expect(boundarySteps(session.steps)).toEqual([
      {
        k: "boundary",
        ts: "2026-07-06T10:00:00.500Z",
        kind: "rollover",
        conversationId: "chat:next",
        previousConversationId: "chat:previous",
        providerSessionId: "provider-next",
        reason: "daily partition changed",
      },
    ]);
    expect(session.finalText).toBe("Ready in the new session.");
  });

  it("generates unique fallback ids for multiple anonymous tool calls in one event", () => {
    const summary: RunSummary = {
      runId: "run-anonymous-tools",
      conversationId: "chat:anonymous-tools",
      status: "running",
      durationMs: 0,
      eventCount: 1,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "first_tool", input: { value: 1 } },
            { type: "tool_use", name: "second_tool", input: { value: 2 } },
          ],
        },
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);
    const calls = assistantSteps(session.steps).flatMap((step) => step.calls);

    expect(calls.map((call) => call.id)).toEqual(["tool-0-0", "tool-0-1"]);
    expect(calls.map((call) => call.name)).toEqual(["first_tool", "second_tool"]);
  });

  it("classifies legacy (unstamped) runs from the conversationId", () => {
    const src = (conversationId: string): string => {
      const summary: RunSummary = {
        runId: "r",
        conversationId,
        status: "succeeded",
        durationMs: 0,
        eventCount: 0,
        artifactPaths: [],
      };
      return mapRunToSession(summary, [], OPTS).source;
    };
    // Bare cron job ids (with and without the daily-rollover "#<date>" suffix).
    expect(src("p2-notifications-check")).toBe("cron");
    expect(src("p2-notifications-check#2026-07-02")).toBe("cron");
    expect(src("gmail-focus-hourly")).toBe("cron");
    // Channel prefixes win (suffix stripped first).
    expect(src("cron:nightly")).toBe("cron");
    expect(src("memory:capture:reconcile")).toBe("memory");
    expect(src("telegram:123#2026-06-24")).toBe("telegram");
    // TUI sessions.
    expect(src("work-agent-tui")).toBe("tui");
    expect(src("tui-local")).toBe("tui");
    // A UUID (chat/webhook without a stamped source) stays "other".
    expect(src("b7e4c1a0-9f2d-4c6b-8a51-0d3e2f1a6c7b")).toBe("other");
  });
});

/** Mirrors the digest cap in session-mapping (first line, ~120 chars). */
const DIGEST_CAP = 121; // 120 chars + the ellipsis glyph
