import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "measure-prompt-cache.mjs");
const benchmarkRoot = join(root, ".mono-agent", "cache-benchmark");
mkdirSync(benchmarkRoot, { recursive: true });
const outputs = mkdtempSync(join(benchmarkRoot, "test-output-"));
afterAll(() => rmSync(outputs, { recursive: true, force: true }));

const stateDirs = () => readdirSync(benchmarkRoot).filter((name) => name.startsWith("state-")).sort();

function runScenario(scenario, extra = []) {
  const output = join(outputs, `${scenario}.json`);
  const before = stateDirs();
  const child = spawnSync(process.execPath, [script, "--dry-run", "--scenario", scenario, "--turns", "2", "--fixture-tokens", "1024", "--output", output, ...extra], { cwd: root, encoding: "utf8", timeout: 30_000 });
  expect(child.status, child.stderr).toBe(0);
  expect(stateDirs()).toEqual(before);
  return { report: JSON.parse(readFileSync(output, "utf8")), stdout: child.stdout };
}

describe("prompt cache measurement", () => {
  it("drives real configured harness/runtime/Pi-faux assembly and reports observed events", () => {
    const { report, stdout } = runScenario("multi-turn");
    expect(report).toMatchObject({ schema: 2, mode: "dry-run", scenario: "multi-turn", model: "benchmark-faux:cache-model" });
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0].requests[0]).toMatchObject({ supported: true, payloadFamily: "openai-responses", toolDefinitionCount: 1, historyMode: "fresh", costSource: "pi_usage" });
    expect(report.runs[1].historyMode).toBe("provider-session");
    expect(report.runs.flatMap((run) => run.contextUsageSnapshots).some((usage) => usage.cacheRead > 0)).toBe(true);
    expect(report.runs[0].requests[0].systemFingerprint).not.toBe(report.runs[1].requests[0].systemFingerprint);
    expect(JSON.stringify(report)).not.toContain("Read fixture.txt");
    expect(stdout).not.toContain("cache-fixture-");
  });

  it.each([
    ["durable-reopen", []],
    ["stateless", []],
    ["concurrent", ["--conversations", "2"]],
    ["recall-changing", []],
    ["capability-change", []],
  ])("executes the %s control through the same scenario runner", (scenario, extra) => {
    const { report } = runScenario(scenario, extra);
    expect(report.runs.length).toBeGreaterThanOrEqual(2);
    if (scenario === "durable-reopen") expect(report.runs[1].reseedEvents).toContainEqual(expect.objectContaining({ kind: "canonical_history_replay" }));
    if (scenario === "recall-changing") expect(report.runs.flatMap((run) => run.controlEvents).filter((event) => event.type === "memory_recalled")).toHaveLength(2);
    if (scenario === "capability-change") expect(report.runs[1].requests[0].toolDefinitionCount).toBe(0);
  });

  it("refuses live mode before provider dispatch when authorization is incomplete", () => {
    const child = spawnSync(process.execPath, [script, "--live", "--scenario", "multi-turn", "--model", "openai:gpt-test", "--transport", "sse"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("positive --spend-ceiling-usd");
    expect(child.stdout).toBe("");
  });

  it("requires the selected provider to exist in an explicitly named Pi auth file", () => {
    const authPath = join(outputs, "wrong-provider-auth.json");
    writeFileSync(authPath, '{"anthropic":{"type":"oauth"}}\n', { mode: 0o600 });
    const child = spawnSync(process.execPath, [script, "--live", "--scenario", "multi-turn", "--model", "openai:gpt-test", "--transport", "sse", "--spend-ceiling-usd", "1", "--authorize-spend=YES", "--pi-auth", authPath], { cwd: root, encoding: "utf8", timeout: 10_000 });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("no credential for the selected provider");
    expect(child.stdout).toBe("");
  });
});
