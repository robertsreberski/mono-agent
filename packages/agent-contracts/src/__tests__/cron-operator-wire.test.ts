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
