import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDurableHistoryStore } from "../durable-history.js";
import {
  acquireToolHistoryWriter,
  assertToolHistoryWorkerBuildFresh,
  ToolHistoryReader,
  ToolHistoryWriter,
  TOOL_HISTORY_DATABASE,
  TOOL_HISTORY_DIRECTORY,
  TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS,
  TOOL_HISTORY_OWNER_DATABASE,
  TOOL_HISTORY_PERSISTENCE_CEILING_MS,
  TOOL_HISTORY_USER_VERSION,
  toolHistoryRecordId,
  type ToolHistoryRunBinding,
} from "../tool-history-store.js";
import { buildToolHistoryProjection } from "../tool-history-projection.js";

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const childBuffers = new WeakMap<ChildProcess, { stdout: Buffer[]; stderr: Buffer[] }>();
let sourceFixtureRoot = "";
let sourceFixtureModuleUrl = "";

beforeAll(async () => {
  sourceFixtureRoot = await mkdtemp(join(tmpdir(), "tool-history-source-fixture-"));
  const compilerOptions = { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } as const;
  const fixtureScope = join(sourceFixtureRoot, "node_modules", "@mono-agent");
  await mkdir(fixtureScope, { recursive: true, mode: 0o700 });
  await Promise.all([
    symlink(fileURLToPath(new URL("../../../observability", import.meta.url)), join(fixtureScope, "observability"), "dir"),
    symlink(fileURLToPath(new URL("../../../runtime-adapter", import.meta.url)), join(fixtureScope, "runtime-adapter"), "dir"),
  ]);
  const sourceNames = [
    "history-process-liveness",
    "tool-history-artifacts",
    "tool-history-store",
    "tool-history-worker-queue",
    "tool-history-writer-worker",
  ] as const;
  await Promise.all(sourceNames.map(async (name) => {
    const source = await readFile(new URL(`../${name}.ts`, import.meta.url), "utf8");
    const compiled = transpileModule(source, { compilerOptions }).outputText;
    await writeFile(join(sourceFixtureRoot, `${name}.js`), compiled);
  }));
  await writeFile(join(sourceFixtureRoot, "package.json"), '{"type":"module"}\n');
  sourceFixtureModuleUrl = pathToFileURL(join(sourceFixtureRoot, "tool-history-store.js")).href;
});

afterAll(async () => {
  if (sourceFixtureRoot !== "") await rm(sourceFixtureRoot, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "tool-history-test-"));
  tempDirs.push(base);
  return join(base, "history");
}

function artifactRootForHistory(root: string): string {
  return join(root, "..", "artifacts", "tool-output");
}

