import { describe, expect, it } from "vitest";
import { isProcessJobSubagentProgress } from "@mono-agent/agent-contracts";
import { redactSubagentArgumentPreview, SubagentJobProgress } from "../process-job-subagent-progress.js";

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

  it("retains requested and settled route identifiers while rejecting invalid updates", () => {
    const progress = new SubagentJobProgress([]);
    expect(progress.report({ type: "route", requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" } })).toBe(true);
    expect(progress.snapshot()).toMatchObject({ revision: 1, route: {
      requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" },
    } });
    expect(progress.report({ type: "route", requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" } })).toBe(false);
    expect(progress.snapshot().revision).toBe(1);
    expect(progress.report({ type: "route", requested: { model: "x y" } })).toBe(false);
    expect(progress.report({ type: "route", requested: { model: "x".repeat(300) } })).toBe(false);
    expect(progress.report({ type: "route", requested: { model: "valid:model", unknown: "no" } })).toBe(false);
    expect(progress.snapshot().revision).toBe(1);
    expect(progress.report({ type: "route",
      requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" },
      executed: { model: "openai-codex:gpt-5.6-sol", effort: "xhigh", effectiveEffort: "max" },
      disposition: "fallback" })).toBe(true);
    expect(progress.snapshot()).toMatchObject({ revision: 2, route: {
      requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" },
      executed: { model: "openai-codex:gpt-5.6-sol", effort: "xhigh", effectiveEffort: "max" },
      disposition: "fallback",
    } });
    expect(isProcessJobSubagentProgress(progress.snapshot())).toBe(true);
    progress.finish();
    expect(progress.report({ type: "route", requested: { model: "other:model" } })).toBe(false);
  });
});

describe("argument preview redaction", () => {
  const home = "/Users/example";
  const secrets = [home, "example", "s3cr3tvalue"];
  const redact = (value: string) => redactSubagentArgumentPreview(value, secrets, home);

  it("renders the screenshot reproduction as a home-relative path", () => {
    expect(redact("/Users/example/worktrees/mono-maintainer/mono-agent/pwa-top-blur/AGENTS.md"))
      .toBe("~/worktrees/mono-maintainer/mono-agent/pwa-top-blur/AGENTS.md");
    expect(redact("/Users/example")).toBe("~");
  });

  it("uses a home boundary and still scrubs literal secrets outside that prefix", () => {
    const neighboringHome = redactSubagentArgumentPreview("/rooted/x", ["root"], "/root");
    expect(neighboringHome).not.toMatch(/^~/u);
    expect(neighboringHome).not.toContain("root");
    expect(redact("/Users/example/notes/example-todo.md")).toBe("~/notes/[REDACTED]-todo.md");
    expect(redact("~/safe/s3cr3tvalue/file")).not.toContain("s3cr3tvalue");
  });

  it.each([
    ["bearer", `curl -H "Authorization: Bearer ${"b".repeat(30)}" ~/a/b`, "b".repeat(30)],
    ["password flag", "tool --password=hunter2hunter2", "hunter2hunter2"],
    ["api key label", `api_key=${"k".repeat(30)}`, "k".repeat(30)],
    ["token label", `token: ${"t".repeat(30)}`, "t".repeat(30)],
    ["password label", "password=secret-password-value", "secret-password-value"],
    ["URL userinfo", "https://user:pw@host/some/long/path/segments/here", "user:pw"],
    ["PEM", "-----BEGIN RSA PRIVATE KEY-----\nprivate-key-body\n-----END RSA PRIVATE KEY-----", "private-key-body"],
    ["GitHub token", `ghp_${"g".repeat(20)}`, `ghp_${"g".repeat(20)}`],
    ["literal secret", "~/safe/s3cr3tvalue/file", "s3cr3tvalue"],
  ])("removes adversarial %s material", (_case, value, secret) => {
    expect(redact(value)).not.toContain(secret);
  });

  it("redacts opaque segments and long slash-bearing credential shapes", () => {
    expect(redact(`~/.cache/${"a".repeat(32)}/file`)).toBe("~/.cache/[REDACTED]/file");
    const slashBearing = `${"A".repeat(20)}/${"B".repeat(23)}`;
    expect(redact(slashBearing)).toBe("[REDACTED]");
  });

  it("preserves an ordinary path whose slash-free segments stay below the opaque-run limit", () => {
    const path = "~/worktrees/mono-maintainer/mono-agent/pwa-top-blur/AGENTS.md";
    expect(redact(path)).toBe(path);
  });

  it("keeps an emoji-laden retained preview within the contract byte bound", () => {
    const progress = new SubagentJobProgress([]);
    progress.report({ type: "tool_started", id: "emoji", toolName: "Read", argsSummary: `~/worktrees/${"😀/".repeat(200)}AGENTS.md` });
    const snapshot = progress.snapshot();
    expect(Buffer.byteLength(snapshot.recent[0]!.argsSummary!)).toBeLessThanOrEqual(256);
    expect(isProcessJobSubagentProgress(snapshot)).toBe(true);
  });
});
