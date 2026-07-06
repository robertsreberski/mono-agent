import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { createLiveEventBus, LIVE_EVENT_SCHEMA, type RunEventBus, type RunEventFrame } from "@mono-agent/agent-contracts";
import { RUNS_HEALTH_STALE_RUNNING_MS } from "@mono-agent/observability";
import { afterEach, describe, expect, it } from "vitest";

import { SessionAggregator } from "../aggregator.js";
import type { BrowserStreamFrame } from "../session-model.js";
import { makeTmpDir, registerSource, removeDir, seedRun, seedRunningRun, startTinySseServer, waitFor, type TinySseServer } from "./helpers.js";

const tmpDirs: string[] = [];
let aggregator: SessionAggregator | undefined;
let sse: TinySseServer | undefined;

async function tmp(prefix: string): Promise<string> {
  const dir = await makeTmpDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await aggregator?.stop();
  aggregator = undefined;
  await sse?.stop();
  sse = undefined;
  await Promise.all(tmpDirs.splice(0).map(removeDir));
});

const SOURCE_ID = "live-agent";
const RUN_ID = "run-live-1";
const SUMMARY_FILE = `${RUN_ID}.summary.json`;
const STARTED_AT = "2026-07-04T00:00:00.000Z";
const LIVE_TEST_NOW = Date.parse(STARTED_AT) + 1000;

function runStarted(): RunEventFrame {
  return {
    t: "run_started",
    schema: LIVE_EVENT_SCHEMA,
    sourceId: SOURCE_ID,
    runId: RUN_ID,
    conversationId: "cron:live",
    source: "cron",
    startedAt: STARTED_AT,
    seq: 0,
  };
}

function withSource(frame: RunEventFrame, sourceId: string): RunEventFrame {
  return { ...frame, sourceId } as RunEventFrame;
}

function assistantEvent(): RunEventFrame {
  return {
    t: "event",
    schema: LIVE_EVENT_SCHEMA,
    sourceId: SOURCE_ID,
    runId: RUN_ID,
    eventIndex: 0,
    event: {
      type: "assistant",
      timestamp: STARTED_AT,
      message: { content: [{ type: "text", text: "live answer" }] },
    },
    seq: 0,
  };
}

function runFinished(): RunEventFrame {
  return {
    t: "run_finished",
    schema: LIVE_EVENT_SCHEMA,
    sourceId: SOURCE_ID,
    runId: RUN_ID,
    status: "succeeded",
    summary: {
      runId: RUN_ID,
      conversationId: "cron:live",
      status: "succeeded",
      startedAt: STARTED_AT,
      endedAt: "2026-07-04T00:00:05.000Z",
      durationMs: 5000,
      eventCount: 1,
      artifactPaths: [],
      usage: { input_tokens: 12, output_tokens: 7 },
      model: "pi:ollama:qwen",
      source: "cron",
    },
    seq: 0,
  };
}

const MEMORY_RUN_ID = "mem-live-1";

function memoryRunStarted(runId = MEMORY_RUN_ID): RunEventFrame {
  return {
    t: "run_started",
    schema: LIVE_EVENT_SCHEMA,
    sourceId: SOURCE_ID,
    runId,
    conversationId: "memory:capture:distill",
    source: "memory",
    startedAt: STARTED_AT,
    seq: 0,
  };
}

function memoryAssistantEvent(): RunEventFrame {
  return {
    t: "event",
    schema: LIVE_EVENT_SCHEMA,
    sourceId: SOURCE_ID,
    runId: MEMORY_RUN_ID,
    eventIndex: 0,
    event: {
      type: "assistant",
      timestamp: STARTED_AT,
      source: "memory",
      message: { content: [{ type: "text", text: "memory answer" }] },
    },
    seq: 0,
  };
}

function memoryRunFinished(): RunEventFrame {
  return {
    t: "run_finished",
    schema: LIVE_EVENT_SCHEMA,
    sourceId: SOURCE_ID,
    runId: MEMORY_RUN_ID,
    status: "succeeded",
    summary: {
      runId: MEMORY_RUN_ID,
      conversationId: "memory:capture:distill",
      status: "succeeded",
      startedAt: STARTED_AT,
      endedAt: "2026-07-04T00:00:05.000Z",
      durationMs: 5000,
      eventCount: 1,
      artifactPaths: [],
      source: "memory",
    },
    seq: 0,
  };
}

