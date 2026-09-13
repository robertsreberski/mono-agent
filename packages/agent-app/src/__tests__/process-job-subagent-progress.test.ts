import { describe, expect, it } from "vitest";
import { isProcessJobSubagentProgress } from "@mono-agent/agent-contracts";
import { SubagentJobProgress } from "../process-job-subagent-progress.js";

describe("private subagent job progress", () => {
  it("bounds retention while keeping totals, durations and exactly-once retained completions", () => {
    const progress = new SubagentJobProgress([]);
    progress.report({ type: "started", profile: "helper" });
    for (let i = 0; i < 100; i++) {
      progress.report({ type: "tool_started", id: String(i), toolName: "Read", argsSummary: "x/".repeat(500) });
      progress.report({ type: "tool_completed", id: String(i), failed: i % 2 === 0, executionMs: 12.4 });
    }
    expect(progress.report({ type: "tool_completed", id: "99", failed: true })).toBe(false);
    const snapshot = progress.snapshot();
    expect(snapshot).toMatchObject({ revision: 201, toolCalls: 100, failedCalls: 50 });
    expect(snapshot.recent).toHaveLength(50);
    expect(snapshot.recent[0]).toMatchObject({ id: "50", status: "failed", executionMs: 12 });
    expect(Buffer.byteLength(snapshot.recent[0]!.argsSummary!)).toBeLessThanOrEqual(256);
    expect(isProcessJobSubagentProgress(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot).length).toBeLessThan(50_000);
  });

  it("redacts before retention and byte truncation, bounds Unicode, seals and clones snapshots", () => {
    const progress = new SubagentJobProgress(["a private credential"]);
    progress.report({ type: "started", profile: "😀".repeat(200), label: "token=hidden" });
    progress.report({ type: "tool_started", id: "1", toolName: "Bash", argsSummary: 'echo --password="correct horse battery staple" a private credential' });
    const answer = "Report\na private credential\nBearer forbidden\n" + "😀 ".repeat(5_000);
    const snapshot = progress.finish(answer);
    expect(JSON.stringify(snapshot)).not.toMatch(/private credential|correct horse|forbidden|hidden/u);
    expect(snapshot).toMatchObject({ failedCalls: 1, answerTruncated: true });
    expect(snapshot.recent[0]?.status).toBe("failed");
    expect(snapshot.answerHead).toContain("Report\n");
    expect(Buffer.byteLength(snapshot.answerHead!)).toBeLessThanOrEqual(8_000);
    expect(isProcessJobSubagentProgress(snapshot)).toBe(true);
    expect(progress.report({ type: "tool_completed", id: "1", failed: false })).toBe(false);
    expect(progress.finish("late")).toEqual(snapshot);
    (snapshot.recent as unknown[]).pop();
    expect(progress.snapshot().recent).toHaveLength(1);
  });
});
