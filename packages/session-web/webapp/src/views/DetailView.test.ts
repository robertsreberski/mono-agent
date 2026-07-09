import { describe, expect, test } from "vitest";

import {
  boundaryStepLabel,
  boundaryStepMeta,
  ctxSummaryLine,
  runtimeStepLabel,
  runtimeStepMeta,
  showTriggerRecall,
  timelineEmptyMessage,
  toolFileChangeMeta,
} from "./DetailView";

describe("timelineEmptyMessage", () => {
  test("shows a live waiting state for running runs with no timeline items", () => {
    expect(timelineEmptyMessage("running", 0)).toBe("Waiting for live events...");
  });

  test("shows a captured-empty state for terminal runs with no timeline items", () => {
    expect(timelineEmptyMessage("succeeded", 0)).toBe("No timeline events captured.");
  });

  test("does not show an empty state once timeline items are present", () => {
    expect(timelineEmptyMessage("running", 1)).toBeUndefined();
  });
});

describe("boundary timeline helpers", () => {
  test("formats known boundary kinds for compact display", () => {
    expect(boundaryStepLabel("rollover")).toBe("Session rollover");
    expect(boundaryStepLabel("isolated")).toBe("Isolated session");
    expect(boundaryStepLabel("resume_replay")).toBe("Resume replay");
  });

  test("keeps boundary identity metadata in a mobile-safe single line", () => {
    expect(boundaryStepMeta({
      k: "boundary",
      ts: "2026-07-06T10:00:00.000Z",
      kind: "rollover",
      previousConversationId: "chat:old",
      baseConversationId: "chat:base",
      conversationId: "chat:new",
      providerSessionId: "provider-1",
      reason: "daily partition changed",
    })).toBe("previous chat:old | base chat:base | current chat:new | provider provider-1");
  });
});

describe("ctxSummaryLine", () => {
  test("summarizes the prior message count and recalled memory source", () => {
    expect(ctxSummaryLine({ histCount: 3, hist: [], mem: { text: "m", src: "bujo" } }, true)).toBe(
      "3 prior messages · memory recalled (bujo)",
    );
  });

  test("singularizes a single prior message and omits memory when absent", () => {
    expect(ctxSummaryLine({ histCount: 1, hist: [] }, false)).toBe("1 prior message");
  });

  test("labels recalled memory without a source", () => {
    expect(ctxSummaryLine({ histCount: 0, mem: { text: "m" } }, false)).toBe("0 prior messages · memory recalled");
  });

  test("uses the provider-session phrasing when history was omitted, still noting memory", () => {
    expect(ctxSummaryLine({ histCount: 0, histOmitted: true, mem: { text: "m", src: "bujo" } }, true)).toBe(
      "context carried by the provider session · memory recalled (bujo)",
    );
  });

  test("falls back to a compiled-prompt-only line when there is no structured ctx", () => {
    expect(ctxSummaryLine(undefined, true)).toBe("compiled system prompt only");
    expect(ctxSummaryLine(undefined, false)).toBe("");
  });
});

describe("showTriggerRecall (recalled-memory de-duplication)", () => {
  test("hides the Trigger recall block when the Context section owns ctx.mem", () => {
    // A new run carries the same recall in both places — render it once (Context section).
    expect(showTriggerRecall({ hasRecall: true, ctx: { histCount: 0, mem: { text: "m", src: "bujo" } } })).toBe(false);
  });

  test("shows the Trigger recall block for old recordings that have no ctx.mem", () => {
    expect(showTriggerRecall({ hasRecall: true, ctx: undefined })).toBe(true);
    // ctx present but with no recalled memory → the Trigger block is still the only home for `recalled`.
    expect(showTriggerRecall({ hasRecall: true, ctx: { histCount: 2, hist: [] } })).toBe(true);
  });

  test("shows nothing when the run recalled no memory at all", () => {
    expect(showTriggerRecall({ hasRecall: false, ctx: undefined })).toBe(false);
    expect(showTriggerRecall({ hasRecall: false, ctx: { histCount: 0, mem: { text: "m" } } })).toBe(false);
  });
});

describe("runtime timeline helpers", () => {
  test("formats runtime warnings as compact timeline chips", () => {
    const step = {
      k: "runtime",
      ts: "2026-07-06T10:00:00.000Z",
      type: "runtime_warning",
      severity: "warning",
      kind: "context",
      message: "context compaction imminent",
    } as const;

    expect(runtimeStepLabel(step)).toBe("context");
    expect(runtimeStepMeta(step)).toBe("context compaction imminent");
  });

  test("summarizes provider status metadata without raw payloads", () => {
    const step = {
      k: "runtime",
      ts: "2026-07-06T10:00:00.000Z",
      type: "provider_status",
      kind: "failover_started",
      from: "gpt-5.5",
      to: "kimi",
      attemptIndex: 2,
      durationMs: 1500,
    } as const;

    expect(runtimeStepLabel(step)).toBe("failover started");
    expect(runtimeStepMeta(step)).toBe("from gpt-5.5 | to kimi | attempt 2 | 1.5s");
  });
});

describe("toolFileChangeMeta", () => {
  test("formats Pi Write file-change line counts", () => {
    expect(toolFileChangeMeta("Write", {
      status: "completed",
      files: 1,
      addedLines: 12,
      removedLines: 3,
      changedLines: 15,
      unavailableCount: 0,
      changes: [],
    })).toBe("file change +12 -3 · 15 changed");
  });

  test("returns n/a for Write calls without usable stats", () => {
    expect(toolFileChangeMeta("Write", undefined)).toBe("file change n/a");
    expect(toolFileChangeMeta("Write", {
      status: "completed",
      files: 1,
      unavailableCount: 1,
      changes: [],
    })).toBe("file change n/a");
  });

  test("omits the row for non-Write tools", () => {
    expect(toolFileChangeMeta("Read", undefined)).toBeUndefined();
  });
});
