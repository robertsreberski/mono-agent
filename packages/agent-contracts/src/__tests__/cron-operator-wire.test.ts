import { describe, expect, it } from "vitest";

import {
  MAX_CRON_OPERATOR_JOBS,
  MAX_CRON_OPERATOR_RUN_PAGE,
  parseCronOperatorOverview,
  parseCronOperatorRunDetail,
  parseCronOperatorRunPage,
  parseCronOperatorRunSummary,
} from "../index.js";

const summary = (overrides: Record<string, unknown> = {}) => ({
  projection: "summary",
  runId: "cron:digest:2026-08-14T10:00:00.000Z",
  jobId: "digest",
  scheduledAt: "2026-08-14T10:00:00.000Z",
  orderedAt: "2026-08-14T10:00:00.000Z",
  sequence: 1,
  trigger: "scheduled",
  status: "succeeded",
  eventCount: 1,
  ...overrides,
});

describe("cron operator wire contract", () => {
  it("keeps compact and detail projections honest and rejects unknown fields", () => {
    expect(parseCronOperatorRunSummary(summary())).not.toHaveProperty("events");
    expect(() => parseCronOperatorRunSummary({ ...summary(), events: [] })).toThrowError(/invalid cron operator/iu);
    expect(() => parseCronOperatorRunSummary({ ...summary(), future: true })).toThrowError(/invalid cron operator/iu);
    expect(() => parseCronOperatorRunDetail(summary({ projection: "detail", events: [], eventsIncluded: 0 })))
      .not.toThrow();
    expect(() => parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{ type: "runtime_warning", message: "warning", future: true }],
      eventsIncluded: 1,
    }))).toThrowError(/invalid cron operator/iu);
    expect(() => parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{ type: "future_event" }],
      eventsIncluded: 1,
    }))).toThrowError(/invalid cron operator/iu);
  });

  it("accepts bounded canonical tool-history metadata on cron detail events and rejects malformed metadata", () => {
    const history = {
      recordId: "sth1_record",
      sequence: 2,
      persistence: "persisted",
      terminalState: "success",
      truncated: false,
      originalBytes: 10,
      retainedBytes: 10,
      artifactReferences: [{ id: "stha1_artifact", available: true }],
      untrusted: true,
    } as const;
    const events = [
      { type: "tool_call_started", id: "call-1", name: "Read", history: { ...history, sequence: 1 } },
      { type: "tool_call_completed", id: "call-1", name: "Read", content: "ok", history },
    ];

    expect(parseCronOperatorRunDetail(summary({
      projection: "detail",
      eventCount: events.length,
      events,
      eventsIncluded: events.length,
    })).events).toEqual(events);
    expect(() => parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{ ...events[1], history: { ...history, untrusted: false } }],
      eventsIncluded: 1,
    }))).toThrowError(/invalid cron operator/iu);
    expect(() => parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{ type: "tool_call_progress", id: "call-1", history }],
      eventsIncluded: 1,
    }))).toThrowError(/invalid cron operator/iu);
  });

  it("enforces collection and UTF-8 field ceilings at the parser boundary", () => {
    expect(() => parseCronOperatorRunPage({
      runs: Array.from({ length: MAX_CRON_OPERATOR_RUN_PAGE + 1 }, () => summary()),
    })).toThrowError(/invalid cron operator/iu);
    expect(() => parseCronOperatorRunSummary(summary({ text: "🙂".repeat(513) })))
      .toThrowError(/invalid cron operator/iu);
    expect(() => parseCronOperatorOverview({
      generatedAt: "2026-08-14T10:00:00.000Z",
      actionsEnabled: false,
      jobs: Array.from({ length: MAX_CRON_OPERATOR_JOBS + 1 }, (_, index) => ({
        jobId: `job-${String(index)}`,
        conversationId: `cron:job-${String(index)}`,
        configured: false,
        declaredEnabled: false,
        effectiveEnabled: false,
        health: "disabled",
      })),
    })).toThrowError(/invalid cron operator/iu);
  });
});