describe("SessionAggregator live fold", () => {
  it("folds run_started → event → run_finished into a provisional then final session_upsert", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await mkdir(artifactDir, { recursive: true });
    await registerSource({
      registryDir,
      sourceId: SOURCE_ID,
      label: "Live Agent",
      artifactDir,
      liveBaseUrl: sse.baseUrl,
    });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });

    const frames: BrowserStreamFrame[] = [];
    aggregator.subscribe((frame) => frames.push(frame));
    await aggregator.start();

    // Publish start+event first and wait for the provisional (running) upsert. The
    // bus ring buffer covers the window before the SSE client connects.
    bus.publish(runStarted());
    bus.publish(assistantEvent());
    const provisional = await waitFor(() =>
      frames.find(
        (frame): frame is Extract<BrowserStreamFrame, { t: "session_upsert" }> =>
          frame.t === "session_upsert" && frame.session.id === RUN_ID && frame.session.status === "running",
      ),
    );
    expect(provisional.session.finalText).toBe("live answer");
    expect(provisional.session.source).toBe("cron");

    // Now finish the run over the live connection and wait for the authoritative upsert.
    bus.publish(runFinished());
    const final = await waitFor(() =>
      frames.find(
        (frame): frame is Extract<BrowserStreamFrame, { t: "session_upsert" }> =>
          frame.t === "session_upsert" && frame.session.id === RUN_ID && frame.session.status === "succeeded",
      ),
    );
    expect(final.session.finalText).toBe("live answer");
    expect(final.session.totals.tokIn).toBe(12);
    expect(final.session.totals.tokOut).toBe(7);

    // The folded session is queryable and the instance reports the live connection.
    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({ id: RUN_ID, status: "succeeded" });
    await waitFor(() => aggregator?.getInstances().find((instance) => instance.liveConnected === true));
    expect(aggregator.getInstances()[0]?.counts.runs).toBe(1);
  });

  it("dedupes replayed live event frames for an in-flight run", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await mkdir(artifactDir, { recursive: true });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    await aggregator.start();

    const event = assistantEvent();
    bus.publish(runStarted());
    bus.publish(event);
    bus.publish(event);
    await waitFor(() => aggregator?.getSessions("all").find((session) => session.id === RUN_ID && session.finalText === "live answer"));
    await sleep(80);

    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({
      finalText: "live answer",
    });
  });

  it("ignores live frames whose sourceId does not match the discovered instance", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await mkdir(artifactDir, { recursive: true });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    await aggregator.start();

    bus.publish(withSource(runStarted(), "other-agent"));
    bus.publish(withSource(assistantEvent(), "other-agent"));
    await sleep(80);

    expect(aggregator.getSessions("all")).toHaveLength(0);
  });

  it("drops identifiable memory live frames by default", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await mkdir(artifactDir, { recursive: true });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    const frames: BrowserStreamFrame[] = [];
    aggregator.subscribe((frame) => frames.push(frame));
    await aggregator.start();

    bus.publish(memoryRunStarted());
    bus.publish(memoryAssistantEvent());
    bus.publish(memoryRunFinished());
    await sleep(80);

    expect(aggregator.getSessions("all")).toHaveLength(0);
    expect(aggregator.getInstances()[0]?.counts.runs).toBe(0);
    expect(frames.some((frame) => frame.t === "session_upsert" && frame.session.id === MEMORY_RUN_ID)).toBe(false);
  });

  it("bounds the cache of suppressed memory live run ids", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await mkdir(artifactDir, { recursive: true });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    await aggregator.start();
    const internals = aggregator as unknown as {
      states: Map<string, unknown>;
      handleLiveFrame(state: unknown, frame: RunEventFrame): void;
    };
    const state = internals.states.get(SOURCE_ID) as
      | { readonly suppressedMemoryLiveRuns: { readonly size: number } }
      | undefined;
    if (state === undefined) {
      throw new Error("expected live-agent state");
    }

    for (let index = 0; index < 600; index += 1) {
      internals.handleLiveFrame(state, memoryRunStarted(`mem-hidden-${index}`));
    }

    expect(state.suppressedMemoryLiveRuns.size).toBe(512);
    expect(aggregator.getSessions("all")).toHaveLength(0);
  });

  it("includes memory live frames when includeMemory is true", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await mkdir(artifactDir, { recursive: true });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
      includeMemory: true,
    });
    await aggregator.start();

    bus.publish(memoryRunStarted());
    bus.publish(memoryAssistantEvent());
    bus.publish(memoryRunFinished());

    await waitFor(() =>
      aggregator?.getSessions("all").find((session) => session.id === MEMORY_RUN_ID && session.status === "succeeded"),
    );
    await expect(aggregator.getSession(SOURCE_ID, MEMORY_RUN_ID)).resolves.toMatchObject({
      id: MEMORY_RUN_ID,
      source: "memory",
      finalText: "memory answer",
    });
    expect(aggregator.getInstances()[0]?.counts.runs).toBe(1);
  });

  it("keeps seeded terminal disk history authoritative over sparse live replay", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await seedRun({
      artifactDir,
      runId: RUN_ID,
      conversationId: "cron:live",
      userInput: "Run from disk",
      text: "disk answer",
      source: "cron",
      at: Date.parse(STARTED_AT),
    });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    await aggregator.start();

    bus.publish(assistantEvent());
    await sleep(80);

    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({
      status: "succeeded",
      finalText: "disk answer",
      sourceId: SOURCE_ID,
    });
  });

  it("keeps a live terminal state authoritative over a delayed running artifact reread", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await seedRunningRun({
      artifactDir,
      runId: RUN_ID,
      conversationId: "cron:live",
      userInput: "Run from disk",
      text: "stale running disk answer",
      source: "cron",
      at: Date.parse(STARTED_AT),
    });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    await aggregator.start();

    bus.publish(runStarted());
    bus.publish(assistantEvent());
    bus.publish(runFinished());
    await waitFor(() => aggregator?.getSessions("all").find((session) => session.id === RUN_ID && session.status === "succeeded"));

    const state = (aggregator as unknown as { states: Map<string, unknown> }).states.get(SOURCE_ID);
    await (aggregator as unknown as { rereadArtifactSummaryFile(state: unknown, summaryFileName: string): Promise<void> })
      .rereadArtifactSummaryFile(state, SUMMARY_FILE);

    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({
      status: "succeeded",
      finalText: "live answer",
    });
  });

  it("does not let stalled disk projection block later live completion", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    const staleNow = Date.parse(STARTED_AT) + RUNS_HEALTH_STALE_RUNNING_MS + 1000;
    await seedRunningRun({
      artifactDir,
      runId: RUN_ID,
      conversationId: "cron:live",
      userInput: "Run from disk",
      text: "stale running disk answer",
      source: "cron",
      at: Date.parse(STARTED_AT),
    });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => staleNow,
    });
    await aggregator.start();
    expect(aggregator.getSessionSummaries("all")).toMatchObject([{ id: RUN_ID, status: "stalled" }]);

    bus.publish(runStarted());
    bus.publish(assistantEvent());
    bus.publish(runFinished());

    await waitFor(() =>
      aggregator?.getSessions("all").find((session) => session.id === RUN_ID && session.status === "succeeded"),
    );
    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({
      status: "succeeded",
      finalText: "live answer",
    });
  });

  it("projects cached live detail as stalled on direct detail reads", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await mkdir(artifactDir, { recursive: true });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    let now = LIVE_TEST_NOW;
    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => now,
    });
    await aggregator.start();

    bus.publish(runStarted());
    bus.publish(assistantEvent());
    await waitFor(() =>
      aggregator?.getSessions("all").find((session) => session.id === RUN_ID && session.status === "running"),
    );

    now = Date.parse(STARTED_AT) + RUNS_HEALTH_STALE_RUNNING_MS + 1000;

    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({
      id: RUN_ID,
      status: "stalled",
      finalText: "live answer",
    });
  });

  it("keeps rich live terminal detail when a terminal disk reread is missing events", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await mkdir(artifactDir, { recursive: true });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    const frames: BrowserStreamFrame[] = [];
    aggregator.subscribe((frame) => frames.push(frame));
    await aggregator.start();

    bus.publish(runStarted());
    bus.publish(assistantEvent());
    bus.publish(runFinished());
    await waitFor(() => aggregator?.getSessions("all").find((session) => session.id === RUN_ID && session.status === "succeeded"));

    await seedRun({
      artifactDir,
      runId: RUN_ID,
      conversationId: "cron:live",
      text: "disk answer",
      source: "cron",
      at: Date.parse(STARTED_AT),
    });
    await rm(join(artifactDir, `${RUN_ID}.events.jsonl`));

    const frameCountBeforeReread = frames.length;
    const state = (aggregator as unknown as { states: Map<string, unknown> }).states.get(SOURCE_ID);
    await (aggregator as unknown as { rereadArtifactSummaryFile(state: unknown, summaryFileName: string): Promise<void> })
      .rereadArtifactSummaryFile(state, SUMMARY_FILE);

    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({
      status: "succeeded",
      outcome: "notified",
      finalText: "live answer",
      totals: expect.objectContaining({ steps: 1 }),
    });
    const rereadUpsert = frames
      .slice(frameCountBeforeReread)
      .find(
        (frame): frame is Extract<BrowserStreamFrame, { t: "session_upsert" }> =>
          frame.t === "session_upsert" && frame.session.id === RUN_ID,
      );
    expect(rereadUpsert?.session.finalText).toBe("");
    expect(rereadUpsert?.session.steps).toEqual([]);
  });

  it("reconciles artifacts that appear after discovery and lets terminal disk replace live", async () => {
    const bus: RunEventBus = createLiveEventBus();
    sse = await startTinySseServer(bus);

    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, liveBaseUrl: sse.baseUrl });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      liveFoldDebounceMs: 10,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    await aggregator.start();

    bus.publish(runStarted());
    bus.publish(assistantEvent());
    bus.publish(runFinished());
    await waitFor(() => aggregator?.getSessions("all").find((session) => session.id === RUN_ID && session.finalText === "live answer"));

    await seedRun({
      artifactDir,
      runId: RUN_ID,
      conversationId: "cron:live",
      userInput: "Run from disk",
      text: "disk answer",
      source: "cron",
      at: Date.parse(STARTED_AT),
    });
    await (aggregator as unknown as { reconcile(): Promise<void> }).reconcile();

    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({
      status: "succeeded",
      finalText: "disk answer",
    });
  });

  it("replaces retained history when a sourceId moves to a new artifact directory", async () => {
    const registryDir = await tmp("reg");
    const oldArtifactDir = join(await tmp("old-agent"), "runs");
    const newArtifactDir = join(await tmp("new-agent"), "runs");
    await seedRun({
      artifactDir: oldArtifactDir,
      runId: "run-old",
      conversationId: "cron:old",
      userInput: "Old",
      text: "old answer",
      source: "cron",
      at: 1_700_000_000_000,
    });
    await seedRun({
      artifactDir: newArtifactDir,
      runId: "run-new",
      conversationId: "cron:new",
      userInput: "New",
      text: "new answer",
      source: "cron",
      at: 1_700_000_100_000,
    });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir: oldArtifactDir });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    const frames: BrowserStreamFrame[] = [];
    aggregator.subscribe((frame) => frames.push(frame));
    await aggregator.start();
    expect(aggregator.getSessions("all").map((session) => session.id)).toEqual(["run-old"]);

    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir: newArtifactDir });
    await (aggregator as unknown as { reconcile(): Promise<void> }).reconcile();

    expect(aggregator.getSessions("all").map((session) => session.id)).toEqual(["run-new"]);
    expect(frames).toContainEqual({ t: "session_removed", sourceId: SOURCE_ID, runId: "run-old" });
    expect(frames.some((frame) => frame.t === "session_upsert" && frame.session.id === "run-new")).toBe(true);
  });

  it("routes on-demand disk detail through eviction without broadcasting full detail", async () => {
    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await seedRun({
      artifactDir,
      runId: "run-old",
      conversationId: "cron:old",
      userInput: "Old",
      text: "old answer",
      source: "cron",
      at: 1_700_000_000_000,
    });
    await seedRun({
      artifactDir,
      runId: "run-new",
      conversationId: "cron:new",
      userInput: "New",
      text: "new answer",
      source: "cron",
      at: 1_700_000_100_000,
    });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 1,
      reconcileIntervalMs: 60_000,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    const frames: BrowserStreamFrame[] = [];
    aggregator.subscribe((frame) => frames.push(frame));
    await aggregator.start();
    expect(aggregator.getSessions("all").map((session) => session.id)).toEqual(["run-new"]);

    await expect(aggregator.getSession(SOURCE_ID, "run-old")).resolves.toMatchObject({ id: "run-old", finalText: "old answer" });

    expect(aggregator.getSessions("all").map((session) => session.id)).toEqual(["run-old"]);
    expect(frames).toContainEqual({ t: "session_removed", sourceId: SOURCE_ID, runId: "run-new" });
    expect(frames.some((frame) => frame.t === "session_upsert" && frame.session.id === "run-old")).toBe(false);
  });

  it("emits an instances frame when registry metadata changes without endpoint changes", async () => {
    const registryDir = await tmp("reg");
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    const configPath = join(agentDir, "mono-agent.config.json");
    await mkdir(artifactDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Live Agent", artifactDir, configPath });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      instancesDebounceMs: 5,
      clock: () => LIVE_TEST_NOW,
    });
    const frames: BrowserStreamFrame[] = [];
    aggregator.subscribe((frame) => frames.push(frame));
    await aggregator.start();

    await registerSource({ registryDir, sourceId: SOURCE_ID, label: "Renamed Agent", artifactDir, configPath });
    await (aggregator as unknown as { reconcile(): Promise<void> }).reconcile();

    await waitFor(() =>
      frames.find(
        (frame): frame is Extract<BrowserStreamFrame, { t: "instances" }> =>
          frame.t === "instances" && frame.instances.some((instance) => instance.label === "Renamed Agent"),
      ),
    );
    expect(aggregator.getInstances()[0]?.label).toBe("Renamed Agent");
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
