import { describe, expect, it } from "vitest";

import {
  MAX_AGENT_REPLY_PARTS,
  MAX_CRON_OPERATOR_JOBS,
  MAX_CRON_OPERATOR_RUN_PAGE,
  MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES,
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

  it("accepts only the exact bounded reply-part outcome machine schema and returns an independent copy", () => {
    const outcome = {
      partIndex: 0,
      partType: "attachment",
      status: "failed",
      code: "unsupported_destination",
      message: "Attachment reply parts are unsupported on this destination.",
    };
    const replyPartOutcomes = [outcome];
    const input = summary({ replyPartOutcomes });
    const parsed = parseCronOperatorRunSummary(input);

    expect(parsed.replyPartOutcomes).toEqual([outcome]);
    expect(parsed.replyPartOutcomes).not.toBe(replyPartOutcomes);
    expect(parsed.replyPartOutcomes?.[0]).not.toBe(outcome);

    for (const invalid of [
      [{ ...outcome, code: "attacker_code" }],
      [{ ...outcome, message: "/private/token" }],
      [{ ...outcome, status: "succeeded" }],
      [{ ...outcome, secret: "token" }],
      [null],
      Array.from({ length: 21 }, () => outcome),
    ]) {
      expect(() => parseCronOperatorRunSummary(summary({ replyPartOutcomes: invalid })))
        .toThrowError(/invalid cron operator/iu);
    }
  });

  it("canonicalizes descriptor-backed outcome arrays without invoking proxy getters", () => {
    const sensitive = "/private/report.csv?capabilityToken=secret";
    const safeOutcome = {
      partIndex: 0,
      partType: "attachment",
      status: "failed",
      code: "unsupported_destination",
      message: "Attachment reply parts are unsupported on this destination.",
    };
    let getterReads = 0;
    const descriptorBacked = new Proxy([safeOutcome], {
      get(_target, property) {
        getterReads += 1;
        if (property === "0") {
          return { ...safeOutcome, message: sensitive, localPath: sensitive, capabilityToken: sensitive };
        }
        throw new Error("outcome arrays must be canonicalized through data descriptors");
      },
    });

    const parsed = parseCronOperatorRunSummary(summary({ replyPartOutcomes: descriptorBacked }));

    expect(parsed.replyPartOutcomes).toEqual([safeOutcome]);
    expect(getterReads).toBe(0);
    expect(JSON.stringify(parsed)).not.toContain(sensitive);
    expect(parsed.replyPartOutcomes?.[0]).not.toHaveProperty("localPath");
    expect(parsed.replyPartOutcomes?.[0]).not.toHaveProperty("capabilityToken");
  });

  it("caps summary outcomes deterministically while detail retains the shared boundary", () => {
    const outcomes = Array.from({ length: MAX_AGENT_REPLY_PARTS }, (_, partIndex) => ({
      partIndex,
      partType: "failure",
      status: "failed",
      code: "artifact_integrity_failed",
      message: "Reply part failed before destination delivery.",
    }));
    const summaryBoundary = outcomes.slice(0, MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES);

    expect(parseCronOperatorRunSummary(summary({ replyPartOutcomes: summaryBoundary })).replyPartOutcomes)
      .toEqual(summaryBoundary);
    expect(() => parseCronOperatorRunSummary(summary({
      replyPartOutcomes: outcomes.slice(0, MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES + 1),
    }))).toThrowError(/invalid cron operator/iu);
    expect(parseCronOperatorRunDetail(summary({
      projection: "detail",
      replyPartOutcomes: outcomes,
      events: [],
      eventsIncluded: 0,
    })).replyPartOutcomes).toEqual(outcomes);
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