const binding = (
  runId: string,
  conversationId = "slack:C1#2026-08-14",
  isolated = false,
): ToolHistoryRunBinding => ({
  conversationId,
  logicalConversationId: "slack:C1",
  runId,
  isolated,
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("ToolHistoryWriter and ToolHistoryReader", () => {
  it("persists redacted bounded pairs with stable ids, deterministic per-run sequence, all terminal states, and opaque artifacts", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("run-all-states");
    const artifact = join(artifactRootForHistory(root), run.runId, "artifact.txt");
    await mkdir(join(artifactRootForHistory(root), run.runId), { recursive: true });
    await writeFile(artifact, "artifact body");
    const states = [
      "success", "rejected", "error", "exit_nonzero", "timeout", "signal", "cancelled", "interrupted",
    ] as const;
    const invocations = [];
    const results = [];
    try {
      for (const [index, state] of states.entries()) {
        const toolCallId = `call-${String(index)}`;
        invocations.push(await writer.persist(run, {
          phase: "invocation",
          toolCallId,
          toolName: index % 2 === 0 ? "Bash" : "Read",
          arguments: {
            apiKey: "sk-secret-never-persist",
            authorization: "Bearer private-token",
            query: `needle-${String(index)}`,
          },
        }));
        results.push(await writer.persist(run, {
          phase: "result",
          toolCallId,
          state,
          ...(state === "success" ? {} : {
            failureKind: state === "signal" || state === "interrupted" ? "process_death" : state === "cancelled" ? "cancelled_user" : "runtime_error",
            detailCode: `detail_${state}`,
          }),
          content: index === states.length - 1 ? '"\\'.repeat(15_000) : { answer: `result-${String(index)}` },
          ...(index <= 1 ? { artifacts: [{ path: artifact }] } : {}),
        }));
      }

      expect(invocations.map((record) => record.sequence)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
      expect(results.map((record) => record.sequence)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
      expect(results.at(-1)).toMatchObject({ persistence: "persisted", truncated: true });
      expect(results[0]?.artifactReferences).toEqual([
        { id: expect.stringMatching(/^stha1_/u), available: true },
      ]);
      expect(results[1]?.artifactReferences).toEqual(results[0]?.artifactReferences);

      const duplicate = await writer.persist(run, {
        phase: "invocation",
        toolCallId: "call-0",
        toolName: "Bash",
        arguments: {
          apiKey: "sk-secret-never-persist",
          authorization: "Bearer private-token",
          query: "needle-0",
        },
      });
      expect(duplicate).toMatchObject({
        persistence: "persisted",
        recordId: invocations[0]?.recordId,
        sequence: 1,
      });
      const duplicateResult = await writer.persist(run, {
        phase: "result",
        toolCallId: "call-0",
        state: "success",
        content: { answer: "result-0" },
        artifacts: [{ path: artifact }],
      });
      expect(duplicateResult).toMatchObject({
        persistence: "persisted",
        recordId: results[0]?.recordId,
        sequence: 2,
      });
      const conflict = await writer.persist(run, {
        phase: "invocation",
        toolCallId: "call-0",
        toolName: "DifferentTool",
        arguments: {},
      });
      expect(conflict).toEqual({ persistence: "failed", errorCode: "history_idempotency_conflict" });
      const resultConflict = await writer.persist(run, {
        phase: "result",
        toolCallId: "call-0",
        state: "success",
        detailCode: "different_detail",
        content: { answer: "result-0" },
        artifacts: [{ path: artifact }],
      });
      expect(resultConflict).toEqual({ persistence: "failed", errorCode: "history_idempotency_conflict" });
    } finally {
      await writer.close();
    }

    const reader = new ToolHistoryReader(root);
    const page = reader.search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "run-current",
      limit: 10,
    });
    expect(page.items).toHaveLength(8);
    expect(page.items.map((item) => item.state).sort()).toEqual([...states].sort());
    expect(page.items.every((item) => item.untrusted)).toBe(true);
    const invocation = reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "run-current",
      recordId: invocations[0]!.recordId!,
    });
    expect(JSON.stringify(invocation)).not.toContain("sk-secret-never-persist");
    expect(JSON.stringify(invocation)).not.toContain("private-token");
    expect(invocation.record?.payload).toMatchObject({
      apiKey: "[redacted]",
      authorization: "[redacted]",
    });
    expect(reader.search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "run-current",
      query: "needle-3",
      tools: ["Read"],
      states: ["exit_nonzero"],
    }).items).toHaveLength(1);

    await unlink(artifact);
    expect(reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "run-current",
      recordId: results[0]!.recordId!,
    }).record?.artifactReferences).toEqual([
      { id: expect.stringMatching(/^stha1_/u), available: false },
    ]);
    expect(reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "run-current",
      recordId: results[1]!.recordId!,
    }).record?.artifactReferences).toEqual([
      { id: expect.stringMatching(/^stha1_/u), available: false },
    ]);
    const rawDatabase = await readFile(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    expect(rawDatabase.includes(Buffer.from("sk-secret-never-persist"))).toBe(false);
    const schema = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE), { readOnly: true });
    try {
      expect((schema.prepare("PRAGMA table_info(tool_calls)").all() as Array<{ readonly name: string }>)
        .map((column) => column.name)).not.toContain("parent_tool_call_id");
      expect(indexColumns(schema, "tombstones_run_idx")).toEqual(["conversation_id", "run_id"]);
    } finally {
      schema.close();
    }
    expect(reader.stats()).toMatchObject({
      calls: 8,
      records: 16,
      idempotencyConflicts: 2,
      dangling: 0,
      retainedBytes: expect.any(Number),
    });
  }, 20_000);

  it.skipIf(process.platform === "win32")("fails artifact availability closed after root loss without a path-bearing writer incident", async () => {
    const root = await tempRoot();
    const artifactRoot = artifactRootForHistory(root);
    const retainedRoot = join(root, "..", "retained-tool-output");
    const run = binding("artifact-root-loss");
    const artifact = join(artifactRoot, run.runId, "result.txt");
    await mkdir(join(artifactRoot, run.runId), { recursive: true });
    await writeFile(artifact, "artifact body");
    const writer = await ToolHistoryWriter.open({ root, artifactRoot });
    let resultRecordId: string | undefined;
    try {
      await writer.persist(run, {
        phase: "invocation",
        toolCallId: "root-loss-call",
        toolName: "Read",
        arguments: {},
      });
      const result = await writer.persist(run, {
        phase: "result",
        toolCallId: "root-loss-call",
        state: "success",
        content: { ok: true },
        artifacts: [{ path: artifact }],
      });
      expect(result).toMatchObject({
        persistence: "persisted",
        artifactReferences: [{ id: expect.stringMatching(/^stha1_/u), available: true }],
      });
      resultRecordId = result.recordId;

      await rename(artifactRoot, retainedRoot);
      await symlink(join(root, "..", "missing-tool-output"), artifactRoot, "dir");
      await expect(writer.persist(run, {
        phase: "result",
        toolCallId: "root-loss-call",
        state: "success",
        content: { ok: true },
      })).resolves.toEqual({
        persistence: "failed",
        errorCode: "history_idempotency_conflict",
      });
      await expect(writer.stats()).resolves.toMatchObject({
        writeFailures: 0,
        idempotencyConflicts: 1,
      });
    } finally {
      await writer.close();
    }
    expect(resultRecordId).toEqual(expect.stringMatching(/^sth1_/u));

    const reader = new ToolHistoryReader(root);
    expect(reader.get({
      logicalConversationId: run.logicalConversationId,
      currentConversationId: run.conversationId,
      currentRunId: "current-run",
      recordId: resultRecordId!,
    }).record?.artifactReferences).toEqual([
      { id: expect.stringMatching(/^stha1_/u), available: false },
    ]);

    const database = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE), { readOnly: true });
    try {
      const incidents = database.prepare(`
        SELECT key,last_detail FROM writer_stats
        WHERE key GLOB 'write_failures:*'
           OR key GLOB 'idempotency_conflicts:*'
           OR key='maintenance_failures'
      `).all() as Array<{ readonly key: string; readonly last_detail: string | null }>;
      expect(incidents).toEqual([{
        key: expect.stringMatching(/^idempotency_conflicts:/u),
        last_detail: "artifact-root-loss:root-loss-call:result",
      }]);
      expect(JSON.stringify(incidents)).not.toContain(artifactRoot);
    } finally {
      database.close();
    }
  });

  it("replaces a result-first synthetic invocation in place when the real invocation arrives", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("result-first-run");
    const result = await writer.persist(run, {
      phase: "result",
      toolCallId: "result-first-call",
      state: "success",
      content: { answer: "terminal result survives" },
    });
    const expectedInvocationId = toolHistoryRecordId(
      run.conversationId,
      run.runId,
      "result-first-call",
      "invocation",
    );
    const invocation = await writer.persist(run, {
      phase: "invocation",
      toolCallId: "result-first-call",
      toolName: "Read",
      arguments: { path: "/Users/example/work/repo/input.ts", query: "real-arguments" },
    });
    const duplicate = await writer.persist(run, {
      phase: "invocation",
      toolCallId: "result-first-call",
      toolName: "Read",
      arguments: { path: "/Users/example/work/repo/input.ts", query: "real-arguments" },
    });
    expect(invocation).toMatchObject({
      persistence: "persisted",
      recordId: expectedInvocationId,
      sequence: 1,
    });
    expect(duplicate).toMatchObject({ recordId: expectedInvocationId, sequence: 1 });
    expect(result).toMatchObject({ persistence: "persisted", sequence: 2 });
    expect(await writer.stats()).toMatchObject({ orphanResults: 0, idempotencyConflicts: 0 });
    await writer.close();

    const reader = new ToolHistoryReader(root);
    const page = reader.search({
      logicalConversationId: run.logicalConversationId,
      currentConversationId: "slack:C1#2026-08-15",
      currentRunId: "current-run",
    });
    expect(page.items).toMatchObject([{
      recordId: expectedInvocationId,
      resultRecordId: result.recordId,
      state: "success",
      startSequence: 1,
      endSequence: 2,
    }]);
    const storedInvocation = reader.get({
      logicalConversationId: run.logicalConversationId,
      currentConversationId: "slack:C1#2026-08-15",
      currentRunId: "current-run",
      recordId: expectedInvocationId,
    });
    const storedResult = reader.get({
      logicalConversationId: run.logicalConversationId,
      currentConversationId: "slack:C1#2026-08-15",
      currentRunId: "current-run",
      recordId: result.recordId!,
    });
    expect(storedInvocation.record).toMatchObject({
      sequence: 1,
      payload: { path: "[host-path]/repo/input.ts", query: "real-arguments" },
    });
    expect(storedInvocation.chunk).not.toContain("result_observed_before_invocation");
    expect(storedResult.record).toMatchObject({
      sequence: 2,
      state: "success",
      payload: { answer: "terminal result survives" },
    });
    const databaseBytes = await readFile(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    expect(databaseBytes.includes(Buffer.from("/Users/example"))).toBe(false);
  });

  it("reapplies byte retention after a result-first synthetic invocation grows in place", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({
      root,
      retention: { maxBytes: 700 },
    });
    const run = binding("result-first-retention");
    const result = await writer.persist(run, {
      phase: "result",
      toolCallId: "result-first-retention-call",
      state: "success",
      content: "r".repeat(200),
    });
    await expect(writer.stats()).resolves.toMatchObject({ calls: 1 });

    const invocation = await writer.persist(run, {
      phase: "invocation",
      toolCallId: "result-first-retention-call",
      toolName: "Read",
      arguments: { payload: "i".repeat(1_000) },
    });
    expect(invocation).toMatchObject({ persistence: "persisted", sequence: 1 });
    await expect(writer.stats()).resolves.toMatchObject({
      calls: 0,
      records: 0,
      retainedBytes: 0,
      tombstones: 2,
    });
    await writer.close();

    const scope = {
      logicalConversationId: run.logicalConversationId,
      currentConversationId: "slack:C1#2026-08-15",
      currentRunId: "current-run",
    } as const;
    const reader = new ToolHistoryReader(root);
    expect(reader.get({ ...scope, recordId: invocation.recordId! }))
      .toMatchObject({ tombstone: { reason: "bytes" }, untrusted: true });
    expect(reader.get({ ...scope, recordId: result.recordId! }))
      .toMatchObject({ tombstone: { reason: "bytes" }, untrusted: true });
  });

  it("securely bounds multi-MiB payload preprocessing inside the persistence ceiling", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root, persistenceCeilingMs: 250 });
    const secret = `sk-${"S".repeat(48)}`;
    const oversized = `${"x".repeat(4 * 1024 * 1024)}${secret}`;
    const started = performance.now();
    const persisted = await writer.persist(binding("large-payload"), {
      phase: "invocation",
      toolCallId: "large-call",
      toolName: "Bash",
      arguments: { command: oversized, apiKey: secret },
    });
    const elapsed = performance.now() - started;
    await writer.finishRun(binding("large-payload"), "succeeded");
    await writer.close();

    expect(persisted).toMatchObject({ persistence: "persisted", truncated: true });
    expect(persisted.originalBytes).toBeGreaterThan(64 * 1024);
    expect(elapsed).toBeLessThan(750);
    const reader = new ToolHistoryReader(root);
    const visible = JSON.stringify(reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      recordId: persisted.recordId!,
      chunkBytes: 8 * 1024,
    }));
    expect(visible).toContain("oversized value omitted before redaction");
    expect(visible).toContain("[redacted]");
    expect(visible).not.toContain(secret);
    const databaseBytes = await readFile(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    expect(databaseBytes.includes(Buffer.from(secret))).toBe(false);
  }, 10_000);

  it("sanitizes and bounds writer incident detail before raw SQLite persistence", async () => {
    const root = await tempRoot();
    const privatePath = "/Users/example/.ssh/id_rsa";
    const writer = await ToolHistoryWriter.open({ root });
    const failed = await writer.persist(binding("writer-detail-path"), {
      phase: "invocation",
      toolCallId: "uncloneable-detail",
      toolName: "Inspect",
      arguments: { uncloneable: Symbol(privatePath) },
    });
    await writer.close();

    expect(failed).toEqual({ persistence: "failed", errorCode: "history_write_failed" });
    const databasePath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const legacyDatabase = new DatabaseSync(databasePath);
    try {
      legacyDatabase.prepare("DELETE FROM metadata WHERE key='writer_stat_detail_policy'").run();
      legacyDatabase.prepare(`
        INSERT INTO writer_stats (key,value,last_detail,updated_at_ms) VALUES (?,?,?,?)
      `).run(
        "write_failures:legacy-oversized",
        1,
        `history_write_failed:${"x".repeat(4_080)}${privatePath}`,
        Date.now(),
      );
    } finally {
      legacyDatabase.close();
    }
    expect((await readFile(databasePath)).includes(Buffer.from(privatePath)), "seeded legacy detail").toBe(true);

    const reopenedWriter = await ToolHistoryWriter.open({ root });
    await reopenedWriter.close();
    const rawBytes = await readFile(databasePath);
    expect(rawBytes.includes(Buffer.from(privatePath)), "raw private writer detail").toBe(false);
    expect(rawBytes.includes(Buffer.from("/Users/example")), "raw private writer prefix").toBe(false);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const incidents = database.prepare(`
        SELECT key,value,last_detail FROM writer_stats WHERE key GLOB 'write_failures:*'
      `).all() as Array<{ readonly key: string; readonly value: number; readonly last_detail: string }>;
      expect(incidents).toHaveLength(2);
      for (const incident of incidents) {
        expect(incident).toMatchObject({
          key: expect.stringMatching(/^write_failures:/u),
          value: 1,
          last_detail: expect.stringContaining("history_write_failed"),
        });
        expect(incident.last_detail).not.toContain(privatePath);
        expect(Buffer.byteLength(incident.last_detail, "utf8")).toBeLessThanOrEqual(1_000);
      }
      expect(incidents.some(({ last_detail: detail }) => detail.includes("[private-path]"))).toBe(true);
      expect(incidents.some(({ last_detail: detail }) => detail.includes("could not be cloned"))).toBe(true);
      expect(incidents.some(({ last_detail: detail }) => detail.includes("exceeded the inspection bound"))).toBe(true);
    } finally {
      database.close();
    }
  });

  it("drops out-of-root and symlinked provider artifact paths without probing or persisting them", async () => {
    const root = await tempRoot();
    const artifactRoot = artifactRootForHistory(root);
    const run = binding("artifact-scope");
    const runRoot = join(artifactRoot, run.runId);
    const allowed = join(runRoot, "allowed.txt");
    const outside = join(root, "..", "outside-secret.txt");
    const symlinked = join(runRoot, "linked-secret.txt");
    await mkdir(runRoot, { recursive: true });
    await writeFile(allowed, "allowed");
    await writeFile(outside, "outside");
    if (process.platform !== "win32") await symlink(outside, symlinked);

    const writer = await ToolHistoryWriter.open({ root, artifactRoot });
    await writer.persist(run, {
      phase: "invocation",
      toolCallId: "artifact-call",
      toolName: "McpTool",
      arguments: {},
    });
    const persisted = await writer.persist(run, {
      phase: "result",
      toolCallId: "artifact-call",
      state: "success",
      content: "done",
      artifacts: [
        { path: allowed },
        { path: outside },
        ...(process.platform === "win32" ? [] : [{ path: symlinked }]),
      ],
    });
    await writer.close();

    expect(persisted.artifactReferences).toEqual([
      { id: expect.stringMatching(/^stha1_/u), available: true },
    ]);
    const databasePath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const rawBytes = await readFile(databasePath);
    expect(rawBytes.includes(Buffer.from(outside))).toBe(false);
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(raw.prepare("SELECT count(*) AS count FROM artifact_refs").get()).toEqual({ count: 1 });
    } finally {
      raw.close();
    }
    expect(new ToolHistoryReader(root).get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      toolCallId: "artifact-call",
    }).record?.artifactReferences).toEqual([
      { id: expect.stringMatching(/^stha1_/u), available: true },
    ]);
  });

  it("keeps ordinary managed-tool payloads inspectable while neutralizing every host path span", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("useful-path-history");
    const sourcePath = "/Users/example/work/repo/src/index.ts";
    const outputPath = "/Users/example/work/repo/src/generated/output.ts";
    const windowsPath = "C:\\Users\\Alice\\repo\\src\\windows.ts:18:6";
    const privateArtifact = "/Users/example/.mono-agent/artifacts/tool-output/private-run/bash.txt";
    const secret = ["sk", "-", "A".repeat(48)].join("");
    const calls = [
      { id: "read", name: "Read", arguments: { file_path: sourcePath }, content: `export found at ${sourcePath}:4:2` },
      { id: "write", name: "Write", arguments: { file_path: outputPath, content: "export const generated = true;" }, content: `wrote ${outputPath}` },
      { id: "edit", name: "Edit", arguments: { file_path: sourcePath, old_string: "before", new_string: "after" }, content: `updated ${sourcePath}` },
      { id: "bash", name: "Bash", arguments: { command: `ls -la /etc && cat ${sourcePath}`, apiKey: "never-visible" }, content: `stack at ${windowsPath}), token ${secret}` },
      { id: "grep", name: "Grep", arguments: { pattern: "needle", path: "/Users/example/work/repo/src" }, content: [{ path: sourcePath, line: 7, text: "needle" }] },
      { id: "glob", name: "Glob", arguments: { pattern: "/Users/example/work/repo/src/**/*.{ts,tsx}" }, content: [sourcePath, outputPath, privateArtifact, "https://example.com/docs/path"] },
    ] as const;
    const recordIds: string[] = [];
    try {
      for (const call of calls) {
        const invocation = await writer.persist(run, {
          phase: "invocation",
          toolCallId: call.id,
          toolName: call.name,
          arguments: call.arguments,
        });
        const result = await writer.persist(run, {
          phase: "result",
          toolCallId: call.id,
          state: "success",
          content: call.content,
        });
        recordIds.push(invocation.recordId!, result.recordId!);
      }
    } finally {
      await writer.close();
    }

    const reader = new ToolHistoryReader(root);
    const search = reader.search({ logicalConversationId: "slack:C1", currentConversationId: "slack:C1#2026-08-14", currentRunId: "current", limit: 10 });
    const fetched = recordIds.map((recordId) => reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      recordId,
      chunkBytes: 8 * 1024,
    }));
    const projection = buildToolHistoryProjection(reader, "slack:C1", "slack:C1#2026-08-14", "current");
    const visible = JSON.stringify({ search, fetched, projection });

    expect(search.items.map((item) => item.toolName).sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    expect(visible).toContain("[host-path]/src/index.ts");
    expect(visible).toContain("[host-path]/generated/output.ts");
    expect(visible).toContain("[host-path]/src/windows.ts:18:6");
    expect(visible).toContain("ls -la");
    expect(visible).toContain("needle");
    expect(visible).toContain("**/*.{ts,tsx}");
    expect(visible).toContain("https://example.com/docs/path");
    expect(visible).toContain("[private-path]");
    expect(visible).toContain("[redacted]");
    for (const hidden of [sourcePath, outputPath, windowsPath, privateArtifact, "/Users/example", "C:\\Users\\Alice", ".mono-agent", "private-run", secret]) {
      expect(visible, hidden).not.toContain(hidden);
    }

    const databaseBytes = await readFile(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    for (const hidden of [sourcePath, outputPath, windowsPath, privateArtifact, secret]) {
      expect(databaseBytes.includes(Buffer.from(hidden)), hidden).toBe(false);
    }
  });

  it("removes compound credential assignments before SQLite writes and on every reader projection", async () => {
    const root = await tempRoot();
    const run = binding("compound-credential-history");
    const awsSecretAccessKey = [
      "wJalrXUtnFEMI/K7MDENG/",
      "bPxRfiCYEXAMPLEKEY",
    ].join("");
    const privateKeyHeader = ["-----BEGIN RSA", " PRIVATE KEY-----"].join("");
    const encryptionAssignmentKey = "TOOL_HISTORY_ENCRYPTION_KEY";
    const encryptionAssignmentValue = "history-encryption-assignment-fixture";
    const apiKeyAssignmentKey = "openAPIkey";
    const apiKeyAssignmentValue = "history-api-key-assignment-fixture";
    const sensitiveAssignments = [
      `AWS_SECRET_ACCESS_KEY=${awsSecretAccessKey}`,
      "STRIPE_SECRET_KEY=sk_live_...",
      `PRIVATE_KEY=${privateKeyHeader}`,
      `${encryptionAssignmentKey}=${encryptionAssignmentValue}`,
      `${apiKeyAssignmentKey}=${apiKeyAssignmentValue}`,
      "DATABASE_URL=postgres://user:password@host/db",
    ];
    const structuredSecrets = [
      "structured-encryption-fixture",
      "postgres://structured:password@host/db",
    ];
    const hiddenValues = [
      ...sensitiveAssignments,
      ...sensitiveAssignments.map((assignment) => assignment.slice(assignment.indexOf("=") + 1)),
      ...structuredSecrets,
    ];
    const safeContext = {
      publicKey: "PUBLIC_KEY=ssh-rsa-public-material",
      primaryKey: "PRIMARY_KEY=record-id",
      sortKey: "SORT_KEY=created-at",
      docsUrl: "DOCS_URL=https://example.com/docs/path",
      connectionAddress: "postgres://host/db",
      input_tokens: 37,
      marker: "useful-safe-context-marker",
    };
    const payload = {
      sensitiveAssignments,
      structured: {
        ENCRYPTION_KEY: structuredSecrets[0],
        DATABASE_URL: structuredSecrets[1],
      },
      safeContext,
    };
    const writer = await ToolHistoryWriter.open({ root });
    const invocation = await writer.persist(run, {
      phase: "invocation",
      toolCallId: "compound-credential-call",
      toolName: "Inspect",
      arguments: payload,
    });
    const result = await writer.persist(run, {
      phase: "result",
      toolCallId: "compound-credential-call",
      state: "success",
      content: payload,
    });
    await writer.close();
    if (invocation.recordId === undefined || result.recordId === undefined) {
      throw new Error("Compound credential history was not persisted.");
    }

    const databasePath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const databaseBytes = await readFile(databasePath);
    for (const hidden of hiddenValues) {
      expect(databaseBytes.includes(Buffer.from(hidden)), hidden).toBe(false);
    }
    for (const retained of Object.values(safeContext).map(String)) {
      expect(databaseBytes.includes(Buffer.from(retained)), retained).toBe(true);
    }

    // Simulate an unmerged vulnerable writer so the independent read guard is
    // exercised against hostile raw storage rather than only sanitized writes.
    const raw = new DatabaseSync(databasePath);
    try {
      raw.prepare("UPDATE tool_records SET payload_json=?, search_text=? WHERE record_id=?")
        .run(JSON.stringify(payload), safeContext.marker, invocation.recordId);
    } finally {
      raw.close();
    }

    const reader = new ToolHistoryReader(root);
    const search = reader.search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      query: safeContext.marker,
    });
    const fetched = [invocation.recordId, result.recordId].map((recordId) => reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      recordId,
      chunkBytes: 8 * 1024,
    }));
    const projection = buildToolHistoryProjection(
      reader,
      "slack:C1",
      "slack:C1#2026-08-14",
      "current",
    );
    const visible = JSON.stringify({ search, fetched, projection });

    expect(search.items).toHaveLength(1);
    expect(visible).toContain("useful-safe-context-marker");
    expect(visible).toContain("PUBLIC_KEY=ssh-rsa-public-material");
    expect(visible).toContain("PRIMARY_KEY=record-id");
    expect(visible).toContain("SORT_KEY=created-at");
    expect(visible).toContain("DOCS_URL=https://example.com/docs/path");
    expect(visible).toContain("postgres://host/db");
    expect(visible).toContain("input_tokens");
    expect(projection?.text).toContain("[tool payload omitted because it contained a private host path]");
    expect(projection?.text).not.toContain(encryptionAssignmentKey);
    expect(projection?.text).not.toContain(encryptionAssignmentValue);
    expect(projection?.text).not.toContain(apiKeyAssignmentKey);
    expect(projection?.text).not.toContain(apiKeyAssignmentValue);
    for (const hidden of hiddenValues) {
      expect(visible, hidden).not.toContain(hidden);
    }
  });

  it("blocks every hostile JSON credential occurrence and omits values whose structured keys cannot be retained", async () => {
    const root = await tempRoot();
    const run = binding("serialized-json-redaction");
    const omission = "[tool payload omitted because it contained a private host path]";
    const preprocessingOmission = "[oversized value omitted before redaction]";
    const hostileJsonDocuments = {
      duplicateUnsafeFirst: '{"token":"fixture-duplicate-first-secret","token":"[redacted]"}',
      duplicateUnsafeLast: '{"token":"[redacted]","token":"fixture-duplicate-last-secret"}',
      nestedDuplicate: '{"nested":{"password":"fixture-nested-duplicate-secret","password":"[redacted]"}}',
      arrayDuplicate: '[{"api_key":"[redacted]","api_key":"fixture-array-duplicate-secret"}]',
      keyEmbeddedAssignment: '{"note password=fixture-key-assignment-secret":1}',
      escapedKeyEmbeddedAssignment: '{"api\\u005fkey\\u003dfixture-escaped-key-assignment-secret":1}',
      serializedTail: JSON.stringify({ command: "TOKEN=[redacted],fixture-secret-tail" }),
      escapedKeyDocument: '{"credenti\\u0061ls":"fixture-escaped-key-secret"}',
      escapedOperator: '{"command":"TOKEN\\u003dfixture-escaped-operator-secret"}',
      malformedAssignment: '{"token":"fixture-malformed-assignment-secret',
      malformedSentinelTail: '{"command":"TOKEN=[redacted],fixture-malformed-json-tail-secret',
      truncatedEscapedKeyDocument: '{"credenti\\u0061ls":"fixture-truncated-secret',
      truncatedEscapedOperator: '{"command":"TOKEN\\u003dfixture-truncated-secret',
      truncatedEscapedKeyAssignment: '{"api\\u005fkey\\u003dfixture-truncated-key-secret',
      invalidLiteralBeforeEscapedAssignment: '{"x": nul, "command":"TOKEN\\u003dfixture-ordering-secret"}',
      invalidLiteralBeforeEscapedKey: '{"x": nul, "credenti\\u0061ls":"fixture-ordering-secret"}',
      invalidTailBeforeEscapedKey: '{"a":1} zz {"credenti\\u0061ls":"fixture-tail-secret"}',
      invalidUnquotedKeyBeforeEscapedAssignment: '{1:2, "command":"TOKEN\\u003dfixture-badkey-secret"}',
      concatenatedJsonDocuments: '{"safe":true}\n{"command":"TOKEN\\u003dfixture-concatenated-secret"}',
      malformedTail: "credential=[redacted],fixture-malformed-tail",
    } as const;
    const safeJsonDocuments = {
      stableSerialized: JSON.stringify({
        token: "[redacted]",
        nested: { credentials: "[redacted]" },
        command: "TOKEN=[redacted]",
        safe: "visible",
      }),
      stableNegative: JSON.stringify({ safe: "stable-json-negative" }),
      safeDuplicate: '{"token":"[redacted]","token":"[redacted]"}',
      safeEscapedKeyDocument: '{"tok\\u0065n":"[redacted]"}',
      safeEscapedOperator: '{"command":"TOKEN\\u003d[redacted]"}',
      safeKeyAssignment: '{"note password=[redacted]":1}',
      harmlessObjectLike: "{foo: bar}",
      quotedProse: '"quoted prose", said Alice',
      numberedItem: "[1] item",
      malformedSentinel: '{"token":"[redacted]"',
      nestedMalformedSentinel: '{"nested":{"credentials":"[redacted]"',
      unterminatedEscapedString: '{"note":"harmless\\u0020prefix',
      malformedEscape: '{"note":"harmless\\q',
      invalidLiteralBeforeEscapedKeySentinel: '{"x": nul, "credenti\\u0061ls":"[redacted]"}',
      terminalSentinel: "TOKEN=[redacted]",
      sentinelObject: { token: "[redacted]", credentials: "[redacted]" },
    } as const;
    const omittedHostileDocuments = Object.fromEntries(
      Object.keys(hostileJsonDocuments).map((key) => [key, omission]),
    );
    const hiddenJsonSecrets = [
      "fixture-duplicate-first-secret",
      "fixture-duplicate-last-secret",
      "fixture-nested-duplicate-secret",
      "fixture-array-duplicate-secret",
      "fixture-key-assignment-secret",
      "fixture-escaped-key-assignment-secret",
      "fixture-secret-tail",
      "fixture-escaped-key-secret",
      "fixture-escaped-operator-secret",
      "fixture-malformed-assignment-secret",
      "fixture-malformed-json-tail-secret",
      "fixture-truncated-secret",
      "fixture-truncated-key-secret",
      "fixture-ordering-secret",
      "fixture-tail-secret",
      "fixture-badkey-secret",
      "fixture-concatenated-secret",
      "fixture-malformed-tail",
    ];
    const oversizedKey = `${"k".repeat(513)}password`;
    const remainingBudgetKey = `${"r".repeat(292)}password`;
    const largeSafeValue = `remaining-budget-safe-marker-${"s".repeat(65_271)}`;
    expect(largeSafeValue).toHaveLength(65_300);
    expect(remainingBudgetKey).toHaveLength(300);

    const invocationPayload = {
      ...hostileJsonDocuments,
      ...safeJsonDocuments,
      benign: {
        PUBLIC_KEY: "ssh-rsa-public-material",
        DOCS_URL: "https://example.com/docs/path",
        input_tokens: 37,
        marker: "serialized-redaction-reader-marker",
      },
      oversizedKeys: { [oversizedKey]: "fixture-oversized-key-secret" },
    };
    const resultPayload = {
      largeSafeValue,
      [remainingBudgetKey]: "fixture-remaining-budget-secret",
    };
    const expectedInvocation = {
      ...omittedHostileDocuments,
      ...safeJsonDocuments,
      benign: invocationPayload.benign,
      oversizedKeys: { __oversized_key_0__: preprocessingOmission },
    };
    const expectedResult = {
      largeSafeValue: `${largeSafeValue.slice(0, 4_096)}…[truncated 61204 bytes]`,
      __oversized_key_1__: preprocessingOmission,
    };

    const writer = await ToolHistoryWriter.open({ root });
    const invocation = await writer.persist(run, {
      phase: "invocation",
      toolCallId: "serialized-json-redaction-call",
      toolName: "Inspect",
      arguments: invocationPayload,
    });
    const result = await writer.persist(run, {
      phase: "result",
      toolCallId: "serialized-json-redaction-call",
      state: "success",
      content: resultPayload,
    });
    await writer.finishRun(run, "succeeded");
    await writer.close();
    expect(invocation).toMatchObject({ persistence: "persisted", truncated: true });
    expect(result).toMatchObject({ persistence: "persisted", truncated: true });
    if (invocation.recordId === undefined || result.recordId === undefined) {
      throw new Error("Serialized JSON redaction records were not persisted.");
    }

    const expectedInvocationJson = JSON.stringify(expectedInvocation);
    const expectedResultJson = JSON.stringify(expectedResult);
    const databasePath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(`
        SELECT phase,payload_json,search_text FROM tool_records
        WHERE conversation_id=? AND run_id=? ORDER BY seq
      `).all(run.conversationId, run.runId)).toEqual([
        { phase: "invocation", payload_json: expectedInvocationJson, search_text: expectedInvocationJson.toLowerCase() },
        { phase: "result", payload_json: expectedResultJson, search_text: expectedResultJson.toLowerCase() },
      ]);
    } finally {
      database.close();
    }

    const rawBytes = await readFile(databasePath);
    for (const hidden of [
      ...hiddenJsonSecrets,
      "fixture-oversized-key-secret",
      "fixture-remaining-budget-secret",
      oversizedKey,
      remainingBudgetKey,
    ]) {
      expect(rawBytes.includes(Buffer.from(hidden)), hidden).toBe(false);
    }
    for (const retained of [
      "serialized-redaction-reader-marker",
      "stable-json-negative",
      "visible",
      "{foo: bar}",
      "quoted prose",
      "[1] item",
      "ssh-rsa-public-material",
      "https://example.com/docs/path",
      "remaining-budget-safe-marker",
      preprocessingOmission,
    ]) {
      expect(rawBytes.includes(Buffer.from(retained)), retained).toBe(true);
    }

    // Reinsert the hostile pre-fix payload to prove that every independent
    // reader surface fails closed even when raw storage predates the writer fix.
    const vulnerablePayload = {
      ...hostileJsonDocuments,
      ...safeJsonDocuments,
      benign: invocationPayload.benign,
    };
    const raw = new DatabaseSync(databasePath);
    try {
      raw.prepare("UPDATE tool_records SET payload_json=?, search_text=? WHERE record_id=?")
        .run(JSON.stringify(vulnerablePayload), invocationPayload.benign.marker, invocation.recordId);
    } finally {
      raw.close();
    }

    const reader = new ToolHistoryReader(root);
    const scope = {
      logicalConversationId: run.logicalConversationId,
      currentConversationId: "slack:C1#2026-08-15",
      currentRunId: "current-run",
    } as const;
    const search = reader.search({ ...scope, query: "serialized-redaction-reader-marker" });
    const invocationGet = reader.get({ ...scope, recordId: invocation.recordId, chunkBytes: 8 * 1024 });
    const resultGet = reader.get({ ...scope, recordId: result.recordId, chunkBytes: 8 * 1024 });
    expect(search.items).toHaveLength(1);
    expect(invocationGet.record?.payload).toEqual({
      ...omittedHostileDocuments,
      ...safeJsonDocuments,
      benign: invocationPayload.benign,
    });
    expect(resultGet.record?.payload).toEqual(expectedResult);

    const projection = buildToolHistoryProjection(
      reader,
      run.logicalConversationId,
      scope.currentConversationId,
      scope.currentRunId,
    );
    const visible = JSON.stringify({ search, invocationGet, resultGet, projection });
    for (const retained of [
      omission,
      preprocessingOmission,
      "serialized-redaction-reader-marker",
      "stable-json-negative",
      "visible",
      "{foo: bar}",
      "quoted prose",
      "[1] item",
      "TOKEN=[redacted]",
      "ssh-rsa-public-material",
      "remaining-budget-safe-marker",
    ]) {
      expect(visible, retained).toContain(retained);
    }
    for (const hidden of [
      ...hiddenJsonSecrets,
      "fixture-oversized-key-secret",
      "fixture-remaining-budget-secret",
      oversizedKey,
      remainingBudgetKey,
    ]) {
      expect(visible, hidden).not.toContain(hidden);
    }
  });

  it("preserves path-keyed values collision-safely across raw storage, reads, and cold projection", async () => {
    const root = await tempRoot();
    const run = binding("path-keyed-history");
    const macPath = "/Users/example/work/repo/src/a.ts";
    const linuxPath = "/home/example/work/repo/src/a.ts";
    const privatePath = "/Users/example/.ssh/id_rsa";
    const safeOpaqueKey = "[host-path]/src/a.ts";
    const nested = Object.fromEntries([
      ["ordinary", "ordinary-value"],
      [safeOpaqueKey, "safe-opaque-value"],
      [macPath, ["mac-value", "needle"]],
      [linuxPath, ["linux-value", "needle"]],
      [privatePath, "private-path-value"],
      ["__proto__", "proto-value"],
      ["constructor", "constructor-value"],
      ["prototype", "prototype-value"],
    ]);
    const writer = await ToolHistoryWriter.open({ root });
    const invocation = await writer.persist(run, {
      phase: "invocation",
      toolCallId: "path-keyed-call",
      toolName: "Inspect",
      arguments: { nested },
    });
    await writer.persist(run, {
      phase: "result",
      toolCallId: "path-keyed-call",
      state: "success",
      content: { status: "complete-value" },
    });
    await writer.close();
    expect(invocation.recordId).toMatch(/^sth1_/u);

    const reader = new ToolHistoryReader(root);
    const search = reader.search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      query: "needle",
    });
    expect(search.items).toHaveLength(1);

    let chunkOffset = 0;
    let pagedJson = "";
    for (let pageCount = 0; pageCount < 100; pageCount += 1) {
      const page = reader.get({
        logicalConversationId: "slack:C1",
        currentConversationId: "slack:C1#2026-08-14",
        currentRunId: "current",
        recordId: invocation.recordId!,
        chunkOffset,
        chunkBytes: 48,
      });
      expect(page.chunk).toEqual(expect.any(String));
      pagedJson += page.chunk ?? "";
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(chunkOffset);
      chunkOffset = page.nextOffset;
    }
    const pagedPayload = JSON.parse(pagedJson) as { readonly nested: Record<string, unknown> };
    const projection = buildToolHistoryProjection(reader, "slack:C1", "slack:C1#2026-08-14", "current");
    const visible = JSON.stringify({ search, pagedPayload, projection });
    const hostPathEntries = Object.entries(pagedPayload.nested)
      .filter(([key]) => key.startsWith(safeOpaqueKey));

    expect(pagedPayload.nested.ordinary).toBe("ordinary-value");
    expect(pagedPayload.nested[safeOpaqueKey]).toBe("safe-opaque-value");
    expect(hostPathEntries).toHaveLength(3);
    expect(new Set(hostPathEntries.map(([key]) => key)).size).toBe(3);
    expect(Object.values(pagedPayload.nested)).toEqual(expect.arrayContaining([
      "ordinary-value",
      "safe-opaque-value",
      ["mac-value", "needle"],
      ["linux-value", "needle"],
      "private-path-value",
      "proto-value",
      "constructor-value",
      "prototype-value",
    ]));
    expect(Object.prototype.hasOwnProperty.call(pagedPayload.nested, "__proto__")).toBe(true);
    expect(visible).toContain("[private-path]");
    expect(visible).toContain("complete-value");
    for (const value of [
      "ordinary-value",
      "safe-opaque-value",
      "mac-value",
      "linux-value",
      "private-path-value",
      "proto-value",
      "constructor-value",
      "prototype-value",
    ]) {
      expect(search.items[0]!.preview, value).toContain(value);
      expect(visible, value).toContain(value);
    }
    for (const hidden of [macPath, linuxPath, privatePath, "/Users/example", "/home/example"]) {
      expect(visible, hidden).not.toContain(hidden);
    }

    const databaseBytes = await readFile(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    for (const hidden of [macPath, linuxPath, privatePath, "/Users/example", "/home/example"]) {
      expect(databaseBytes.includes(Buffer.from(hidden)), hidden).toBe(false);
    }
  });

  it("persists and re-sanitizes delimiter-adjacent paths without collapsing adjacent records", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("delimiter-path-history");
    const cases = [
      { raw: "[/Users/example/.ssh/id_rsa]", expected: "[[private-path]]", paths: ["/Users/example/.ssh/id_rsa"] },
      { raw: "{/Users/example/private/x.key}", expected: "{[host-path]/private/x.key}", paths: ["/Users/example/private/x.key"] },
      { raw: "-->/Users/example/proj/a.ts", expected: "-->[host-path]/proj/a.ts", paths: ["/Users/example/proj/a.ts"] },
      { raw: "x;/Users/example/proj/b.ts", expected: "x;[host-path]/proj/b.ts", paths: ["/Users/example/proj/b.ts"] },
      { raw: "cmd|/Users/example/bin/tool", expected: "cmd|[host-path]/bin/tool", paths: ["/Users/example/bin/tool"] },
      { raw: "user@/Users/example/share", expected: "user@[host-path]/share", paths: ["/Users/example/share"] },
      {
        raw: "/Users/example/local/a.ts,/Users/example/secret/b.ts",
        expected: "[host-path]/local/a.ts,[host-path]/secret/b.ts",
        paths: ["/Users/example/local/a.ts", "/Users/example/secret/b.ts"],
      },
      { raw: "C:\\Users\\Rob\\repo\\src\\a.ts:9:2", expected: "[host-path]/src/a.ts:9:2", paths: ["C:\\Users\\Rob\\repo\\src\\a.ts:9:2"] },
      { raw: "\\\\server\\share\\Users\\Rob\\repo\\src\\a.ts", expected: "[host-path]/src/a.ts", paths: ["\\\\server\\share\\Users\\Rob\\repo\\src\\a.ts"] },
      { raw: "file:///Users/example/repo/src/a.ts", expected: "[host-path]/src/a.ts", paths: ["file:///Users/example/repo/src/a.ts"] },
      { raw: "~/repo/src/a.ts", expected: "[home-path]/src/a.ts", paths: ["~/repo/src/a.ts"] },
      { raw: "gcc -I/Users/example/repo/include", expected: "gcc -I[host-path]/repo/include", paths: ["/Users/example/repo/include"] },
      { raw: "tar -C/Users/example/archive source.tgz", expected: "tar -C[host-path]/archive source.tgz", paths: ["/Users/example/archive"] },
      { raw: "docker -v/Users/example/data:/data image", expected: "docker -v[host-path]/data:/data image", paths: ["/Users/example/data"] },
      { raw: "rsync -av/Users/example/source target", expected: "rsync -av[host-path]/source target", paths: ["/Users/example/source"] },
      { raw: "~rob/repo/src/a.ts", expected: "[home-path]/src/a.ts", paths: ["~rob/repo/src/a.ts"] },
      { raw: ".../Users/example/repo/src/a.ts", expected: "...[host-path]/src/a.ts", paths: ["/Users/example/repo/src/a.ts"] },
      { raw: "/Users/example/Users/example", expected: "[host-path]", paths: ["/Users/example/Users/example"] },
      { raw: "[host-path]/Users/example/repo/a.ts", expected: "[host-path]/repo/a.ts", paths: ["/Users/example/repo/a.ts"] },
      {
        raw: "https://example.com/Users/example/a.ts,/Users/example/still-url.ts",
        expected: "https://example.com/Users/example/a.ts,/Users/example/still-url.ts",
        paths: [],
      },
      {
        raw: "custom+scheme://host/Users/example/a.ts;segment/Users/example/b.ts",
        expected: "custom+scheme://host/Users/example/a.ts;segment/Users/example/b.ts",
        paths: [],
      },
      {
        raw: "https://example.com/Users/example/.ssh/url_rsa?next=/Users/example/.aws/url-credentials#fragment",
        expected: "https://example.com/Users/example/.ssh/url_rsa?next=/Users/example/.aws/url-credentials#fragment",
        paths: [],
      },
      { raw: ".ssh/id_rsa", expected: "[private-path]", paths: [".ssh/id_rsa"] },
      { raw: ".aws/credentials", expected: "[private-path]", paths: [".aws/credentials"] },
      { raw: "/Users/example/.git-credentials", expected: "[private-path]", paths: ["/Users/example/.git-credentials"] },
      { raw: "~rob/.netrc", expected: "[private-path]", paths: ["~rob/.netrc"] },
      { raw: "/home/example/.npmrc", expected: "[private-path]", paths: ["/home/example/.npmrc"] },
      { raw: "./src/a.ts ../src/b.ts", expected: "./src/a.ts ../src/b.ts", paths: [] },
      { raw: "https://example.com/Users/example/a.ts", expected: "https://example.com/Users/example/a.ts", paths: [] },
      { raw: "</session_tool_history>", expected: "</session_tool_history>", paths: [] },
      { raw: "3 / 4", expected: "3 / 4", paths: [] },
      { raw: "build/run/test and alpha/Users/example", expected: "build/run/test and alpha/Users/example", paths: [] },
      { raw: "/^foo$/giu", expected: "/^foo$/giu", paths: [] },
      { raw: "GET /api/v1/users HTTP/1.1", expected: "GET /api/v1/users HTTP/1.1", paths: [] },
      { raw: "GET /Users/example/.ssh/id_rsa HTTP/1.1", expected: "GET [private-path] HTTP/1.1", paths: ["/Users/example/.ssh/id_rsa"] },
      { raw: "GET /api/read?file=/Users/example/.ssh/id_rsa HTTP/1.1", expected: "GET /api/read?file=[private-path] HTTP/1.1", paths: ["/Users/example/.ssh/id_rsa"] },
      { raw: "/public/assets/app.js", expected: "/public/assets/app.js", paths: [] },
    ] as const;
    const invocation = await writer.persist(run, {
      phase: "invocation",
      toolCallId: "delimiter-call",
      toolName: "Read",
      arguments: { cases: cases.map(({ raw }) => raw) },
    });
    const result = await writer.persist(run, {
      phase: "result",
      toolCallId: "delimiter-call",
      state: "success",
      content: { cases: cases.map(({ raw }) => raw) },
    });
    await writer.close();

    const reader = new ToolHistoryReader(root);
    const search = reader.search({ logicalConversationId: "slack:C1", currentConversationId: "slack:C1#2026-08-14", currentRunId: "current" });
    const fetched = [invocation.recordId!, result.recordId!].map((recordId) => reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      recordId,
      chunkBytes: 8 * 1024,
    }));
    const projection = buildToolHistoryProjection(reader, "slack:C1", "slack:C1#2026-08-14", "current");
    const visible = JSON.stringify({ search, fetched, projection });
    for (const entry of cases) {
      expect(visible, entry.raw).toContain(entry.expected);
      for (const path of entry.paths) expect(visible, path).not.toContain(path);
    }

    const databaseBytes = await readFile(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    for (const path of cases.flatMap(({ paths }) => paths)) {
      expect(databaseBytes.includes(Buffer.from(path)), path).toBe(false);
    }
    for (const value of cases.filter(({ paths }) => paths.length === 0).map(({ raw }) => raw)) {
      expect(databaseBytes.includes(Buffer.from(value)), value).toBe(true);
    }
  });

  it("neutralizes private artifact paths in search, get chunks, and the cold projection while excluding the current run", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const leakedPath = "/Users/example/.mono-agent/artifacts/tool-output/old-run/bash.txt";
    for (const [runId, label] of [["old-run", "retained"], ["current-run", "current-only"]] as const) {
      const run = binding(runId);
      await writer.persist(run, {
        phase: "invocation",
        toolCallId: `${runId}-call`,
        toolName: "Bash",
        arguments: { command: `read ${leakedPath}`, label },
      });
      await writer.persist(run, {
        phase: "result",
        toolCallId: `${runId}-call`,
        state: "success",
        content: `output\nFull output saved to: ${leakedPath}`,
      });
    }
    await writer.close();

    const reader = new ToolHistoryReader(root);
    const page = reader.search({ logicalConversationId: "slack:C1", currentConversationId: "slack:C1#2026-08-14", currentRunId: "current-run" });
    expect(page.items.map((item) => item.runId)).toEqual(["old-run"]);
    expect(JSON.stringify(page)).not.toContain(leakedPath);
    const fetched = reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current-run",
      toolCallId: "old-run-call",
    });
    expect(JSON.stringify(fetched)).not.toContain(leakedPath);
    expect(fetched.chunk).toContain("output");
    expect(fetched.chunk).toContain("[private-path]");
    const projection = buildToolHistoryProjection(reader, "slack:C1", "slack:C1#2026-08-14", "current-run");
    expect(projection?.recordCount).toBe(1);
    expect(projection?.text).not.toContain(leakedPath);
    expect(projection?.text).not.toContain("current-only");
    expect(projection?.text).toContain("output");
    expect(projection?.text).toContain("[private-path]");
  });

  it("excludes only the exact physical current run when daily buckets reuse a run id", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const reusedRunId = "reused-run-id";
    const oldRun = binding(reusedRunId, "slack:C1#2026-08-13");
    const currentRun = binding(reusedRunId, "slack:C1#2026-08-14");
    const oldInvocation = await writer.persist(oldRun, {
      phase: "invocation",
      toolCallId: "old-bucket-call",
      toolName: "Read",
      arguments: { marker: "older-completed-call" },
    });
    await writer.persist(oldRun, {
      phase: "result",
      toolCallId: "old-bucket-call",
      state: "success",
      content: "old bucket result",
    });
    const currentInvocation = await writer.persist(currentRun, {
      phase: "invocation",
      toolCallId: "current-bucket-call",
      toolName: "Read",
      arguments: { marker: "current-call-must-stay-hidden" },
    });
    await writer.persist(currentRun, {
      phase: "result",
      toolCallId: "current-bucket-call",
      state: "success",
      content: "current bucket result",
    });
    await writer.close();

    const reader = new ToolHistoryReader(root);
    const scope = {
      logicalConversationId: "slack:C1",
      currentConversationId: currentRun.conversationId,
      currentRunId: reusedRunId,
    } as const;
    expect(reader.search(scope).items).toMatchObject([{
      conversationId: oldRun.conversationId,
      runId: reusedRunId,
      toolCallId: "old-bucket-call",
    }]);
    expect(reader.get({ ...scope, recordId: oldInvocation.recordId! }).record).toMatchObject({
      conversationId: oldRun.conversationId,
      payload: { marker: "older-completed-call" },
    });
    expect(reader.get({ ...scope, recordId: currentInvocation.recordId! })).toEqual({ untrusted: true });
    const projected = reader.latestProjection(
      scope.logicalConversationId,
      scope.currentConversationId,
      scope.currentRunId,
    );
    expect(projected.map(({ call }) => call.toolCallId)).toEqual(["old-bucket-call"]);
  });

  it("uses one read-only SQLite open for a full cold projection", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    for (let index = 0; index < 12; index += 1) {
      const run = binding(`projection-${String(index)}`);
      await writer.persist(run, {
        phase: "invocation", toolCallId: `call-${String(index)}`, toolName: "Read", arguments: { index },
      });
      await writer.persist(run, {
        phase: "result", toolCallId: `call-${String(index)}`, state: "success", content: index,
      });
    }
    await writer.close();

    const close = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      expect(new ToolHistoryReader(root).latestProjection("slack:C1", "slack:C1#2026-08-14", "current", 12)).toHaveLength(12);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it("reassembles complete bounded invocation and result JSON for the cold projection", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("projection-complete-json");
    await writer.persist(run, {
      phase: "invocation",
      toolCallId: "large-projection-call",
      toolName: "Read",
      arguments: { body: "a".repeat(3_000), tail: "invocation-tail" },
    });
    await writer.persist(run, {
      phase: "result",
      toolCallId: "large-projection-call",
      state: "success",
      content: { body: "b".repeat(6_000), tail: "result-tail" },
    });
    await writer.close();

    const reader = new ToolHistoryReader(root);
    const [projected] = reader.latestProjection("slack:C1", "slack:C1#2026-08-15", "current-run");
    expect(projected?.invocation.nextOffset).toBeUndefined();
    expect(projected?.result?.nextOffset).toBeUndefined();
    expect(JSON.parse(projected?.invocation.chunk ?? "null")).toMatchObject({ tail: "invocation-tail" });
    expect(JSON.parse(projected?.result?.chunk ?? "null")).toMatchObject({ tail: "result-tail" });
    const projection = buildToolHistoryProjection(reader, "slack:C1", "slack:C1#2026-08-15", "current-run");
    expect(projection?.text).toContain("invocation-tail");
    expect(projection?.text).toContain("result-tail");
  });

  it("does not automatically re-inject the result of an explicit SessionHistory read", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("projection-session-history");
    await writer.persist(run, {
      phase: "invocation",
      toolCallId: "history-call",
      toolName: "SessionHistory",
      arguments: { action: "get", recordId: "retained-record" },
    });
    await writer.persist(run, {
      phase: "result",
      toolCallId: "history-call",
      state: "success",
      content: { untrusted: true, chunk: "nested-history-body-must-not-replay" },
    });
    await writer.close();

    const projection = buildToolHistoryProjection(
      new ToolHistoryReader(root),
      "slack:C1",
      "slack:C1#2026-08-15",
      "current-run",
    );
    expect(projection?.text).toContain("SessionHistory");
    expect(projection?.text).toContain("[nested SessionHistory result omitted; inspect the referenced record directly]");
    expect(projection?.text).not.toContain("nested-history-body-must-not-replay");
  });

  it("retains the newest fitting projection suffix in chronological order within the UTF-8 byte ceiling", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const payload = "&😀\"".repeat(1_500);
    for (let index = 0; index < 32; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const run = binding(`projection-bounded-${suffix}`);
      await writer.persist(run, {
        phase: "invocation",
        toolCallId: `call-${suffix}`,
        toolName: "Read",
        arguments: { label: `record-${suffix}`, payload },
      });
      await writer.persist(run, {
        phase: "result",
        toolCallId: `call-${suffix}`,
        state: "success",
        content: { label: `record-${suffix}`, payload },
      });
    }
    await writer.close();

    const projection = buildToolHistoryProjection(
      new ToolHistoryReader(root),
      "slack:C1",
      "slack:C1#2026-08-15",
      "current-run",
    );
    expect(projection).toBeDefined();
    expect(Buffer.byteLength(projection!.text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(projection!.text).toContain('<projection_truncated reason="byte_limit" />');
    expect(projection!.recordCount).toBeGreaterThan(0);
    expect(projection!.recordCount).toBeLessThan(32);
    const retainedRuns = [...projection!.text.matchAll(/run="projection-bounded-(\d{2})"/gu)]
      .map((match) => Number(match[1]));
    expect(retainedRuns).toEqual(
      Array.from({ length: projection!.recordCount }, (_, offset) => 32 - projection!.recordCount + offset),
    );
    expect(projection!.text).toContain('run="projection-bounded-31"');
    expect(projection!.text).not.toContain('run="projection-bounded-00"');
  }, 20_000);

  it("resets the logical rollover session across search, get, and cold projection without harming isolation", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    try {
      await writer.persist(binding("run-old", "slack:C1#2026-08-13"), {
        phase: "result",
        toolCallId: "orphan",
        toolName: "Read",
        state: "error",
        failureKind: "runtime_error",
        content: "provider omitted start",
      });
      await writer.persist(binding("run-new", "slack:C1#2026-08-14"), {
        phase: "invocation", toolCallId: "kept", toolName: "Read", arguments: { path: "kept" },
      });
      await writer.persist(binding("run-new", "slack:C1#2026-08-14"), {
        phase: "result", toolCallId: "kept", state: "success", content: "kept",
      });
      await writer.persist({
        ...binding("foreign-run", "slack:C2#2026-08-14"),
        logicalConversationId: "slack:C2",
      }, {
        phase: "invocation", toolCallId: "foreign", toolName: "Read", arguments: {},
      });
      await writer.persist({
        ...binding("foreign-run", "slack:C2#2026-08-14"),
        logicalConversationId: "slack:C2",
      }, {
        phase: "result", toolCallId: "foreign", state: "success", content: "foreign",
      });

      const reader = new ToolHistoryReader(root);
      const before = reader.search({ logicalConversationId: "slack:C1", currentConversationId: "slack:C1#2026-08-14", currentRunId: "run-current" });
      expect(before.items.map((item) => item.toolCallId).sort()).toEqual(["kept", "orphan"]);
      expect(reader.latestProjection("slack:C1", "slack:C1#2026-08-14", "run-current")).toHaveLength(2);
      const recordIds = before.items.flatMap((item) => [item.recordId, item.resultRecordId].filter(
        (recordId): recordId is string => recordId !== undefined,
      ));

      await writer.resetConversation("slack:C1");
      expect(reader.search({ logicalConversationId: "slack:C1", currentConversationId: "slack:C1#2026-08-14", currentRunId: "run-current" }).items)
        .toEqual([]);
      expect(reader.latestProjection("slack:C1", "slack:C1#2026-08-14", "run-current")).toEqual([]);
      for (const recordId of recordIds) {
        expect(reader.get({
          logicalConversationId: "slack:C1",
          currentConversationId: "slack:C1#2026-08-14",
          currentRunId: "run-current",
          recordId,
        })).toEqual({ untrusted: true });
      }
    } finally {
      await writer.close();
    }

    const reader = new ToolHistoryReader(root);
    expect(reader.search({ logicalConversationId: "slack:C1", currentConversationId: "slack:C1#2026-08-14", currentRunId: "run-current" }).items)
      .toEqual([]);
    expect(reader.search({ logicalConversationId: "slack:C2", currentConversationId: "slack:C2#2026-08-14", currentRunId: "run-current" }).items)
      .toMatchObject([{ toolCallId: "foreign" }]);
    expect(reader.stats()).toMatchObject({ calls: 1, records: 2 });
  });

  it("upgrades and uses the tombstone child-key index while resetting high-cardinality history within the maintenance deadline", async () => {
    const root = await tempRoot();
    const targetRuns = 400;
    const callsPerRun = 10;
    const foreignTombstones = 1_000;
    const initialized = await ToolHistoryWriter.open({ root });
    await initialized.close();
    const existing = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    try {
      expect(indexColumns(existing, "tombstones_run_idx")).toEqual(["conversation_id", "run_id"]);
      existing.exec("DROP INDEX tombstones_run_idx");
      expect(indexColumns(existing, "tombstones_run_idx")).toEqual([]);
    } finally {
      existing.close();
    }
    seedResetScaleHistory(root, targetRuns, callsPerRun, foreignTombstones);

    const writer = await ToolHistoryWriter.open({ root, persistenceCeilingMs: 1 });
    try {
      const upgraded = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE), { readOnly: true });
      try {
        expect(indexColumns(upgraded, "tombstones_run_idx")).toEqual(["conversation_id", "run_id"]);
        upgraded.exec("PRAGMA foreign_keys=ON");
        expect(queryPlanDetails(upgraded, "DELETE FROM runs WHERE logical_id=?", "slack:C1"))
          .toEqual(expect.arrayContaining([
            expect.stringMatching(/^SEARCH tombstones USING COVERING INDEX tombstones_run_idx /u),
          ]));
      } finally {
        upgraded.close();
      }
      await expect(writer.stats()).resolves.toMatchObject({
        calls: targetRuns * callsPerRun,
        records: 0,
        tombstones: foreignTombstones,
      });
      await expect(writer.resetConversation("slack:C1")).resolves.toBeUndefined();
      await expect(writer.stats()).resolves.toMatchObject({
        calls: 0,
        records: 0,
        tombstones: foreignTombstones,
      });
      await expect(writer.resetConversation("")).rejects.toMatchObject({ code: "history_write_failed" });
    } finally {
      await writer.close();
    }

    const preserved = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE), { readOnly: true });
    try {
      expect(preserved.prepare("SELECT count(*) count FROM runs WHERE logical_id='slack:C1'").get())
        .toMatchObject({ count: 0 });
      expect(preserved.prepare("SELECT count(*) count FROM runs WHERE logical_id='slack:C2'").get())
        .toMatchObject({ count: 1 });
      expect(preserved.prepare("SELECT count(*) count FROM tombstones WHERE conversation_id='slack:C2#2026-08-14'").get())
        .toMatchObject({ count: foreignTombstones });
    } finally {
      preserved.close();
    }
  }, 30_000);

  it("rejects an initial result whose tool name conflicts with the stable invocation", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("stable-tool-name");
    await writer.persist(run, {
      phase: "invocation", toolCallId: "same-call", toolName: "Read", arguments: { path: "README.md" },
    });
    expect(await writer.persist(run, {
      phase: "result", toolCallId: "same-call", toolName: "Bash", state: "success", content: "spoofed",
    })).toEqual({ persistence: "failed", errorCode: "history_idempotency_conflict" });
    await expect(writer.stats()).resolves.toMatchObject({ idempotencyConflicts: 1 });
    expect(await writer.persist(run, {
      phase: "result", toolCallId: "same-call", toolName: "Read", state: "success", content: "ok",
    })).toMatchObject({ persistence: "persisted", sequence: 2 });
    await writer.close();

    expect(new ToolHistoryReader(root).search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
    }).items).toMatchObject([{ toolName: "Read", state: "success" }]);
    expect(new ToolHistoryReader(root).stats()).toMatchObject({ idempotencyConflicts: 0 });
  });

  it("durably deduplicates a changed run binding until the canonical binding succeeds", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const canonical = binding("stable-binding");
    const changed = { ...canonical, logicalConversationId: "slack:C2" };
    try {
      await expect(writer.persist(canonical, {
        phase: "invocation", toolCallId: "bound-call", toolName: "Read", arguments: {},
      })).resolves.toMatchObject({ persistence: "persisted" });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(writer.persist(changed, {
          phase: "result", toolCallId: "bound-call", state: "success", content: "changed binding",
        })).resolves.toEqual({ persistence: "failed", errorCode: "history_idempotency_conflict" });
      }
      await expect(writer.stats()).resolves.toMatchObject({ idempotencyConflicts: 1, writeFailures: 0 });

      const unrelated = binding("unrelated-binding");
      await writer.persist(unrelated, {
        phase: "invocation", toolCallId: "unrelated-call", toolName: "Read", arguments: {},
      });
      await expect(writer.stats()).resolves.toMatchObject({ idempotencyConflicts: 1 });

      await expect(writer.persist(canonical, {
        phase: "result", toolCallId: "bound-call", state: "success", content: "canonical binding",
      })).resolves.toMatchObject({ persistence: "persisted" });
      await expect(writer.stats()).resolves.toMatchObject({ idempotencyConflicts: 0 });
    } finally {
      await writer.close();
    }
  });

  it("clears only reset identities from unresolved conflict and write incidents", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const resetRun = binding("reset-incidents");
    const liveRun: ToolHistoryRunBinding = {
      conversationId: "slack:C2#2026-08-14",
      logicalConversationId: "slack:C2",
      runId: "live-incidents",
      isolated: false,
    };
    const createIncidents = async (run: ToolHistoryRunBinding, toolCallId: string): Promise<void> => {
      await writer.persist(run, {
        phase: "invocation", toolCallId, toolName: "Read", arguments: { path: "README.md" },
      });
      await expect(writer.persist(run, {
        phase: "invocation", toolCallId, toolName: "Bash", arguments: {},
      })).resolves.toEqual({ persistence: "failed", errorCode: "history_idempotency_conflict" });
      await expect(writer.persist(run, {
        phase: "result", toolCallId, state: "success", executionMs: -1, content: "invalid duration",
      })).resolves.toEqual({ persistence: "failed", errorCode: "history_write_failed" });
    };
    try {
      await createIncidents(resetRun, "reset-call");
      await createIncidents(liveRun, "live-call");
      await expect(writer.stats()).resolves.toMatchObject({
        calls: 2,
        records: 2,
        writeFailures: 2,
        idempotencyConflicts: 2,
      });

      await writer.resetConversation(resetRun.logicalConversationId);
      await expect(writer.stats()).resolves.toMatchObject({
        calls: 1,
        records: 1,
        writeFailures: 1,
        idempotencyConflicts: 1,
      });

      await writer.resetConversation(liveRun.logicalConversationId);
      await expect(writer.stats()).resolves.toMatchObject({
        calls: 0,
        records: 0,
        writeFailures: 0,
        idempotencyConflicts: 0,
      });
    } finally {
      await writer.close();
    }
  });

  it("clears a pruned call conflict without hiding an unrelated live conflict", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({
      root,
      retention: {
        maxCompletedCalls: 1,
        maxBytes: 1024 * 1024,
        maxTombstones: 0,
      },
    });
    const victim = binding("pruned-incident");
    const live = binding("live-incident");
    const trigger = binding("retention-trigger");
    try {
      await writer.persist(victim, {
        phase: "invocation", toolCallId: "victim-call", toolName: "Read", arguments: {},
      });
      await writer.persist(victim, {
        phase: "result", toolCallId: "victim-call", state: "success", content: "victim",
      });
      await expect(writer.persist(victim, {
        phase: "invocation", toolCallId: "victim-call", toolName: "Bash", arguments: {},
      })).resolves.toEqual({ persistence: "failed", errorCode: "history_idempotency_conflict" });

      await writer.persist(live, {
        phase: "invocation", toolCallId: "live-call", toolName: "Read", arguments: {},
      });
      await expect(writer.persist(live, {
        phase: "invocation", toolCallId: "live-call", toolName: "Bash", arguments: {},
      })).resolves.toEqual({ persistence: "failed", errorCode: "history_idempotency_conflict" });
      await expect(writer.stats()).resolves.toMatchObject({ idempotencyConflicts: 2 });

      await writer.persist(trigger, {
        phase: "invocation", toolCallId: "trigger-call", toolName: "Read", arguments: {},
      });
      await writer.persist(trigger, {
        phase: "result", toolCallId: "trigger-call", state: "success", content: "trigger",
      });
      await expect(writer.stats()).resolves.toMatchObject({
        calls: 2,
        tombstones: 0,
        idempotencyConflicts: 1,
      });

      await writer.persist(live, {
        phase: "invocation", toolCallId: "live-call", toolName: "Read", arguments: {},
      });
      await expect(writer.stats()).resolves.toMatchObject({ idempotencyConflicts: 0 });
    } finally {
      await writer.close();
    }
  });

  it("keeps phase-scoped write incidents visible until each missing phase is recovered", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("lost-phases");
    try {
      await expect(writer.persist(run, {
        phase: "invocation", toolCallId: "lost-invocation", toolName: "", arguments: {},
      })).resolves.toEqual({ persistence: "failed", errorCode: "history_write_failed" });
      await expect(writer.persist(run, {
        phase: "result", toolCallId: "lost-result", state: "success", executionMs: -1, content: "invalid duration",
      })).resolves.toEqual({ persistence: "failed", errorCode: "history_write_failed" });
      await expect(writer.stats()).resolves.toMatchObject({ calls: 0, records: 0, writeFailures: 2 });

      await writer.finishRun(run, "succeeded");
      await writer.persist(binding("unrelated-success"), {
        phase: "invocation", toolCallId: "unrelated", toolName: "Read", arguments: {},
      });
      await writer.persist(binding("unrelated-success"), {
        phase: "result", toolCallId: "unrelated", state: "success", content: "ok",
      });
      await expect(writer.stats()).resolves.toMatchObject({ writeFailures: 2 });

      await writer.persist(run, {
        phase: "invocation", toolCallId: "lost-invocation", toolName: "Read", arguments: {},
      });
      await expect(writer.stats()).resolves.toMatchObject({ writeFailures: 1 });
      await writer.persist(run, {
        phase: "result", toolCallId: "lost-result", state: "success", executionMs: 1, content: "recovered",
      });
      await expect(writer.stats()).resolves.toMatchObject({ writeFailures: 0 });
    } finally {
      await writer.close();
    }
  });

  it("resolves only the result incident durably closed by finalization and upgrades that synthetic result in place", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const recoveredRun = binding("finalized-result-recovery");
    const unrelatedRun = binding("unrelated-result-recovery");
    const invalidResult = (toolCallId: string) => ({
      phase: "result" as const,
      toolCallId,
      state: "success" as const,
      executionMs: -1,
      content: "invalid duration",
    });
    const recoveredEvent = {
      phase: "result" as const,
      toolCallId: "recovered-call",
      state: "success" as const,
      executionMs: 12,
      content: { answer: "late durable result" },
    };
    try {
      await writer.persist(recoveredRun, {
        phase: "invocation", toolCallId: "recovered-call", toolName: "Read", arguments: {},
      });
      await writer.persist(unrelatedRun, {
        phase: "invocation", toolCallId: "unrelated-call", toolName: "Read", arguments: {},
      });
      await expect(writer.persist(recoveredRun, invalidResult("recovered-call")))
        .resolves.toEqual({ persistence: "failed", errorCode: "history_write_failed" });
      await expect(writer.persist(unrelatedRun, invalidResult("unrelated-call")))
        .resolves.toEqual({ persistence: "failed", errorCode: "history_write_failed" });
      await expect(writer.stats()).resolves.toMatchObject({
        calls: 2,
        records: 2,
        dangling: 2,
        writeFailures: 2,
        idempotencyConflicts: 0,
      });

      await writer.finishRun(recoveredRun, "succeeded");
      await expect(writer.stats()).resolves.toMatchObject({
        calls: 2,
        records: 3,
        dangling: 1,
        writeFailures: 1,
        idempotencyConflicts: 0,
      });
      expect(new ToolHistoryReader(root).search({
        logicalConversationId: "slack:C1",
        currentConversationId: "slack:C1#2026-08-14",
        currentRunId: "current",
        runIds: [recoveredRun.runId],
      }).items).toMatchObject([{
        toolCallId: "recovered-call",
        state: "interrupted",
        recovered: false,
      }]);

      const upgraded = await writer.persist(recoveredRun, recoveredEvent);
      expect(upgraded).toMatchObject({ persistence: "persisted", sequence: 2 });
      await expect(writer.persist(recoveredRun, recoveredEvent)).resolves.toMatchObject({
        persistence: "persisted",
        recordId: upgraded.recordId,
        sequence: 2,
      });
      await expect(writer.stats()).resolves.toMatchObject({
        records: 3,
        dangling: 1,
        writeFailures: 1,
        idempotencyConflicts: 0,
      });

      await expect(writer.persist(unrelatedRun, {
        phase: "result",
        toolCallId: "unrelated-call",
        state: "success",
        executionMs: 1,
        content: "unrelated recovered",
      })).resolves.toMatchObject({ persistence: "persisted" });
      await expect(writer.stats()).resolves.toMatchObject({
        records: 4,
        dangling: 0,
        writeFailures: 0,
        idempotencyConflicts: 0,
      });
    } finally {
      await writer.close();
    }

    const reader = new ToolHistoryReader(root);
    expect(reader.search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      runIds: [recoveredRun.runId],
    }).items).toMatchObject([{
      toolCallId: "recovered-call",
      state: "success",
      recovered: false,
      resultRecordId: expect.any(String),
    }]);
    expect(reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      recordId: toolHistoryRecordId(
        recoveredRun.conversationId,
        recoveredRun.runId,
        "recovered-call",
        "result",
      ),
    }).record).toMatchObject({
      state: "success",
      executionMs: 12,
      payload: { answer: "late durable result" },
      recovered: false,
    });
  });

  it("excludes isolated/proactive runs by default and includes them only when explicitly requested", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    try {
      for (const [runId, isolated] of [["normal", false], ["proactive", true]] as const) {
        await writer.persist(binding(runId, "slack:C1#2026-08-14", isolated), {
          phase: "invocation", toolCallId: runId, toolName: "Read", arguments: { runId },
        });
        await writer.persist(binding(runId, "slack:C1#2026-08-14", isolated), {
          phase: "result", toolCallId: runId, state: "success", content: runId,
        });
      }
    } finally {
      await writer.close();
    }
    const reader = new ToolHistoryReader(root);
    expect(reader.search({ logicalConversationId: "slack:C1", currentConversationId: "slack:C1#2026-08-14", currentRunId: "current" }).items.map((item) => item.runId))
      .toEqual(["normal"]);
    expect(reader.search({ logicalConversationId: "slack:C1", currentConversationId: "slack:C1#2026-08-14", currentRunId: "current", includeIsolated: true }).items.map((item) => item.runId).sort())
      .toEqual(["normal", "proactive"]);
  });

  it("enforces count, retained-byte, and tombstone bounds without claiming physical SQLite bytes are payload quota", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({
      root,
      retention: { maxCompletedCalls: 1, maxBytes: 700, maxTombstones: 4 },
    });
    const firstId: string[] = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        const run = binding(`retention-${String(index)}`);
        const invocation = await writer.persist(run, {
          phase: "invocation", toolCallId: `call-${String(index)}`, toolName: "Read", arguments: { text: "a".repeat(150) },
        });
        if (index === 0 && invocation.recordId !== undefined) firstId.push(invocation.recordId);
        await writer.persist(run, {
          phase: "result", toolCallId: `call-${String(index)}`, state: "success", content: "b".repeat(150),
        });
      }
    } finally {
      await writer.close();
    }
    const reader = new ToolHistoryReader(root);
    const stats = reader.stats();
    expect(stats?.calls).toBe(1);
    expect(stats?.retainedBytes).toBeLessThanOrEqual(700);
    expect(stats?.tombstones).toBeLessThanOrEqual(4);
    expect(stats?.bytes).toBeGreaterThan(stats?.retainedBytes ?? 0);
    expect(reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      recordId: firstId[0]!,
    })).toMatchObject({ tombstone: { reason: expect.stringMatching(/count|bytes/u) }, untrusted: true });
    expect(reader.get({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
      toolCallId: "call-0",
    })).toMatchObject({ tombstone: { reason: expect.stringMatching(/count|bytes/u) }, untrusted: true });

    const replayWriter = await ToolHistoryWriter.open({
      root,
      retention: { maxCompletedCalls: 1, maxBytes: 700, maxTombstones: 4 },
    });
    expect(await replayWriter.persist(binding("retention-0"), {
      phase: "invocation", toolCallId: "call-0", toolName: "Read", arguments: { text: "a".repeat(150) },
    })).toEqual({ persistence: "failed", errorCode: "history_record_tombstoned" });
    expect(await replayWriter.persist(binding("retention-0"), {
      phase: "result", toolCallId: "call-0", state: "success", content: "b".repeat(150),
    })).toEqual({ persistence: "failed", errorCode: "history_record_tombstoned" });
    await replayWriter.close();

    const cleanupWriter = await ToolHistoryWriter.open({
      root,
      retention: { maxCompletedCalls: 1, maxBytes: 700, maxTombstones: 0 },
    });
    await cleanupWriter.close();
    const raw = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE), { readOnly: true });
    try {
      expect(raw.prepare("SELECT count(*) AS count FROM runs").get()).toMatchObject({ count: 1 });
      expect(raw.prepare("SELECT count(*) AS count FROM tombstones").get()).toMatchObject({ count: 0 });
    } finally {
      raw.close();
    }
  });

  it("shares one process writer idempotently until the final handle releases it", async () => {
    const root = await tempRoot();
    const first = await acquireToolHistoryWriter({ root });
    const second = await acquireToolHistoryWriter({ root });
    expect(first.writer).toBe(second.writer);
    await first.release();
    await expect(second.writer.stats()).resolves.toMatchObject({ calls: 0 });
    await second.release();
    await expect(second.writer.stats()).rejects.toMatchObject({ code: "history_writer_closed" });
  });

  it("replaces a dead process-registry writer before older references drain", async () => {
    const root = await tempRoot();
    const first = await acquireToolHistoryWriter({ root });
    const second = await acquireToolHistoryWriter({ root });
    const deadWriter = first.writer;
    await deadWriter.close();

    const recovered = await acquireToolHistoryWriter({ root });
    try {
      expect(recovered.writer).not.toBe(deadWriter);
      await expect(recovered.writer.stats()).resolves.toMatchObject({ calls: 0, records: 0 });
    } finally {
      await first.release();
      await second.release();
      await recovered.release();
    }
  });

  it.skipIf(process.platform === "win32")("shares a writer when configured history paths differ only through a symlinked parent", async () => {
    const base = await mkdtemp(join(tmpdir(), "tool-history-realpath-"));
    tempDirs.push(base);
    const realParent = join(base, "real-parent");
    const aliasParent = join(base, "alias-parent");
    await mkdir(realParent, { recursive: true });
    await symlink(realParent, aliasParent, "dir");
    const first = await acquireToolHistoryWriter({ root: join(realParent, "history") });
    const second = await acquireToolHistoryWriter({ root: join(aliasParent, "history") });
    expect(second.writer).toBe(first.writer);
    await first.release();
    await second.release();
  });

  it("fails source-mode worker tests closed when compiled output is missing or stale", async () => {
    const root = await tempRoot();
    const source = join(root, "worker.ts");
    const dist = join(root, "worker.js");
    await mkdir(root, { recursive: true });
    await writeFile(source, "source");
    expect(() => assertToolHistoryWorkerBuildFresh(source, dist)).toThrow(/output is missing/iu);
    await writeFile(dist, "compiled");
    const now = Date.now() / 1_000;
    await utimes(dist, now - 10, now - 10);
    await utimes(source, now, now);
    expect(() => assertToolHistoryWorkerBuildFresh(source, dist)).toThrow(/predates its source/iu);
    await utimes(dist, now + 10, now + 10);
    expect(() => assertToolHistoryWorkerBuildFresh(source, dist)).not.toThrow();
  });

  it("does not revive a process writer whose last release overlaps a pending acquire", async () => {
    const root = await tempRoot();
    const first = await acquireToolHistoryWriter({ root });
    const pending = acquireToolHistoryWriter({ root });
    await first.release();
    const replacement = await pending;
    await expect(replacement.writer.stats()).resolves.toMatchObject({ calls: 0 });
    await replacement.release();
  });

  it("serializes parallel starts deterministically and paginates across runs whose per-run sequences overlap", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    try {
      for (const runId of ["run-a", "run-b", "run-c"]) {
        const run = binding(runId);
        const starts = await Promise.all([
          writer.persist(run, { phase: "invocation", toolCallId: `${runId}-one`, toolName: "Read", arguments: { order: 1 } }),
          writer.persist(run, { phase: "invocation", toolCallId: `${runId}-two`, toolName: "Read", arguments: { order: 2 } }),
        ]);
        expect(starts.map((entry) => entry.sequence)).toEqual([1, 2]);
        const ends = await Promise.all([
          writer.persist(run, { phase: "result", toolCallId: `${runId}-two`, state: "success", content: 2 }),
          writer.persist(run, { phase: "result", toolCallId: `${runId}-one`, state: "success", content: 1 }),
        ]);
        expect(ends.map((entry) => entry.sequence)).toEqual([3, 4]);
      }
    } finally {
      await writer.close();
    }

    const reader = new ToolHistoryReader(root);
    const seen: string[] = [];
    let before: NonNullable<ReturnType<ToolHistoryReader["search"]>["next"]> | undefined;
    do {
      const page = reader.search({
        logicalConversationId: "slack:C1",
        currentConversationId: "slack:C1#2026-08-14",
        currentRunId: "current",
        limit: 1,
        ...(before === undefined ? {} : { before }),
      });
      seen.push(...page.items.map((item) => item.toolCallId));
      before = page.next;
    } while (before !== undefined);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("paginates exact run/sequence/call collisions across physical rollover buckets", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    for (const conversationId of ["slack:C1#2026-08-13", "slack:C1#2026-08-14"]) {
      const run = binding("same-run", conversationId);
      await writer.persist(run, {
        phase: "invocation", toolCallId: "same-call", toolName: "Read", arguments: { conversationId },
      });
      await writer.persist(run, {
        phase: "result", toolCallId: "same-call", state: "success", content: conversationId,
      });
    }
    await writer.close();
    const raw = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    raw.prepare("UPDATE runs SET started_at_ms=? WHERE run_id=?").run(123, "same-run");
    raw.close();

    const reader = new ToolHistoryReader(root);
    const seen: string[] = [];
    let before: NonNullable<ReturnType<ToolHistoryReader["search"]>["next"]> | undefined;
    do {
      const page = reader.search({
        logicalConversationId: "slack:C1",
        currentConversationId: "slack:C1#2026-08-14",
        currentRunId: "current",
        limit: 1,
        ...(before === undefined ? {} : { before }),
      });
      seen.push(...page.items.map((item) => item.recordId));
      before = page.next;
    } while (before !== undefined);
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
  });
});

