import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  it("round-trips canonical content-free memory health and preserves it across heartbeat updates", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    let now = Date.parse("2026-07-12T12:00:00.000Z");
    const source = await registerTraceSource({
      registryDir,
      sourceId: "agent-memory-health",
      label: "Agent Memory Health",
      artifactDir: join(dir, "artifacts"),
      clock: () => now,
      memoryHealth: {
        backend: "bujo",
        mode: "journal",
        status: "degraded",
        checkedAt: "2026-07-12T14:15:16+02:00",
        issues: ["runtime_stale", "manifest_missing", "runtime_stale", "private_issue"],
        counts: {
          missingVectors: 3,
          pending: 0,
          due: -1,
          dead: 1.5,
          outbox: 2,
          temporary: 4,
          memories: 5,
          vectors: 5,
          path: "/private/memory.sqlite",
          token: "secret-token",
        },
        path: "/private/agent",
        error: "provider-secret",
        recordIds: ["private-id"],
        text: "private memory text",
      } as never,
    });

    const expected = {
      backend: "bujo",
      mode: "journal",
      status: "degraded",
      checkedAt: "2026-07-12T12:15:16.000Z",
      issues: ["manifest_missing", "runtime_stale"],
      counts: {
        pending: 0,
        outbox: 2,
        temporary: 4,
        memories: 5,
        vectors: 5,
        missingVectors: 3,
      },
    };
    expect(source.manifest.memoryHealth).toEqual(expected);

    const raw = await readFile(join(registryDir, "agent-memory-health.json"), "utf8");
    const parsed = JSON.parse(raw) as { memoryHealth: { counts: object } };
    expect(parsed).toMatchObject({ memoryHealth: expected });
    expect(Object.keys(parsed.memoryHealth)).toEqual([
      "backend",
      "mode",
      "status",
      "checkedAt",
      "issues",
      "counts",
    ]);
    expect(Object.keys(parsed.memoryHealth.counts)).toEqual([
      "pending",
      "outbox",
      "temporary",
      "memories",
      "vectors",
      "missingVectors",
    ]);
    expect(raw).not.toMatch(/private|secret-token|provider-secret/u);

    now += 1_000;
    await source.heartbeat();
    expect(source.manifest.memoryHealth).toEqual(expected);

    now += 1_000;
    await source.update({
      metadata: { reason: "refresh" },
      memoryHealth: {
        backend: "invalid-backend",
        status: "healthy",
        checkedAt: "not-a-timestamp",
        token: "must-not-leak",
      } as never,
    });
    expect(source.manifest.memoryHealth).toEqual(expected);

    now += 1_000;
    await source.update({
      memoryHealth: {
        backend: "none",
        status: "not_configured",
        checkedAt: "2026-07-12T12:15:15.000Z",
      },
    });
    expect(source.manifest.memoryHealth).toEqual(expected);

    now += 1_000;
    await source.update({
      memoryHealth: {
        backend: "supermemory",
        status: "healthy",
        checkedAt: "2026-07-12T12:15:17.000Z",
      },
    });
    expect(source.manifest.memoryHealth).toEqual({
      backend: "supermemory",
      status: "healthy",
      checkedAt: "2026-07-12T12:15:17.000Z",
    });
  });

  it("normalizes hostile memory-health data read from manifests and drops invalid required fields", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    await mkdir(registryDir, { recursive: true });
    const baseManifest = {
      schema: "agent-runtime.trace-source.v1",
      label: "Hostile Source",
      artifactDir: join(dir, "artifacts"),
      status: "running",
      startedAt: "2026-07-12T12:00:00.000Z",
      updatedAt: "2026-07-12T12:00:00.000Z",
    };
    await writeFile(join(registryDir, "hostile.json"), JSON.stringify({
      ...baseManifest,
      sourceId: "hostile",
      memoryHealth: {
        backend: "bujo",
        mode: "invalid-mode",
        status: "unhealthy",
        checkedAt: "2026-07-12T12:00:00Z",
        issues: ["runtime_invalid", "private_issue", "manifest_invalid"],
        counts: {
          pending: 2,
          due: -3,
          dead: 1.25,
          outbox: 1,
          temporary: "4",
          memories: Number.MAX_SAFE_INTEGER + 1,
          vectors: 0,
          missingVectors: 0,
          path: "/private/db",
        },
        path: "/private/db",
        error: "raw native failure",
        token: "credential",
        ids: ["record-id"],
        text: "memory content",
      },
    }), "utf8");

    for (const [sourceId, memoryHealth] of [
      ["invalid-backend", { backend: "remote", status: "healthy", checkedAt: "2026-07-12T12:00:00.000Z" }],
      ["invalid-status", { backend: "bujo", status: "broken", checkedAt: "2026-07-12T12:00:00.000Z" }],
      ["invalid-time", { backend: "bujo", status: "healthy", checkedAt: "yesterday" }],
    ] as const) {
      await writeFile(join(registryDir, `${sourceId}.json`), JSON.stringify({
        ...baseManifest,
        sourceId,
        label: sourceId,
        memoryHealth,
      }), "utf8");
    }

    const result = await listTraceSources({ registryDir });
    expect(result.warnings).toEqual([]);
    expect(result.sources.find((source) => source.sourceId === "hostile")?.memoryHealth).toEqual({
      backend: "bujo",
      status: "unhealthy",
      checkedAt: "2026-07-12T12:00:00.000Z",
      issues: ["manifest_invalid", "runtime_invalid"],
      counts: { pending: 2, outbox: 1, vectors: 0, missingVectors: 0 },
    });
    expect(result.sources.filter((source) => source.sourceId.startsWith("invalid-"))).toHaveLength(3);
    expect(result.sources.filter((source) => source.sourceId.startsWith("invalid-")).every(
      (source) => source.memoryHealth === undefined,
    )).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private|native failure|credential|record-id|memory content|remote|broken|yesterday/u);
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
    await expect(readTraceRun({ registryDir }, "agent-memory", "mem-legacy")).resolves.toMatchObject({
      run: { summary: { runId: "mem-legacy", summaryFileName: "mem-legacy.summary.json" } },
    });
    await expect(readTraceRun({ registryDir, scope: "agent" }, "agent-memory", "mem-legacy")).resolves.toBeUndefined();
    await expect(readTraceRun({ registryDir, scope: "memory" }, "agent-memory", "mem-new")).resolves.toMatchObject({
      run: { summary: { runId: "mem-new", summaryFileName: "memory/mem-new.summary.json" } },
    });
  });

  it("rejects invalid run-list scope values with a typed registry error", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    await expect(listTraceRuns({ registryDir, scope: "invalid" as never })).rejects.toMatchObject({
      code: "invalid_registry_options",
      details: { code: "invalid_registry_options", field: "scope" },
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

  it("keeps the manifest winner but independently carries the freshest normalized memory health", () => {
    const manifestWinner = item({
      sourceId: "both",
      label: "manifest-winner",
      updatedAt: "2026-07-03T00:00:00.000Z",
      memoryHealth: {
        backend: "bujo",
        status: "degraded",
        checkedAt: "2026-07-01T00:00:00.000Z",
        issues: ["runtime_stale"],
      },
    });
    const healthWinner = item({
      sourceId: "both",
      label: "health-winner",
      updatedAt: "2026-07-02T00:00:00.000Z",
      memoryHealth: {
        backend: "supermemory",
        mode: "invalid-mode",
        status: "healthy",
        checkedAt: "2026-07-04T00:00:00Z",
        issues: ["runtime_invalid", "private_issue"],
        counts: { pending: 1, due: -1, token: "secret" },
        path: "/private/memory",
      } as never,
    });

    const [merged] = mergeTraceSources([manifestWinner], [healthWinner]);

    expect(merged?.label).toBe("manifest-winner");
    expect(merged?.updatedAt).toBe("2026-07-03T00:00:00.000Z");
    expect(merged?.memoryHealth).toEqual({
      backend: "supermemory",
      status: "healthy",
      checkedAt: "2026-07-04T00:00:00.000Z",
      issues: ["runtime_invalid"],
      counts: { pending: 1 },
    });
    expect(JSON.stringify(merged)).not.toMatch(/invalid-mode|private|secret/u);
  });

  it("prefers the manifest winner's memory health when checkedAt ties", () => {
    const checkedAt = "2026-07-04T00:00:00.000Z";
    const manifestWinner = item({
      sourceId: "both",
      label: "manifest-winner",
      updatedAt: "2026-07-03T00:00:00.000Z",
      memoryHealth: { backend: "bujo", status: "degraded", checkedAt },
    });
    const other = item({
      sourceId: "both",
      label: "other",
      updatedAt: "2026-07-02T00:00:00.000Z",
      memoryHealth: { backend: "supermemory", status: "healthy", checkedAt },
    });

    const [merged] = mergeTraceSources([manifestWinner], [other]);

    expect(merged?.memoryHealth).toEqual({ backend: "bujo", status: "degraded", checkedAt });
  });
});
