import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createLiveEventBus, LIVE_EVENT_SCHEMA, type RunEventBus, type RunEventFrame } from "@mono-agent/agent-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { SessionAggregator } from "../aggregator.js";
import type { BrowserStreamFrame } from "../session-model.js";
import { makeTmpDir, registerSource, removeDir, startTinySseServer, waitFor, type TinySseServer } from "./helpers.js";

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
});
