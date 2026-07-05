import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const readRecordedRunMock = vi.hoisted(() => vi.fn());
const listRecordedRunsMock = vi.hoisted(() => vi.fn());

vi.mock("@mono-agent/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/observability")>();
  listRecordedRunsMock.mockImplementation(actual.listRecordedRuns);
  return {
    ...actual,
    listRecordedRuns: listRecordedRunsMock,
    readRecordedRun: readRecordedRunMock,
  };
});

import { SessionAggregator } from "../aggregator.js";
import { makeTmpDir, registerSource, removeDir, seedRun, seedRunningRun } from "./helpers.js";

const tmpDirs: string[] = [];
let aggregator: SessionAggregator | undefined;

async function tmp(prefix: string): Promise<string> {
  const dir = await makeTmpDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await aggregator?.stop();
  aggregator = undefined;
  readRecordedRunMock.mockReset();
  listRecordedRunsMock.mockClear();
  await Promise.all(tmpDirs.splice(0).map(removeDir));
});

describe("SessionAggregator summary reconcile", () => {
  it("does not read event JSONL detail during start or steady reconcile", async () => {
    readRecordedRunMock.mockRejectedValue(new Error("readRecordedRun must stay lazy"));
    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await seedRun({
      artifactDir,
      runId: "run-hotloop",
      conversationId: "chat:hotloop",
      userInput: "Keep list payload slim",
      text: "Detailed answer that belongs to the lazy endpoint.",
      source: "chat",
      at: 1_700_000_000_000,
    });
    await registerSource({ registryDir, sourceId: "summary-agent", label: "Summary Agent", artifactDir });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      instancesDebounceMs: 5,
    });
    await aggregator.start();

    expect(aggregator.getSessionSummaries("all")).toHaveLength(1);
    expect(aggregator.getSessionSummaries("all")[0]?.steps).toEqual([]);
    expect(readRecordedRunMock).not.toHaveBeenCalled();

    listRecordedRunsMock.mockClear();
    await (aggregator as unknown as { reconcile(): Promise<void> }).reconcile();

    expect(listRecordedRunsMock).not.toHaveBeenCalled();
    expect(readRecordedRunMock).not.toHaveBeenCalled();
  });

  it("rereads watched summary files using the real runId from the summary", async () => {
    readRecordedRunMock.mockRejectedValue(new Error("readRecordedRun must stay lazy"));
    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    await seedRunningRun({
      artifactDir,
      runId: "Run:Watched",
      conversationId: "chat:watched",
      userInput: "Watch this summary",
      text: "Running answer.",
      source: "chat",
      at: 1_700_000_000_000,
    });
    await registerSource({ registryDir, sourceId: "summary-agent", label: "Summary Agent", artifactDir });

    aggregator = new SessionAggregator({
      registryDirs: [registryDir],
      maxRunsPerInstance: 50,
      reconcileIntervalMs: 60_000,
      instancesDebounceMs: 5,
    });
    await aggregator.start();
    expect(aggregator.getSessionSummaries("all")[0]).toMatchObject({ id: "Run:Watched", status: "running" });

    const finished = await seedRun({
      artifactDir,
      runId: "Run:Watched",
      conversationId: "chat:watched",
      userInput: "Watch this summary",
      text: "Finished answer.",
      source: "chat",
      at: 1_700_000_005_000,
    });
    const summaryFileName = basename(finished.artifactPaths[1] ?? "");

    const state = (aggregator as unknown as { states: Map<string, unknown> }).states.get("summary-agent");
    await (aggregator as unknown as { rereadArtifactSummaryFile(state: unknown, summaryFileName: string): Promise<void> })
      .rereadArtifactSummaryFile(state, summaryFileName);

    expect(aggregator.getSessionSummaries("all")[0]).toMatchObject({ id: "Run:Watched", status: "succeeded" });
    expect(aggregator.getSessionSummaries("all").some((session) => session.id === "run-watched")).toBe(false);
    expect(readRecordedRunMock).not.toHaveBeenCalled();
  });
});