describe("tool-history ownership, recovery, and scanner coexistence", () => {
  it("keeps the approved 10-second ownership and 250 ms host-wait defaults explicit", () => {
    expect(TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS).toBe(10_000);
    expect(TOOL_HISTORY_PERSISTENCE_CEILING_MS).toBe(250);
  });

  it.skipIf(process.platform === "win32")("fails closed when a read-only consumer sees insecure sidecar modes", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    await writer.close();
    await chmod(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE), 0o644);
    expect(() => new ToolHistoryReader(root).search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "current",
    })).toThrow(/mode 0600/iu);
  });

  it("migrates reviewed v1 synthetic terminals and their matching incidents before a delayed real result", async () => {
    const root = await tempRoot();
    const run = binding("v1-synthetic-result");
    const resultId = toolHistoryRecordId(run.conversationId, run.runId, "v1-call", "result");
    const initialized = await ToolHistoryWriter.open({ root });
    await initialized.persist(run, {
      phase: "invocation", toolCallId: "v1-call", toolName: "Read", arguments: {},
    });
    await initialized.finishRun(run, "succeeded");
    await initialized.close();

    const path = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec("ALTER TABLE tool_calls DROP COLUMN synthetic_result");
      legacy.exec("PRAGMA user_version=1");
      legacy.prepare(`
        INSERT INTO writer_stats (key,value,last_detail,updated_at_ms) VALUES (?,1,'legacy incident',?)
      `).run(`write_failures:${resultId}`, Date.now());
    } finally {
      legacy.close();
    }

    const migrated = await ToolHistoryWriter.open({ root });
    try {
      await expect(migrated.stats()).resolves.toMatchObject({
        records: 2,
        dangling: 0,
        writeFailures: 0,
        idempotencyConflicts: 0,
      });
      await expect(migrated.persist(run, {
        phase: "result",
        toolCallId: "v1-call",
        state: "success",
        executionMs: 7,
        content: "late v1 result",
      })).resolves.toMatchObject({
        persistence: "persisted",
        recordId: resultId,
        sequence: 2,
      });
      await expect(migrated.stats()).resolves.toMatchObject({
        records: 2,
        writeFailures: 0,
        idempotencyConflicts: 0,
      });
    } finally {
      await migrated.close();
    }

    const schema = new DatabaseSync(path, { readOnly: true });
    try {
      expect(Number((schema.prepare("PRAGMA user_version").get() as { readonly user_version: number }).user_version))
        .toBe(TOOL_HISTORY_USER_VERSION);
      expect((schema.prepare("PRAGMA table_info(tool_calls)").all() as Array<{ readonly name: string }>)
        .map((column) => column.name)).toContain("synthetic_result");
    } finally {
      schema.close();
    }
    expect(new ToolHistoryReader(root).get({
      logicalConversationId: run.logicalConversationId,
      currentConversationId: run.conversationId,
      currentRunId: "current",
      recordId: resultId,
    }).record).toMatchObject({
      state: "success",
      executionMs: 7,
      payload: "late v1 result",
      recovered: false,
    });
  });

  it("scopes legacy bare-record incidents for reset and drops unattributable permanent markers", async () => {
    const root = await tempRoot();
    const run = binding("legacy-incident-scope");
    const initialized = await ToolHistoryWriter.open({ root });
    const invocation = await initialized.persist(run, {
      phase: "invocation",
      toolCallId: "legacy-call",
      toolName: "Read",
      arguments: {},
    });
    await initialized.close();
    expect(invocation.recordId).toEqual(expect.any(String));

    const path = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const legacy = new DatabaseSync(path);
    const insert = legacy.prepare(`
      INSERT INTO writer_stats (key,value,last_detail,updated_at_ms) VALUES (?,1,'legacy incident',?)
    `);
    try {
      insert.run(`write_failures:${invocation.recordId!}`, Date.now());
      insert.run(`idempotency_conflicts:${invocation.recordId!}`, Date.now());
      insert.run("write_failures:sth1_unattributable", Date.now());
    } finally {
      legacy.close();
    }

    const migrated = await ToolHistoryWriter.open({ root });
    try {
      await expect(migrated.stats()).resolves.toMatchObject({
        writeFailures: 1,
        idempotencyConflicts: 1,
      });
      await migrated.resetConversation(run.logicalConversationId);
      await expect(migrated.stats()).resolves.toMatchObject({
        calls: 0,
        records: 0,
        writeFailures: 0,
        idempotencyConflicts: 0,
      });
    } finally {
      await migrated.close();
    }

    const inspected = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspected.prepare(`
        SELECT key FROM writer_stats
        WHERE key GLOB 'write_failures:sth1_*'
           OR key GLOB 'idempotency_conflicts:sth1_*'
      `).all()).toEqual([]);
    } finally {
      inspected.close();
    }
  });

  it("describes a read-only older schema as upgrade-pending instead of a downgrade", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    await writer.close();
    const path = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version=${String(TOOL_HISTORY_USER_VERSION - 1)}`);
    database.close();

    expect(() => new ToolHistoryReader(root).stats()).toThrow(/upgrade-pending.*writer must upgrade/iu);
    expect(() => new ToolHistoryReader(root).stats()).not.toThrow(/downgrade/iu);
  });

  it("hard-fails newer and unmarked foreign schemas instead of attempting downgrade or adoption", async () => {
    const newerRoot = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root: newerRoot });
    await writer.close();
    const newerPath = join(newerRoot, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const newer = new DatabaseSync(newerPath);
    newer.exec(`PRAGMA user_version=${String(TOOL_HISTORY_USER_VERSION + 1)}`);
    newer.close();
    await expect(ToolHistoryWriter.open({ root: newerRoot, ownerAcquireCeilingMs: 500 }))
      .rejects.toMatchObject({ code: "history_schema_unsupported" });

    const foreignRoot = await tempRoot();
    await mkdir(join(foreignRoot, TOOL_HISTORY_DIRECTORY), { recursive: true, mode: 0o700 });
    await chmod(foreignRoot, 0o700);
    await chmod(join(foreignRoot, TOOL_HISTORY_DIRECTORY), 0o700);
    const foreignPath = join(foreignRoot, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const foreign = new DatabaseSync(foreignPath);
    foreign.exec("CREATE TABLE unrelated(value TEXT)");
    foreign.close();
    await chmod(foreignPath, 0o600);
    await expect(ToolHistoryWriter.open({ root: foreignRoot, ownerAcquireCeilingMs: 500 }))
      .rejects.toMatchObject({ code: "history_schema_unsupported" });
  });

  it("keeps a one-shot process alive until writer readiness settles, then permits clean exit", async () => {
    const root = await tempRoot();
    const result = await childResult(startChild(root, 2_000, "open-only"));

    expect(result.code, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain("SOURCE_ENTRY_LOADED");
    expect(result.stdout).toContain("STARTING");
    expect(result.stdout).toContain("ACQUIRED");
    expect(new ToolHistoryReader(root).stats()).toMatchObject({ calls: 0, records: 0 });
  }, 10_000);

  it("degrades logical-id and isolation finish binding conflicts independently until canonical retries resolve both incidents", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const logicalMismatchRun = binding("finish-logical-conflict");
    const isolationMismatchRun = binding("finish-isolation-conflict");
    for (const [run, toolCallId] of [
      [logicalMismatchRun, "dangling-logical-call"],
      [isolationMismatchRun, "dangling-isolation-call"],
    ] as const) {
      await writer.persist(run, {
        phase: "invocation", toolCallId, toolName: "Read", arguments: {},
      });
    }

    await expect(writer.finishRun({
      ...logicalMismatchRun,
      logicalConversationId: "slack:other",
    }, "failed")).resolves.toBeUndefined();
    await expect(writer.finishRun({
      ...isolationMismatchRun,
      isolated: true,
    }, "failed")).resolves.toBeUndefined();
    await expect(writer.stats()).resolves.toMatchObject({
      dangling: 2,
      idempotencyConflicts: 2,
      writeFailures: 2,
    });

    const database = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE), { readOnly: true });
    try {
      expect(database.prepare(`
        SELECT run_id,status,terminal_at_ms FROM runs
        WHERE run_id IN (?,?) ORDER BY run_id
      `).all(logicalMismatchRun.runId, isolationMismatchRun.runId)).toEqual([
        { run_id: "finish-isolation-conflict", status: "running", terminal_at_ms: null },
        { run_id: "finish-logical-conflict", status: "running", terminal_at_ms: null },
      ]);
    } finally {
      database.close();
    }

    await writer.finishRun(logicalMismatchRun, "failed");
    await expect(writer.stats()).resolves.toMatchObject({
      dangling: 1,
      idempotencyConflicts: 1,
      writeFailures: 1,
    });
    await writer.finishRun(isolationMismatchRun, "failed");
    await expect(writer.stats()).resolves.toMatchObject({
      dangling: 0,
      idempotencyConflicts: 0,
      writeFailures: 0,
    });
    await writer.close();
  });

  it("applies retention to calls finalized by finishRun and graceful close", async () => {
    const retention = { maxCompletedCalls: 0, maxBytes: 1024 * 1024, maxTombstones: 10 } as const;
    const finishRoot = await tempRoot();
    const finishWriter = await ToolHistoryWriter.open({ root: finishRoot, retention });
    const finishRun = binding("finish-retention");
    await finishWriter.persist(finishRun, {
      phase: "invocation", toolCallId: "finish-retained-call", toolName: "Read", arguments: {},
    });
    await finishWriter.finishRun(finishRun, "failed");
    await expect(finishWriter.stats()).resolves.toMatchObject({ calls: 0, records: 0, tombstones: 2 });
    await finishWriter.close();

    const closeRoot = await tempRoot();
    const closeWriter = await ToolHistoryWriter.open({ root: closeRoot, retention });
    await closeWriter.persist(binding("close-retention"), {
      phase: "invocation", toolCallId: "close-retained-call", toolName: "Read", arguments: {},
    });
    await closeWriter.close();
    expect(new ToolHistoryReader(closeRoot).stats()).toMatchObject({ calls: 0, records: 0, tombstones: 2 });
    const reopened = await ToolHistoryWriter.open({ root: closeRoot, retention });
    await expect(reopened.stats()).resolves.toMatchObject({ calls: 0, records: 0, tombstones: 2 });
    await reopened.close();
  });

  it("records close-retention maintenance failure while still closing and releasing ownership for reopen", async () => {
    const root = await tempRoot();
    const retention = { maxCompletedCalls: 0, maxBytes: 1024 * 1024, maxTombstones: 10 } as const;
    const writer = await ToolHistoryWriter.open({ root, retention });
    await writer.persist(binding("close-retention-failure"), {
      phase: "invocation",
      toolCallId: "close-retention-failure-call",
      toolName: "Read",
      arguments: { marker: "close-retention-failure-marker" },
    });
    const databasePath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const injected = new DatabaseSync(databasePath);
    try {
      injected.exec(`
        CREATE TRIGGER fail_close_retention BEFORE DELETE ON tool_calls
        BEGIN SELECT RAISE(FAIL, 'injected close retention failure'); END
      `);
    } finally {
      injected.close();
    }

    await expect(writer.close()).resolves.toBeUndefined();
    const reader = new ToolHistoryReader(root);
    expect(reader.stats()).toMatchObject({
      calls: 1,
      records: 2,
      dangling: 0,
      maintenanceFailures: 1,
    });
    expect(reader.search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-15",
      currentRunId: "current-run",
    }).items).toMatchObject([{
      toolCallId: "close-retention-failure-call",
      state: "interrupted",
    }]);
    const ownerPath = join(root, ".locks", TOOL_HISTORY_OWNER_DATABASE);
    const releasedOwner = new DatabaseSync(ownerPath, { readOnly: true });
    try {
      expect(releasedOwner.prepare("SELECT count(*) AS count FROM writer_owner").get()).toEqual({ count: 0 });
    } finally {
      releasedOwner.close();
    }

    const cleanupTrigger = new DatabaseSync(databasePath);
    try {
      cleanupTrigger.exec("DROP TRIGGER fail_close_retention");
    } finally {
      cleanupTrigger.close();
    }
    const reopened = await ToolHistoryWriter.open({ root, retention, ownerAcquireCeilingMs: 500 });
    await expect(reopened.stats()).resolves.toMatchObject({
      calls: 0,
      records: 0,
      tombstones: 2,
      maintenanceFailures: 0,
    });
    const reacquiredOwner = new DatabaseSync(ownerPath, { readOnly: true });
    try {
      expect(reacquiredOwner.prepare("SELECT count(*) AS count FROM writer_owner").get()).toEqual({ count: 1 });
    } finally {
      reacquiredOwner.close();
    }
    await reopened.close();
    const finallyReleasedOwner = new DatabaseSync(ownerPath, { readOnly: true });
    try {
      expect(finallyReleasedOwner.prepare("SELECT count(*) AS count FROM writer_owner").get()).toEqual({ count: 0 });
    } finally {
      finallyReleasedOwner.close();
    }
  });

  it("keeps persist, finishRun, and close referenced until graceful ownership release settles", async () => {
    const root = await tempRoot();
    const result = await childResult(startChild(root, 2_000, "settle"));

    expect(result.code, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain("PERSISTED");
    expect(result.stdout).toContain("FINISHED");
    expect(result.stdout).toContain("CLOSED");
    expect(result.stderr).toBe("");

    const owner = new DatabaseSync(join(root, ".locks", TOOL_HISTORY_OWNER_DATABASE), { readOnly: true });
    try {
      expect(owner.prepare("SELECT count(*) AS count FROM writer_owner").get()).toEqual({ count: 0 });
    } finally {
      owner.close();
    }
    const reader = new ToolHistoryReader(root);
    const graceful = reader.search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "after-graceful-close",
    }).items.find((item) => item.toolCallId === "graceful-close-call");
    expect(graceful).toMatchObject({ state: "interrupted", recovered: false });
    expect(reader.stats()).toMatchObject({ recovered: 0, dangling: 0 });

    const reopened = await ToolHistoryWriter.open({ root });
    await reopened.close();
    expect(reader.stats()).toMatchObject({ recovered: 0, dangling: 0 });
  }, 10_000);

  it("rejects a second live process deterministically after its bounded acquisition window", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    try {
      const result = await runChild(root, 350);
      expect(result.code, JSON.stringify(result)).toBe(23);
      expect(result.stdout).toContain("history_writer_in_use");
    } finally {
      await writer.close();
    }
  }, 10_000);

  it("keeps public open referenced until live-owner acquisition fails deterministically", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    try {
      // Force the worker handle itself to be unreferenced. The public open's
      // lifecycle reference must independently prevent Node's unsettled
      // top-level-await exit 13 through acquisition and failure cleanup.
      const result = await childResult(startChild(root, 75, "force-unref-open"));
      expect(result.code, JSON.stringify(result)).toBe(23);
      expect(result.stdout).toContain("history_writer_in_use");
      expect(result.stderr).not.toContain("unsettled top-level await");
    } finally {
      await writer.close();
    }
  }, 10_000);

  it("allows an overlapping normal restart to take ownership when the live writer releases inside the window", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const child = startChild(root, 2_000);
    await waitForOutput(child, "STARTING");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    await writer.close();
    const result = await childResult(child);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("ACQUIRED");
  }, 10_000);

  it.skipIf(process.platform === "win32")("keeps a live DELETE journal owner-only for doctor and concurrent acquisition", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const contentPath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const journalPath = `${contentPath}-journal`;
    const blocker = new DatabaseSync(contentPath);
    blocker.exec("PRAGMA busy_timeout=0; BEGIN");
    blocker.prepare("SELECT count(*) FROM metadata").get();
    const persistence = writer.persist(binding("live-journal-run"), {
      phase: "invocation",
      toolCallId: "live-journal-call",
      toolName: "Read",
      arguments: { path: "README.md" },
    });
    try {
      const journal = await waitForFile(journalPath);
      expect(journal.isFile()).toBe(true);
      expect(journal.isSymbolicLink()).toBe(false);
      expect(journal.nlink).toBe(1);
      expect(Number(journal.mode) & 0o777).toBe(0o600);

      const acquisition = ToolHistoryWriter.open({ root, ownerAcquireCeilingMs: 75 }).then(
        (unexpectedWriter) => ({ unexpectedWriter }),
        (error: unknown) => ({ error }),
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      expect((await lstat(journalPath)).mode & 0o777).toBe(0o600);
      blocker.exec("ROLLBACK");
      blocker.close();
      const acquisitionResult = await acquisition;
      if ("unexpectedWriter" in acquisitionResult) await acquisitionResult.unexpectedWriter.close();
      expect(acquisitionResult).toMatchObject({ error: { code: "history_writer_in_use" } });
      expect(acquisitionResult).not.toHaveProperty("unexpectedWriter");
    } finally {
      try { blocker.exec("ROLLBACK"); } catch { /* already released after live inspection */ }
      try { blocker.close(); } catch { /* already closed after live inspection */ }
    }
    await expect(persistence).resolves.toMatchObject({ persistence: "persisted" });
    await writer.close();
  }, 10_000);

  it.skipIf(process.platform === "win32")("reaps a dead owner and closes its dangling start as interrupted without rerun", async () => {
    const root = await tempRoot();
    const child = startChild(root, 2_000, "hold");
    await waitForOutput(child, "READY");
    child.kill("SIGKILL");
    await once(child, "exit");
    children.delete(child);

    const writer = await ToolHistoryWriter.open({ root, ownerAcquireCeilingMs: 1_000 });
    await writer.close();
    const page = new ToolHistoryReader(root).search({
      logicalConversationId: "slack:C1",
      currentConversationId: "slack:C1#2026-08-14",
      currentRunId: "after-restart",
    });
    expect(page.items).toMatchObject([{
      toolCallId: "crash-call",
      state: "interrupted",
      recovered: true,
    }]);
    expect(new ToolHistoryReader(root).stats()).toMatchObject({ recovered: 1, dangling: 0 });
  }, 10_000);

  it("keeps message append, retention, and stats green while the sidecar directory, owner DB, and DELETE journal coexist, and recognizes a late-committed timed-out write", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const contentPath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const journalPath = `${contentPath}-journal`;
    const blocker = new DatabaseSync(contentPath);
    blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    blocker.prepare("INSERT OR REPLACE INTO writer_stats(key,value,updated_at_ms) VALUES('test_blocker',0,?)").run(Date.now());
    await chmod(journalPath, 0o600);
    try {
      try {
        const messages = createDurableHistoryStore({ root, maxConversations: 1 });
        await messages.append("conversation-old", [{ role: "user", content: "old" }]);
        await messages.append("conversation-new", [{ role: "assistant", content: "new" }]);
        await expect(messages.load("conversation-new")).resolves.toEqual([{ role: "assistant", content: "new" }]);
        await expect(messages.stats()).resolves.toMatchObject({ conversations: 1 });

        const started = performance.now();
        const persisted = await writer.persist(binding("slow-run"), {
          phase: "invocation", toolCallId: "slow-call", toolName: "Read", arguments: {},
        });
        const elapsed = performance.now() - started;
        expect(persisted).toEqual({ persistence: "failed", errorCode: "history_persistence_timeout" });
        expect(elapsed).toBeGreaterThanOrEqual(200);
        expect(elapsed).toBeLessThan(750);
      } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      }

      await expect(writer.stats()).resolves.toMatchObject({ calls: 1, records: 1, writeFailures: 0 });
      await expect(writer.persist(binding("unrelated-write"), {
        phase: "invocation", toolCallId: "unrelated-call", toolName: "Read", arguments: {},
      })).resolves.toMatchObject({ persistence: "persisted" });
      await expect(writer.persist(binding("slow-run"), {
        phase: "invocation", toolCallId: "slow-call", toolName: "Read", arguments: {},
      })).resolves.toMatchObject({ persistence: "persisted", sequence: 1 });
      await expect(writer.stats()).resolves.toMatchObject({ writeFailures: 0 });
    } finally {
      await writer.close();
    }
    expect(new ToolHistoryReader(root).stats()).toMatchObject({ writeFailures: 0 });
  }, 10_000);
});

function seedResetScaleHistory(
  root: string,
  targetRuns: number,
  callsPerRun: number,
  foreignTombstones: number,
): void {
  const database = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const now = Date.now();
    database.exec("CREATE TEMP TABLE seed_numbers (value INTEGER PRIMARY KEY)");
    database.exec(`
      WITH digits(value) AS (
        VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
      )
      INSERT INTO seed_numbers (value)
      SELECT ones.value
        + tens.value * 10
        + hundreds.value * 100
        + thousands.value * 1000
      FROM digits AS ones
      CROSS JOIN digits AS tens
      CROSS JOIN digits AS hundreds
      CROSS JOIN digits AS thousands
    `);
    database.prepare("CREATE TEMP TABLE target_runs AS SELECT value FROM seed_numbers WHERE value < ?").run(targetRuns);
    database.prepare("CREATE TEMP TABLE target_calls AS SELECT value FROM seed_numbers WHERE value < ?").run(callsPerRun);
    database.prepare(`
      INSERT INTO runs (conversation_id,logical_id,run_id,isolated,status,next_seq,started_at_ms,terminal_at_ms)
      SELECT 'slack:C1#2026-08-14','slack:C1','target-run-' || value,0,'succeeded',?,?,?
      FROM target_runs
    `).run(callsPerRun * 2 + 1, now, now);
    database.prepare(`
      INSERT INTO runs (conversation_id,logical_id,run_id,isolated,status,next_seq,started_at_ms,terminal_at_ms)
      VALUES ('slack:C2#2026-08-14','slack:C2','foreign-run',0,'succeeded',1,?,?)
    `).run(now, now);
    database.prepare(`
      INSERT INTO tool_calls (
        conversation_id,run_id,tool_call_id,tool_name,start_seq,end_seq,state,started_at_ms,ended_at_ms
      )
      SELECT 'slack:C1#2026-08-14','target-run-' || runs.value,'target-call-' || calls.value,'Read',
             calls.value * 2 + 1,calls.value * 2 + 2,'success',?,?
      FROM target_runs AS runs CROSS JOIN target_calls AS calls
    `).run(now, now);
    database.prepare(`
      INSERT INTO tombstones (record_id,conversation_id,run_id,tool_call_id,phase,reason,removed_at_ms)
      SELECT 'foreign-tombstone-' || value,'slack:C2#2026-08-14','foreign-run',
             'foreign-call-' || value,'result','count',?
      FROM seed_numbers WHERE value < ?
    `).run(now, foreignTombstones);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the seeding failure */ }
    throw error;
  } finally {
    database.close();
  }
}

function indexColumns(database: DatabaseSync, indexName: string): string[] {
  return (database.prepare(`PRAGMA index_info(${indexName})`).all() as Array<{ readonly name: string }>)
    .map((column) => column.name);
}

function queryPlanDetails(database: DatabaseSync, sql: string, ...values: string[]): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ readonly detail: string }>)
    .map((row) => row.detail);
}

function startChild(
  root: string,
  ceilingMs: number,
  mode: "close" | "force-unref-open" | "hold" | "open-only" | "settle" = "close",
): ChildProcess {
  const fixture = fileURLToPath(new URL("./fixtures/tool-history-child.mjs", import.meta.url));
  if (sourceFixtureModuleUrl === "") throw new Error("Tool history source fixture was not compiled.");
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fixture,
    sourceFixtureModuleUrl,
    root,
    String(ceilingMs),
    mode,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  child.stdout?.on("data", (chunk) => buffers.stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => buffers.stderr.push(Buffer.from(chunk)));
  childBuffers.set(child, buffers);
  children.add(child);
  return child;
}

async function runChild(root: string, ceilingMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await childResult(startChild(root, ceilingMs));
}

async function childResult(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const buffers = childBuffers.get(child) ?? { stdout: [], stderr: [] };
  const code = child.exitCode ?? (await once(child, "exit") as [number | null, NodeJS.Signals | null])[0];
  children.delete(child);
  return {
    code,
    stdout: Buffer.concat(buffers.stdout).toString("utf8"),
    stderr: Buffer.concat(buffers.stderr).toString("utf8"),
  };
}

async function waitForOutput(child: ChildProcess, marker: string): Promise<void> {
  let output = Buffer.concat(childBuffers.get(child)?.stdout ?? []).toString("utf8");
  if (output.includes(marker)) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error(`Timed out waiting for child marker ${marker}: ${output}`)), 5_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      resolvePromise();
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`Child exited ${String(code)} before ${marker}: ${output}`));
    });
  });
}

async function waitForFile(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
}
