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

  it("copies accepted route primitives across caller mutation and finish sealing", () => {
    const progress = new SubagentJobProgress([]);
    const event = { type: "route", requested: { model: "provider:primary", effort: "high" },
      executed: { model: "provider:fallback", effort: "xhigh", effectiveEffort: "max" },
      disposition: "fallback" } as const;
    expect(progress.report(event)).toBe(true);
    (event.requested as { model: string }).model = "provider:mutated";
    (event.executed as { model: string }).model = "provider:mutated";
    const accepted = progress.snapshot();
    expect(accepted.route).toEqual({
      requested: { model: "provider:primary", effort: "high" },
      executed: { model: "provider:fallback", effort: "xhigh", effectiveEffort: "max" },
      disposition: "fallback",
    });
    const finished = progress.finish();
    (event.requested as { effort: string }).effort = "low";
    (event.executed as { effort: string }).effort = "low";
    expect(progress.snapshot()).toEqual(finished);
  });

  it("drops secret-shaped route fields rather than presenting redaction markers as model names", () => {
    const knownRoute = "provider:private-route";
    const credentialRoute = `provider:ghp_${"g".repeat(16)}`;
    const progress = new SubagentJobProgress([knownRoute]);
    expect(progress.report({ type: "route",
      requested: { model: knownRoute, effort: "high" },
      executed: { model: credentialRoute, effort: "xhigh" },
      disposition: "fallback" })).toBe(true);
    expect(progress.snapshot().route).toEqual({
      requested: { effort: "high" },
      executed: { effort: "xhigh" },
      disposition: "fallback",
    });
    expect(JSON.stringify(progress.snapshot().route)).not.toMatch(/private-route|ghp_|\[REDACTED\]/u);

    const reversed = new SubagentJobProgress([knownRoute]);
    expect(reversed.report({ type: "route",
      requested: { model: credentialRoute, effort: "high" },
      executed: { model: knownRoute, effort: "xhigh" },
      disposition: "fallback" })).toBe(true);
    expect(JSON.stringify(reversed.snapshot().route)).not.toMatch(/private-route|ghp_|\[REDACTED\]/u);
  });

  it("retains long descriptive route identifiers that are not literals or credential shapes", () => {
    const descriptive = "my-company/production-large-language-model-v2";
    const qualified = `provider:${descriptive}`;
    expect(descriptive.length).toBeGreaterThanOrEqual(40);
    const progress = new SubagentJobProgress([]);
    expect(progress.report({ type: "route",
      requested: { model: descriptive, effort: "high" },
      executed: { model: qualified, effort: "xhigh" },
      disposition: "fallback" })).toBe(true);
    expect(progress.snapshot().route).toEqual({
      requested: { model: descriptive, effort: "high" },
      executed: { model: qualified, effort: "xhigh" },
      disposition: "fallback",
    });
  });
});

describe("argument preview redaction", () => {
  const home = "/Users/example";
  const secrets = [home, "example", "private-note", "s3cr3tvalue"];
  const redact = (value: string) => redactSubagentArgumentPreview(value, secrets, home);

  it.each([
    ["home containing the username literal",
      `${home}/worktrees/mono-maintainer/mono-agent/pwa-top-blur/AGENTS.md`,
      [home, "example"],
      "~/worktrees/mono-maintainer/mono-agent/pwa-top-blur/AGENTS.md"],
    ["mixed-boundary repeated home literal",
      `${home}/pin-7421${home}X`,
      [home, `${home}/pin-7421${home}`],
      "[REDACTED]X"],
    ["literal overlapping the home suffix",
      `${home}/pin-7421`,
      [home, "example/pin-7421"],
      ["/Users", "[REDACTED]"].join("/")],
    ["username literal outside the home occurrence",
      `${home}/notes/example-todo.md`,
      [home, "example"],
      "~/notes/[REDACTED]-todo.md"],
  ])("resolves original-byte home and literal ranges for %s", (_case, value, fixtureSecrets, expected) => {
    expect(redactSubagentArgumentPreview(value, fixtureSecrets, home)).toBe(expected);
  });

  it("renders the exact home root as home-relative with realistic ambient secrets", () => {
    expect(redact(home)).toBe("~");
  });

  it("uses a home boundary and still scrubs literal secrets outside that prefix", () => {
    const neighboringHome = redactSubagentArgumentPreview("/rooted/x", ["/root", "root"], "/root");
    expect(neighboringHome).not.toMatch(/^~/u);
    expect(neighboringHome).not.toContain("root");
    expect(redact("/Users/example/notes/private-note-todo.md")).toBe("~/notes/[REDACTED]-todo.md");
    expect(redact("~/safe/s3cr3tvalue/file")).not.toContain("s3cr3tvalue");
  });

  it.each([
    ["bearer", "curl -H \"Authorization: Bearer b-short\" ~/a/b", "b-short"],
    ["password flag", "tool -p tiny-pass", "tiny-pass"],
    ["labelled API credential", ["api", "key=k-short"].join("_"), "k-short"],
    ["token label", "token: t-short", "t-short"],
    ["password label", "password=p-short", "p-short"],
    ["URL userinfo", "https://u:pw@host/a/b", "u:pw"],
    ["PEM", "-----BEGIN RSA PRIVATE KEY-----\nshort-body\n-----END RSA PRIVATE KEY-----", "short-body"],
    ["GitHub token", `ghp_${"g".repeat(16)}`, `ghp_${"g".repeat(16)}`],
    ["literal secret", "~/safe/s3cr3tvalue/file", "s3cr3tvalue"],
  ])("removes adversarial %s material below the generic entropy threshold", (_case, value, secret) => {
    expect(secret.length).toBeLessThan(24);
    expect(redact(value)).not.toContain(secret);
  });

  it("redacts opaque segments and long slash-bearing credential shapes", () => {
    expect(redact(`~/.cache/${"a".repeat(32)}/file`)).not.toContain("a".repeat(32));
    const slashBearing = `${"A".repeat(20)}/${"B".repeat(23)}`;
    expect(redact(slashBearing)).toBe("[REDACTED]");
  });

  it.each([
    ["parentheses", "(", ")"],
    ["brackets", "[", "]"],
    ["commas", ",", ","],
    ["equals", "=", "="],
    ["quotes", "\"", "\""],
  ])("redacts a 40+ slash-bearing opaque run at %s boundaries", (_case, before, after) => {
    const opaque = `${"A".repeat(20)}/${"B".repeat(20)}`;
    expect(opaque).toHaveLength(41);
    expect(redact(`${before}${opaque}${after}`)).not.toContain(opaque);
  });

  it("redacts userinfo after an arbitrarily long custom URL scheme", () => {
    const value = `${"a".repeat(65)}://user:pw@host`;
    expect(redact(value)).not.toContain("user:pw@");
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
