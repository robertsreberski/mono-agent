import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createJsonlRunRecorder,
  listTraceRuns,
  listTraceSources,
  readTraceRun,
  registerTraceSource,
  TraceSourceRegistryError,
} from "../index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trace-sources-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("trace source registry", () => {
  it("registers sources, computes stale health, and lists runs by source", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    const artifactDirA = join(dir, "a-artifacts");
    const artifactDirB = join(dir, "b-artifacts");
    let now = Date.parse("2026-05-16T08:00:00.000Z");
    const clock = () => now;

    const sourceA = await registerTraceSource({
      registryDir,
      sourceId: "agent-a",
      label: "Agent A",
      artifactDir: artifactDirA,
      transports: ["telegram"],
      metadata: { apiKey: "registry-redacted-value" },
      clock,
    });
    const sourceB = await registerTraceSource({
      registryDir,
      sourceId: "agent-b",
      label: "Agent B",
      artifactDir: artifactDirB,
      transports: ["a2a"],
      clock,
    });

    const runA = createJsonlRunRecorder({ runId: "same-run", conversationId: "chat-a", artifactDir: artifactDirA, clock });
    runA.onEvent({ type: "tool.call", toolName: "Read", token: "event-secret" });
    await runA.finish({});
    now = Date.parse("2026-05-16T08:00:03.000Z");
    await sourceB.heartbeat();
    const runB = createJsonlRunRecorder({ runId: "same-run", conversationId: "chat-b", artifactDir: artifactDirB, clock });
    await runB.finish({ failureKind: "runtime_error" });

    now = Date.parse("2026-05-16T08:00:11.000Z");
    const sources = await listTraceSources({ registryDir, staleAfterMs: 10_000, clock });

    expect(sources.warnings).toEqual([]);
    expect(sources.sources.map((source) => [source.sourceId, source.health]).sort()).toEqual([
      ["agent-a", "stale"],
      ["agent-b", "running"],
    ]);
    expect(JSON.stringify(sources)).not.toContain("registry-redacted-value");

    const runs = await listTraceRuns({ registryDir, staleAfterMs: 10_000, clock, maxRuns: 10 });

    expect(runs.runs.map((run) => [run.traceSource.sourceId, run.runId, run.conversationId])).toEqual([
      ["agent-b", "same-run", "chat-b"],
      ["agent-a", "same-run", "chat-a"],
    ]);

    const detail = await readTraceRun({ registryDir, clock }, "agent-a", "same-run");
    expect(detail?.traceSource.sourceId).toBe("agent-a");
    expect(detail?.run.summary.conversationId).toBe("chat-a");
    expect(JSON.stringify(detail)).not.toContain("event-secret");

    await sourceA.stop({ status: "stopped" });
    const stopped = await listTraceSources({ registryDir, clock });
    expect(stopped.sources.find((source) => source.sourceId === "agent-a")).toMatchObject({ health: "stopped" });
  });

  it("keeps malformed manifests as warnings and rejects path-like ids", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    await registerTraceSource({
      registryDir,
      sourceId: "agent-ok",
      label: "Agent OK",
      artifactDir: join(dir, "artifacts"),
    });
    await writeFile(join(registryDir, "bad.json"), "{bad", "utf8");
    await writeFile(join(registryDir, "wrong-schema.json"), JSON.stringify({
      schema: "wrong",
      sourceId: "agent-wrong",
      label: "Agent Wrong",
      artifactDir: join(dir, "wrong-artifacts"),
      status: "running",
      startedAt: "2026-05-16T08:00:00.000Z",
      updatedAt: "2026-05-16T08:00:00.000Z",
    }), "utf8");

    const sources = await listTraceSources({ registryDir });

    expect(sources.sources.map((source) => source.sourceId)).toEqual(["agent-ok"]);
    expect(sources.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/Skipping bad.json/u),
      expect.stringMatching(/wrong-schema.json/u),
    ]));
    await expect(registerTraceSource({
      registryDir,
      sourceId: "../secret",
      label: "Bad",
      artifactDir: join(dir, "artifacts"),
    })).rejects.toBeInstanceOf(TraceSourceRegistryError);
  });
});
