import { describe, expect, it } from "vitest";

import {
  CronOperatorWireError,
  MAX_AGENT_REPLY_PARTS,
  MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES,
  MAX_CRON_OPERATOR_JOBS,
  MAX_CRON_OPERATOR_RESPONSE_BYTES,
  MAX_CRON_OPERATOR_RUN_PAGE,
  MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES,
  parseCronOperatorJob,
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

const job = (overrides: Record<string, unknown> = {}) => ({
  jobId: "digest",
  expression: "0 10 * * *",
  timezone: "UTC",
  conversationId: "cron:digest",
  configured: true,
  declaredEnabled: true,
  effectiveEnabled: true,
  health: "healthy",
  ...overrides,
});

const wireBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

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

  it("rejects undefined-then-secret and valid-then-oversized run accessors without invoking them", () => {
    const sensitive = "/private/report.csv?capabilityToken=secret";
    const attacks: readonly (readonly unknown[])[] = [
      [undefined, sensitive],
      ["bounded", "🙂".repeat(513)],
    ];

    for (const values of attacks) {
      let getterReads = 0;
      const input = summary();
      Object.defineProperty(input, "text", {
        configurable: true,
        enumerable: true,
        get() {
          const value = values[Math.min(getterReads, values.length - 1)];
          getterReads += 1;
          return value;
        },
      });

      expect(() => parseCronOperatorRunSummary(input)).toThrowError(/invalid cron operator/iu);
      expect(getterReads).toBe(0);
    }
  });

  it("snapshots every public parser boundary without invoking swapping accessors", () => {
    const sensitive = `/private/${"s".repeat(1_024)}?capabilityToken=secret`;
    const attacks: Array<{
      readonly parse: () => unknown;
      readonly reads: () => number;
    }> = [];

    let expressionReads = 0;
    const hostileJob = job();
    Object.defineProperty(hostileJob, "expression", {
      enumerable: true,
      get() {
        expressionReads += 1;
        return expressionReads === 1 ? "0 10 * * *" : sensitive;
      },
    });
    attacks.push({ parse: () => parseCronOperatorJob(hostileJob), reads: () => expressionReads });

    let degradedReasonReads = 0;
    const hostileOverview = {
      generatedAt: "2026-08-14T10:00:00.000Z",
      actionsEnabled: false,
      jobs: [],
    };
    Object.defineProperty(hostileOverview, "degradedReason", {
      enumerable: true,
      get() {
        degradedReasonReads += 1;
        return degradedReasonReads === 1 ? "bounded" : sensitive;
      },
    });
    attacks.push({
      parse: () => parseCronOperatorOverview(hostileOverview),
      reads: () => degradedReasonReads,
    });

    let runsReads = 0;
    const hostilePage = {};
    Object.defineProperty(hostilePage, "runs", {
      enumerable: true,
      get() {
        runsReads += 1;
        return runsReads === 1
          ? [summary()]
          : Array.from({ length: 600 }, () => summary({ text: sensitive }));
      },
    });
    attacks.push({ parse: () => parseCronOperatorRunPage(hostilePage), reads: () => runsReads });

    let eventReads = 0;
    const events = [{ type: "runtime_warning", message: "bounded" }];
    Object.defineProperty(events, "0", {
      enumerable: true,
      get() {
        eventReads += 1;
        return eventReads === 1
          ? { type: "runtime_warning", message: "bounded" }
          : { type: "runtime_warning", message: sensitive.repeat(600) };
      },
    });
    attacks.push({
      parse: () => parseCronOperatorRunDetail(summary({
        projection: "detail",
        events,
        eventsIncluded: 1,
      })),
      reads: () => eventReads,
    });

    for (const attack of attacks) {
      expect(attack.parse).toThrowError(/invalid cron operator/iu);
      expect(attack.reads()).toBe(0);
    }
  });

  it("rejects nested event and outcome accessors without reading or retaining them", () => {
    const sensitive = "/private/report.csv?capabilityToken=secret";
    let nestedReads = 0;
    const argumentsValue = { bounded: true };
    Object.defineProperty(argumentsValue, "secret", {
      enumerable: true,
      get() {
        nestedReads += 1;
        return sensitive;
      },
    });
    expect(() => parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{ type: "tool_call_started", id: "call-1", name: "read", arguments: argumentsValue }],
      eventsIncluded: 1,
    }))).toThrowError(/invalid cron operator/iu);
    expect(nestedReads).toBe(0);

    const outcome = {
      partIndex: 0,
      partType: "attachment",
      status: "failed",
      code: "unsupported_destination",
    };
    Object.defineProperty(outcome, "message", {
      enumerable: true,
      get() {
        nestedReads += 1;
        return sensitive;
      },
    });
    expect(() => parseCronOperatorRunSummary(summary({ replyPartOutcomes: [outcome] })))
      .toThrowError(/invalid cron operator/iu);
    expect(nestedReads).toBe(0);

    const fieldsTruncated = ["text"];
    Object.defineProperty(fieldsTruncated, "0", {
      enumerable: true,
      get() {
        nestedReads += 1;
        return "text";
      },
    });
    expect(() => parseCronOperatorRunSummary(summary({ fieldsTruncated })))
      .toThrowError(/invalid cron operator/iu);
    expect(nestedReads).toBe(0);

    const tokens = { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 };
    Object.defineProperty(tokens, "input", {
      enumerable: true,
      get() {
        nestedReads += 1;
        return 1;
      },
    });
    expect(() => parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{ type: "usage_update", tokens }],
      eventsIncluded: 1,
    }))).toThrowError(/invalid cron operator/iu);
    expect(nestedReads).toBe(0);
  });

  it("rejects symbols, non-enumerable fields, sparse arrays, and extra array properties", () => {
    const symbolBacked = summary();
    Object.defineProperty(symbolBacked, Symbol("secret"), { enumerable: true, value: "secret" });
    expect(() => parseCronOperatorRunSummary(symbolBacked)).toThrowError(/invalid cron operator/iu);

    const hiddenKnownField = summary();
    Object.defineProperty(hiddenKnownField, "text", { enumerable: false, value: "bounded" });
    expect(() => parseCronOperatorRunSummary(hiddenKnownField)).toThrowError(/invalid cron operator/iu);

    expect(() => parseCronOperatorRunSummary(summary({ fieldsTruncated: new Array(1) })))
      .toThrowError(/invalid cron operator/iu);
    const runs = [summary()];
    Object.defineProperty(runs, "hidden", { enumerable: false, value: "secret" });
    expect(() => parseCronOperatorRunPage({ runs })).toThrowError(/invalid cron operator/iu);
  });

  it("uses one Proxy descriptor snapshot without get or prototype access and rebuilds only allowed fields", () => {
    const sensitive = "/private/report.csv?capabilityToken=secret";
    let inheritedGetterReads = 0;
    const prototype = {};
    Object.defineProperty(prototype, "inheritedSecret", {
      enumerable: true,
      get() {
        inheritedGetterReads += 1;
        return sensitive;
      },
    });
    const target = Object.assign(Object.create(prototype) as Record<string, unknown>, summary());
    Object.defineProperty(target, "lateSecret", {
      configurable: true,
      enumerable: true,
      value: sensitive,
    });
    let descriptorReads = 0;
    let getReads = 0;
    let ownKeysReads = 0;
    let prototypeTrapReads = 0;
    const proxied = new Proxy(target, {
      get(current, property, receiver) {
        getReads += 1;
        return Reflect.get(current, property, receiver);
      },
      getOwnPropertyDescriptor(current, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
      getPrototypeOf() {
        prototypeTrapReads += 1;
        throw new Error("run parsing must not inspect a hostile prototype");
      },
      ownKeys(current) {
        ownKeysReads += 1;
        const keys = Reflect.ownKeys(current);
        return ownKeysReads === 1 ? keys.filter((key) => key !== "lateSecret") : keys;
      },
    });

    const parsed = parseCronOperatorRunSummary(proxied);

    expect(ownKeysReads).toBe(1);
    expect(descriptorReads).toBeGreaterThan(0);
    expect(getReads).toBe(0);
    expect(prototypeTrapReads).toBe(0);
    expect(inheritedGetterReads).toBe(0);
    expect(parsed).not.toHaveProperty("lateSecret");
    expect(parsed).not.toHaveProperty("inheritedSecret");
    expect(JSON.stringify(parsed)).not.toContain(sensitive);

    const throwingDescriptorTrap = new Proxy(summary(), {
      getOwnPropertyDescriptor() {
        throw new Error(sensitive);
      },
    });
    expect(() => parseCronOperatorRunSummary(throwingDescriptorTrap))
      .toThrowError(/invalid cron operator/iu);
  });

  it("snapshots nested array and event Proxies once without invoking get traps", () => {
    let getReads = 0;
    let arrayOwnKeysReads = 0;
    let eventOwnKeysReads = 0;
    const event = new Proxy({ type: "runtime_warning", message: "bounded" }, {
      get(target, property, receiver) {
        getReads += 1;
        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        eventOwnKeysReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    const runs = new Proxy([summary()], {
      get(target, property, receiver) {
        getReads += 1;
        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        arrayOwnKeysReads += 1;
        return Reflect.ownKeys(target);
      },
    });

    expect(parseCronOperatorRunPage({ runs }).runs).toHaveLength(1);
    expect(parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [event],
      eventsIncluded: 1,
    })).events).toEqual([{ type: "runtime_warning", message: "bounded" }]);
    expect(arrayOwnKeysReads).toBe(1);
    expect(eventOwnKeysReads).toBe(1);
    expect(getReads).toBe(0);
  });

  it("rejects a shared-reference diamond within a bounded descriptor budget", () => {
    const depth = 30;
    let ownKeysReads = 0;
    let descriptorReads = 0;
    let getReads = 0;
    const withObservedSnapshot = (record: Record<string, unknown>): Record<string, unknown> => new Proxy(record, {
      get() {
        getReads += 1;
        throw new Error("wire parsing must not invoke Proxy get traps");
      },
      getOwnPropertyDescriptor(target, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        ownKeysReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    let shared = withObservedSnapshot({ leaf: "bounded" });
    for (let index = 0; index < depth; index += 1) {
      shared = withObservedSnapshot({ left: shared, right: shared });
    }
    const input = summary({
      projection: "detail",
      events: [{ type: "runtime_telemetry", kind: "diamond", data: shared }],
      eventsIncluded: 1,
    });

    const startedAt = performance.now();
    let thrown: unknown;
    try {
      parseCronOperatorRunDetail(input);
    } catch (error) {
      thrown = error;
    }
    const elapsedMs = performance.now() - startedAt;

    expect(thrown).toBeInstanceOf(CronOperatorWireError);
    expect(thrown).toMatchObject({
      name: "CronOperatorWireError",
      message: "Invalid cron operator wire data.",
    });
    expect(ownKeysReads).toBe(depth + 1);
    expect(descriptorReads).toBe((depth * 2) + 1);
    expect(getReads).toBe(0);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 5_000);

  it("rejects cycles while preserving bounded aliases and independent control branches", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{ type: "runtime_telemetry", kind: "cycle", data: cyclic }],
      eventsIncluded: 1,
    }))).toThrowError(CronOperatorWireError);

    const shared = { value: "bounded" };
    const aliased = parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{ type: "runtime_telemetry", kind: "alias", data: { left: shared, right: shared } }],
      eventsIncluded: 1,
    }));
    const aliasedData = (aliased.events[0] as { data: Record<string, unknown> }).data;
    expect(aliasedData.left).toBe(aliasedData.right);
    expect(aliasedData.left).not.toBe(shared);

    const independent = parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [{
        type: "runtime_telemetry",
        kind: "independent",
        data: { left: { value: "bounded" }, right: { value: "bounded" } },
      }],
      eventsIncluded: 1,
    }));
    const independentData = (independent.events[0] as { data: Record<string, unknown> }).data;
    expect(independentData.left).toEqual(independentData.right);
    expect(independentData.left).not.toBe(independentData.right);
  });

  it("bounds hostile Proxy key fan-out before invoking per-property descriptor traps", () => {
    let ownKeysReads = 0;
    let descriptorReads = 0;
    let getReads = 0;
    const keys = Array.from({ length: 32 }, (_, index) => `attacker${String(index)}`);
    const oversized = new Proxy({}, {
      get() {
        getReads += 1;
        throw new Error("wire parsing must not invoke Proxy get traps");
      },
      getOwnPropertyDescriptor() {
        descriptorReads += 1;
        return { configurable: true, enumerable: true, value: "bounded" };
      },
      ownKeys() {
        ownKeysReads += 1;
        return keys;
      },
    });

    expect(() => parseCronOperatorRunSummary(oversized)).toThrowError(CronOperatorWireError);
    expect(ownKeysReads).toBe(1);
    expect(descriptorReads).toBe(0);
    expect(getReads).toBe(0);
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

  it("measures canonical detail events at the exact UTF-8 aggregate boundary", () => {
    const event = { type: "runtime_warning", message: "" };
    const overhead = wireBytes([event]);
    event.message = "x".repeat(MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES - overhead);
    const exact = summary({ projection: "detail", events: [event], eventsIncluded: 1 });

    expect(wireBytes([event])).toBe(MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES);
    expect(parseCronOperatorRunDetail(exact).events).toEqual([event]);

    const overflowEvent = { ...event, message: `${event.message.slice(0, -3)}🙂` };
    expect(wireBytes([overflowEvent])).toBe(MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES + 1);
    expect(() => parseCronOperatorRunDetail(summary({
      projection: "detail",
      events: [overflowEvent],
      eventsIncluded: 1,
    }))).toThrowError(/invalid cron operator/iu);
  });

  it("accepts an exact 768 KiB run page and rejects a one-byte UTF-8 overflow", () => {
    const outcomes = Array.from({ length: MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES }, (_, partIndex) => ({
      partIndex,
      partType: "failure",
      status: "failed",
      code: "artifact_integrity_failed",
      message: "Reply part failed before destination delivery.",
    }));
    const maximalSummary = (sequence: number) => ({
      projection: "summary",
      runId: "r".repeat(2_048),
      jobId: "j".repeat(256),
      scheduledAt: "2026-08-14T10:00:00.000Z",
      orderedAt: "2026-08-14T10:00:00.000Z",
      sequence,
      trigger: "scheduled",
      status: "failed",
      startedAt: "2026-08-14T10:00:00.000Z",
      completedAt: "2026-08-14T10:00:01.000Z",
      artifactRunId: "a".repeat(512),
      text: "t".repeat(2_048),
      error: "e".repeat(512),
      failureKind: "f".repeat(128),
      blockedByRunId: "b".repeat(2_048),
      blockedByTrigger: "manual",
      queueDepth: Number.MAX_SAFE_INTEGER,
      replyPartOutcomes: outcomes,
      eventCount: 256,
      fieldsTruncated: ["artifactRunId", "error", "failureKind", "text"],
      eventsTruncated: true,
    });
    const exact = {
      runs: Array.from({ length: MAX_CRON_OPERATOR_RUN_PAGE }, (_, index) => maximalSummary(index + 1)),
      nextCursor: "c".repeat(4_096),
    };
    exact.runs[0]!.text = "t".repeat(2_047);
    let excess = wireBytes(exact) - MAX_CRON_OPERATOR_RESPONSE_BYTES;
    expect(excess).toBeGreaterThan(0);
    for (let index = 1; index < exact.runs.length && excess > 0; index += 1) {
      const run = exact.runs[index]!;
      const removed = Math.min(excess, run.text.length);
      run.text = run.text.slice(0, run.text.length - removed);
      excess -= removed;
    }

    expect(excess).toBe(0);
    expect(wireBytes(exact)).toBe(MAX_CRON_OPERATOR_RESPONSE_BYTES);
    const parsed = parseCronOperatorRunPage(exact);
    expect(wireBytes(parsed)).toBe(MAX_CRON_OPERATOR_RESPONSE_BYTES);

    const overflow = structuredClone(exact);
    overflow.runs[0]!.text = `${overflow.runs[0]!.text.slice(0, -3)}🙂`;
    expect(wireBytes(overflow)).toBe(MAX_CRON_OPERATOR_RESPONSE_BYTES + 1);
    expect(() => parseCronOperatorRunPage(overflow)).toThrowError(/invalid cron operator/iu);
  });
});
