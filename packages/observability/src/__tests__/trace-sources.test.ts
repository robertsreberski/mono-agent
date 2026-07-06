import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createJsonlRunRecorder,
  DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS,
  listTraceRuns,
  listTraceSources,
  mergeTraceSources,
  pruneTraceSources,
  readTraceRun,
  registerTraceSource,
  TraceSourceRegistryError,
} from "../index.js";
import type { TraceSourceListItem, TraceSourceStatus } from "../index.js";

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

  it("preserves a run's persisted channel `source` alongside its `traceSource` on TraceRunListItem", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    const artifactDir = join(dir, "artifacts");

    await registerTraceSource({
      registryDir,
      sourceId: "agent-cron",
      label: "Agent Cron",
      artifactDir,
      transports: ["cron"],
    });

    const run = createJsonlRunRecorder({
      runId: "cron-run",
      conversationId: "cron:1",
      artifactDir,
      source: "cron",
      sourceDetail: "nightly-report",
    });
    await run.finish({});

    const runs = await listTraceRuns({ registryDir, maxRuns: 10 });
    const item = runs.runs.find((entry) => entry.runId === "cron-run");
    // The run's OWN persisted channel `source` ("cron", the trigger kind)
    // must survive alongside `traceSource` (the process/agent instance it was
    // read from) -- they are distinct fields (see TraceRunListItem's doc
    // comment) and composition must not drop or clobber either.
    expect(item?.source).toBe("cron");
    expect(item?.sourceDetail).toBe("nightly-report");
    expect(item?.traceSource.sourceId).toBe("agent-cron");
  });

  it("defaults trace runs to agent scope and reaches memory runs only when scoped", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    const artifactDir = join(dir, "artifacts");

    await registerTraceSource({
      registryDir,
      sourceId: "agent-memory",
      label: "Agent Memory",
      artifactDir,
    });

    await createJsonlRunRecorder({ runId: "agent-run", conversationId: "telegram:1", artifactDir }).finish({});
    await createJsonlRunRecorder({
      runId: "mem-new",
      conversationId: "memory:capture:distill",
      artifactDir,
      artifactKind: "memory",
      source: "memory",
    }).finish({});
    await createJsonlRunRecorder({
      runId: "mem-legacy",
      conversationId: "memory:legacy",
      artifactDir,
      source: "memory",
    }).finish({});

    const defaults = await listTraceRuns({ registryDir, maxRuns: 10 });
    expect(defaults.runs.map((run) => run.runId)).toEqual(["agent-run"]);

    const memory = await listTraceRuns({ registryDir, scope: "memory", maxRuns: 10 });
    expect(memory.runs.map((run) => run.runId).sort()).toEqual(["mem-legacy", "mem-new"]);

    const all = await listTraceRuns({ registryDir, scope: "all", maxRuns: 10 });
    expect(all.runs.map((run) => run.runId).sort()).toEqual(["agent-run", "mem-legacy", "mem-new"]);

    await expect(readTraceRun({ registryDir }, "agent-memory", "mem-new")).resolves.toBeUndefined();
    await expect(readTraceRun({ registryDir, scope: "memory" }, "agent-memory", "mem-new")).resolves.toMatchObject({
      run: { summary: { runId: "mem-new", summaryFileName: "memory/mem-new.summary.json" } },
    });
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

describe("pruneTraceSources", () => {
  const NOW = Date.parse("2026-07-03T12:00:00.000Z");
  const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
  const ONE_HOUR_MS = 60 * 60 * 1000;

  async function writeRawManifest(
    registryDir: string,
    sourceId: string,
    overrides: { readonly updatedAt: string; readonly pid?: number; readonly status?: TraceSourceStatus },
  ): Promise<string> {
    await mkdir(registryDir, { recursive: true });
    const path = join(registryDir, `${sourceId}.json`);
    await writeFile(
      path,
      JSON.stringify({
        schema: "agent-runtime.trace-source.v1",
        sourceId,
        label: sourceId,
        artifactDir: join(registryDir, "..", `${sourceId}-artifacts`),
        status: overrides.status ?? "running",
        startedAt: overrides.updatedAt,
        updatedAt: overrides.updatedAt,
        ...(overrides.pid === undefined ? {} : { pid: overrides.pid }),
      }, null, 2),
      "utf8",
    );
    return path;
  }

  it("has a 7-day default retention window", () => {
    expect(DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("removes old dead, stopped, and failed manifests while keeping live or fresh ones", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    const oldIso = new Date(NOW - EIGHT_DAYS_MS).toISOString();
    const freshIso = new Date(NOW - ONE_HOUR_MS).toISOString();

    await writeRawManifest(registryDir, "old-running-dead", { updatedAt: oldIso, pid: 111 });
    await writeRawManifest(registryDir, "old-stopped", { updatedAt: oldIso, status: "stopped" });
    await writeRawManifest(registryDir, "old-failed", { updatedAt: oldIso, pid: 444, status: "failed" });
    await writeRawManifest(registryDir, "old-alive", { updatedAt: oldIso, pid: 222 });
    await writeRawManifest(registryDir, "fresh-stopped", { updatedAt: freshIso, pid: 333, status: "stopped" });

    const result = await pruneTraceSources({
      registryDir,
      clock: () => NOW,
      isAlive: (pid) => pid === 222,
    });

    expect(result).toEqual({ removed: 3 });
    const remaining = (await readdir(registryDir)).sort();
    expect(remaining).toEqual(["fresh-stopped.json", "old-alive.json"]);
  });

  it("never deletes a manifest with a live pid regardless of age", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    const ancientIso = new Date(NOW - 365 * 24 * 60 * 60 * 1000).toISOString();
    await writeRawManifest(registryDir, "ancient-alive", { updatedAt: ancientIso, pid: 999 });

    const result = await pruneTraceSources({
      registryDir,
      olderThanMs: 1_000,
      clock: () => NOW,
      isAlive: () => true,
    });

    expect(result).toEqual({ removed: 0 });
    expect(await readdir(registryDir)).toEqual(["ancient-alive.json"]);
  });

  it("tolerates malformed manifest files and leaves non-json files untouched", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    const oldIso = new Date(NOW - EIGHT_DAYS_MS).toISOString();
    await writeRawManifest(registryDir, "old-dead", { updatedAt: oldIso, pid: 111 });
    await writeFile(join(registryDir, "corrupt.json"), "{not valid json", "utf8");
    await writeFile(join(registryDir, "README.txt"), "not a manifest", "utf8");

    await expect(
      pruneTraceSources({ registryDir, clock: () => NOW, isAlive: () => false }),
    ).resolves.toEqual({ removed: 1 });
    expect((await readdir(registryDir)).sort()).toEqual(["README.txt", "corrupt.json"]);
  });

  it("never throws when the registry directory does not exist", async () => {
    const dir = await tempDir();
    await expect(
      pruneTraceSources({ registryDir: join(dir, "does-not-exist"), clock: () => NOW }),
    ).resolves.toEqual({ removed: 0 });
  });
});

describe("mergeTraceSources", () => {
  function item(overrides: Partial<TraceSourceListItem> = {}): TraceSourceListItem {
    return {
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-a",
      label: "agent-a",
      artifactDir: "/tmp/artifacts",
      pid: 123,
      status: "running",
      startedAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      health: "running",
      warnings: [],
      ...overrides,
    };
  }

  it("keeps a source unique to either list, and the fresher heartbeat for a source in both", () => {
    const onlyA = item({ sourceId: "only-a" });
    const onlyB = item({ sourceId: "only-b" });
    const staleDupe = item({ sourceId: "both", label: "stale-copy", updatedAt: "2026-07-01T00:00:00.000Z" });
    const freshDupe = item({ sourceId: "both", label: "fresh-copy", updatedAt: "2026-07-02T00:00:00.000Z" });

    const merged = mergeTraceSources([onlyA, staleDupe], [onlyB, freshDupe]);

    expect(merged).toHaveLength(3);
    const bySourceId = new Map(merged.map((entry) => [entry.sourceId, entry]));
    // Object identity preserved: callers can attribute a winner to its origin list.
    expect(bySourceId.get("only-a")).toBe(onlyA);
    expect(bySourceId.get("only-b")).toBe(onlyB);
    expect(bySourceId.get("both")).toBe(freshDupe);
  });

  it("prefers the earlier list's entry when heartbeats tie", () => {
    const tie = "2026-07-01T00:00:00.000Z";
    const primary = item({ sourceId: "both", label: "primary-copy", updatedAt: tie });
    const secondary = item({ sourceId: "both", label: "secondary-copy", updatedAt: tie });

    const merged = mergeTraceSources([primary], [secondary]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(primary);
  });

  it("is variadic and sorts the union like listTraceSources (fresher first)", () => {
    const oldest = item({ sourceId: "c-oldest", updatedAt: "2026-07-01T00:00:00.000Z" });
    const middle = item({ sourceId: "b-middle", updatedAt: "2026-07-02T00:00:00.000Z" });
    const newest = item({ sourceId: "a-newest", updatedAt: "2026-07-03T00:00:00.000Z" });

    const merged = mergeTraceSources([oldest], [middle], [newest]);

    expect(merged.map((entry) => entry.sourceId)).toEqual(["a-newest", "b-middle", "c-oldest"]);
  });
});
