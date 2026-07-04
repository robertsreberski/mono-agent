import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createLiveEventBus, LIVE_EVENT_SCHEMA, type RunEventBus, type RunEventFrame } from "@mono-agent/agent-contracts";
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
const STARTED_AT = "2026-07-04T00:00:00.000Z";

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
    });
    await aggregator.start();

    bus.publish(withSource(runStarted(), "other-agent"));
    bus.publish(withSource(assistantEvent(), "other-agent"));
    await sleep(80);

    expect(aggregator.getSessions("all")).toHaveLength(0);
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
    });
    await aggregator.start();

    bus.publish(runStarted());
    bus.publish(assistantEvent());
    bus.publish(runFinished());
    await waitFor(() => aggregator?.getSessions("all").find((session) => session.id === RUN_ID && session.status === "succeeded"));

    const state = (aggregator as unknown as { states: Map<string, unknown> }).states.get(SOURCE_ID);
    await (aggregator as unknown as { rereadArtifactRun(state: unknown, runId: string): Promise<void> })
      .rereadArtifactRun(state, RUN_ID);

    await expect(aggregator.getSession(SOURCE_ID, RUN_ID)).resolves.toMatchObject({
      status: "succeeded",
      finalText: "live answer",
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
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
