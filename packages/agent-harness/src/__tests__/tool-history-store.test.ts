import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  type ToolHistoryRunBinding,
} from "../tool-history-store.js";
import { buildToolHistoryProjection } from "../tool-history-projection.js";

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const childBuffers = new WeakMap<ChildProcess, { stdout: Buffer[]; stderr: Buffer[] }>();

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
      currentRunId: "run-current",
      limit: 10,
    });
    expect(page.items).toHaveLength(8);
    expect(page.items.map((item) => item.state).sort()).toEqual([...states].sort());
    expect(page.items.every((item) => item.untrusted)).toBe(true);
    const invocation = reader.get({
      logicalConversationId: "slack:C1",
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
      currentRunId: "run-current",
      query: "needle-3",
      tools: ["Read"],
      states: ["exit_nonzero"],
    }).items).toHaveLength(1);

    await unlink(artifact);
    expect(reader.get({
      logicalConversationId: "slack:C1",
      currentRunId: "run-current",
      recordId: results[0]!.recordId!,
    }).record?.artifactReferences).toEqual([
      { id: expect.stringMatching(/^stha1_/u), available: false },
    ]);
    expect(reader.get({
      logicalConversationId: "slack:C1",
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
    const search = reader.search({ logicalConversationId: "slack:C1", currentRunId: "current", limit: 10 });
    const fetched = recordIds.map((recordId) => reader.get({
      logicalConversationId: "slack:C1",
      currentRunId: "current",
      recordId,
      chunkBytes: 8 * 1024,
    }));
    const projection = buildToolHistoryProjection(reader, "slack:C1", "current");
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
    const search = reader.search({ logicalConversationId: "slack:C1", currentRunId: "current" });
    const fetched = [invocation.recordId!, result.recordId!].map((recordId) => reader.get({
      logicalConversationId: "slack:C1",
      currentRunId: "current",
      recordId,
      chunkBytes: 8 * 1024,
    }));
    const projection = buildToolHistoryProjection(reader, "slack:C1", "current");
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
    const page = reader.search({ logicalConversationId: "slack:C1", currentRunId: "current-run" });
    expect(page.items.map((item) => item.runId)).toEqual(["old-run"]);
    expect(JSON.stringify(page)).not.toContain(leakedPath);
    const fetched = reader.get({
      logicalConversationId: "slack:C1",
      currentRunId: "current-run",
      toolCallId: "old-run-call",
    });
    expect(JSON.stringify(fetched)).not.toContain(leakedPath);
    expect(fetched.chunk).toContain("output");
    expect(fetched.chunk).toContain("[private-path]");
    const projection = buildToolHistoryProjection(reader, "slack:C1", "current-run");
    expect(projection?.recordCount).toBe(1);
    expect(projection?.text).not.toContain(leakedPath);
    expect(projection?.text).not.toContain("current-only");
    expect(projection?.text).toContain("output");
    expect(projection?.text).toContain("[private-path]");
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
      expect(new ToolHistoryReader(root).latestProjection("slack:C1", "current", 12)).toHaveLength(12);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

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
      const before = reader.search({ logicalConversationId: "slack:C1", currentRunId: "run-current" });
      expect(before.items.map((item) => item.toolCallId).sort()).toEqual(["kept", "orphan"]);
      expect(reader.latestProjection("slack:C1", "run-current")).toHaveLength(2);
      const recordIds = before.items.flatMap((item) => [item.recordId, item.resultRecordId].filter(
        (recordId): recordId is string => recordId !== undefined,
      ));

      await writer.resetConversation("slack:C1");
      expect(reader.search({ logicalConversationId: "slack:C1", currentRunId: "run-current" }).items)
        .toEqual([]);
      expect(reader.latestProjection("slack:C1", "run-current")).toEqual([]);
      for (const recordId of recordIds) {
        expect(reader.get({
          logicalConversationId: "slack:C1",
          currentRunId: "run-current",
          recordId,
        })).toEqual({ untrusted: true });
      }
    } finally {
      await writer.close();
    }

    const reader = new ToolHistoryReader(root);
    expect(reader.search({ logicalConversationId: "slack:C1", currentRunId: "run-current" }).items)
      .toEqual([]);
    expect(reader.search({ logicalConversationId: "slack:C2", currentRunId: "run-current" }).items)
      .toMatchObject([{ toolCallId: "foreign" }]);
    expect(reader.stats()).toMatchObject({ calls: 1, records: 2 });
  });

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
    expect(await writer.persist(run, {
      phase: "result", toolCallId: "same-call", toolName: "Read", state: "success", content: "ok",
    })).toMatchObject({ persistence: "persisted", sequence: 2 });
    await writer.close();

    expect(new ToolHistoryReader(root).search({
      logicalConversationId: "slack:C1",
      currentRunId: "current",
    }).items).toMatchObject([{ toolName: "Read", state: "success" }]);
    expect(new ToolHistoryReader(root).stats()).toMatchObject({ idempotencyConflicts: 1 });
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
    expect(reader.search({ logicalConversationId: "slack:C1", currentRunId: "current" }).items.map((item) => item.runId))
      .toEqual(["normal"]);
    expect(reader.search({ logicalConversationId: "slack:C1", currentRunId: "current", includeIsolated: true }).items.map((item) => item.runId).sort())
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
    expect(stats?.calls).toBeLessThanOrEqual(1);
    expect(stats?.retainedBytes).toBeLessThanOrEqual(700);
    expect(stats?.tombstones).toBeLessThanOrEqual(4);
    expect(stats?.bytes).toBeGreaterThan(stats?.retainedBytes ?? 0);
    expect(reader.get({
      logicalConversationId: "slack:C1",
      currentRunId: "current",
      recordId: firstId[0]!,
    })).toMatchObject({ tombstone: { reason: expect.stringMatching(/count|bytes/u) }, untrusted: true });
    expect(reader.get({
      logicalConversationId: "slack:C1",
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
      currentRunId: "current",
    })).toThrow(/mode 0600/iu);
  });

  it("hard-fails newer and unmarked foreign schemas instead of attempting downgrade or adoption", async () => {
    const newerRoot = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root: newerRoot });
    await writer.close();
    const newerPath = join(newerRoot, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const newer = new DatabaseSync(newerPath);
    newer.exec("PRAGMA user_version=2");
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
    expect(result.stdout).toContain("STARTING");
    expect(result.stdout).toContain("ACQUIRED");
    expect(new ToolHistoryReader(root).stats()).toMatchObject({ calls: 0, records: 0 });
  }, 10_000);

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
      currentRunId: "after-restart",
    });
    expect(page.items).toMatchObject([{
      toolCallId: "crash-call",
      state: "interrupted",
      recovered: true,
    }]);
    expect(new ToolHistoryReader(root).stats()).toMatchObject({ recovered: 1, dangling: 0 });
  }, 10_000);

  it("keeps message append, retention, and stats green while the sidecar directory, owner DB, and DELETE journal coexist, and bounds a slow write at 250 ms", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const contentPath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const journalPath = `${contentPath}-journal`;
    const blocker = new DatabaseSync(contentPath);
    blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    blocker.prepare("INSERT OR REPLACE INTO writer_stats(key,value,updated_at_ms) VALUES('test_blocker',0,?)").run(Date.now());
    await chmod(journalPath, 0o600);
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
      await writer.close();
    }
    expect(new ToolHistoryReader(root).stats()).toMatchObject({ writeFailures: 1 });
  }, 10_000);
});

function startChild(
  root: string,
  ceilingMs: number,
  mode: "close" | "hold" | "open-only" | "settle" = "close",
): ChildProcess {
  const fixture = fileURLToPath(new URL("./fixtures/tool-history-child.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture, root, String(ceilingMs), mode], {
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
