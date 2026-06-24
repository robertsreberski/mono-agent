import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createJsonlRunRecorder,
  listRecordedRuns,
  readRecordedRun,
  ObservabilityReadError,
  reconcileStaleRunArtifacts,
} from "../index.js";
import { classifyRecordedRunEvent } from "../recorded-runs.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "observability-reader-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("recorded run reader", () => {
  it("lists summary artifacts newest first with redacted metadata", async () => {
    const dir = await tempDir();
    const first = createJsonlRunRecorder({ runId: "run-one", conversationId: "chat-1", artifactDir: dir });
    first.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
    const firstSummary = await first.finish({ usage: { inputTokens: 1, apiKey: "fixture-redacted-value" } });

    const second = createJsonlRunRecorder({ runId: "run-two", conversationId: "chat-2", artifactDir: dir });
    const secondSummary = await second.finish({ failureKind: "provider_error", diagnostics: { token: "fixture-token-value" } });

    await utimes(firstSummary.artifactPaths[1] ?? "", new Date("2026-05-15T10:00:00Z"), new Date("2026-05-15T10:00:00Z"));
    await utimes(secondSummary.artifactPaths[1] ?? "", new Date("2026-05-15T11:00:00Z"), new Date("2026-05-15T11:00:00Z"));

    const list = await listRecordedRuns({ artifactDir: dir });

    expect(list.warnings).toEqual([]);
    expect(list.totalRuns).toBe(2);
    expect(list.runs.map((run) => run.runId)).toEqual(["run-two", "run-one"]);
    expect(list.runs[0]).toMatchObject({ status: "failed", failureKind: "provider_error", eventCount: 0 });
    expect(JSON.stringify(list.runs)).not.toContain("fixture-redacted-value");
    expect(JSON.stringify(list.runs)).not.toContain("fixture-token-value");
    expect(JSON.stringify(list.runs)).toContain("[redacted]");
  });

  it("returns an empty list when the artifact directory does not exist", async () => {
    const dir = join(await tempDir(), "missing");
    await expect(listRecordedRuns({ artifactDir: dir })).resolves.toEqual({ totalRuns: 0, runs: [], warnings: [] });
  });

  it("reads event timelines, classifies visible runtime events, caps events, and warns for malformed lines", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "Run:Detail", conversationId: "chat-1", artifactDir: dir });
    recorder.onEvent({ type: "thinking.delta", summary: "checking available tools" });
    recorder.onEvent({ type: "tool.call", toolName: "Read", status: "started", token: "hide-me" });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "visible response" }] } });
    const summary = await recorder.finish({ cost: { totalUsd: 0.01 } });
    await writeFile(summary.artifactPaths[0] ?? "", `${await readFile(summary.artifactPaths[0] ?? "", "utf8")}not-json\n`, "utf8");

    const detail = await readRecordedRun({ artifactDir: dir, maxEventsPerRun: 2 }, "Run:Detail");

    expect(detail?.summary).toMatchObject({ runId: "Run:Detail", conversationId: "chat-1", eventCount: 3 });
    expect(detail?.events).toHaveLength(2);
    expect(detail?.events.map((event) => event.category)).toEqual(["thinking", "tool"]);
    expect(detail?.events[0]?.summary).toMatch(/checking available tools/u);
    expect(detail?.events[1]?.label).toBe("Tool: Read");
    expect(JSON.stringify(detail?.events)).not.toContain("hide-me");
    expect(detail?.warnings).toEqual(["Event list was capped at 2 events."]);
  });

  it("classifies assistant thinking content blocks as thinking events", () => {
    expect(classifyRecordedRunEvent({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "I need to inspect the trace." },
          { type: "thinking", text: "Then group adjacent chunks." },
        ],
      },
    })).toBe("thinking");

    expect(classifyRecordedRunEvent({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Visible answer." }],
      },
    })).toBe("message");
  });

  it("continues past invalid summary files with warnings", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "bad.summary.json"), "{bad", "utf8");
    const good = createJsonlRunRecorder({ runId: "good", conversationId: "chat", artifactDir: dir });
    await good.finish({});

    const list = await listRecordedRuns({ artifactDir: dir });

    expect(list.totalRuns).toBe(1);
    expect(list.runs.map((run) => run.runId)).toEqual(["good"]);
    expect(list.warnings[0]).toMatch(/Skipping bad.summary.json: invalid JSON/u);
  });

  it("refuses run ids that could be path traversal", async () => {
    const dir = await tempDir();
    await expect(readRecordedRun({ artifactDir: dir }, "../secrets")).rejects.toBeInstanceOf(ObservabilityReadError);
    await expect(readRecordedRun({ artifactDir: dir }, "nested/run")).rejects.toMatchObject({ code: "invalid_run_id" });
  });
});

describe("reconcileStaleRunArtifacts", () => {
  async function writeSummary(dir: string, name: string, summary: Record<string, unknown>): Promise<void> {
    await writeFile(join(dir, name), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  it("rewrites orphaned running runs (started before the cutoff) to interrupted, leaving live and terminal runs", async () => {
    const dir = await tempDir();
    const cutoff = Date.parse("2026-05-15T12:00:00.000Z");
    await writeSummary(dir, "orphan.summary.json", {
      runId: "orphan", conversationId: "c", status: "running", startedAt: "2026-05-15T11:00:00.000Z",
    });
    await writeSummary(dir, "live.summary.json", {
      runId: "live", conversationId: "c", status: "running", startedAt: "2026-05-15T12:30:00.000Z",
    });
    await writeSummary(dir, "done.summary.json", {
      runId: "done", conversationId: "c", status: "succeeded", startedAt: "2026-05-15T10:00:00.000Z", endedAt: "2026-05-15T10:01:00.000Z",
    });

    const result = await reconcileStaleRunArtifacts(dir, {
      startedBeforeMs: cutoff,
      clock: () => Date.parse("2026-05-15T13:00:00.000Z"),
    });

    expect(result.reconciled).toEqual(["orphan"]);
    expect(result.warnings).toEqual([]);

    const orphan = JSON.parse(await readFile(join(dir, "orphan.summary.json"), "utf8")) as Record<string, unknown>;
    expect(orphan.status).toBe("interrupted");
    expect(orphan.failureKind).toBe("process_death");
    expect(orphan.endedAt).toBe("2026-05-15T13:00:00.000Z");

    // A "running" run started after the cutoff belongs to THIS process — must be untouched.
    const live = JSON.parse(await readFile(join(dir, "live.summary.json"), "utf8")) as Record<string, unknown>;
    expect(live.status).toBe("running");
    const done = JSON.parse(await readFile(join(dir, "done.summary.json"), "utf8")) as Record<string, unknown>;
    expect(done.status).toBe("succeeded");
  });

  it("returns empty for a missing artifact directory", async () => {
    const dir = join(await tempDir(), "missing");
    await expect(reconcileStaleRunArtifacts(dir, { startedBeforeMs: 0 })).resolves.toEqual({ reconciled: [], warnings: [] });
  });
});
