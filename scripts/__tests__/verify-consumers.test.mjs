import { describe, expect, it } from "vitest";

import { runVerifyConsumers } from "../verify-consumers.mjs";

describe("verify-consumers", () => {
  it("prints PASS lines and an ok summary when both golden consumers pass", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build"],
      cwd: "/repo",
      dependencies: fakeDependencies(),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("PASS personal-agent contract");
    expect(stdout.text).toContain("PASS a8c-agent contract");
    expect(stdout.text).toContain("PASS consumers");
    expect(stdout.text).toContain("personal-agent contract ok");
    expect(stdout.text).toContain("a8c-agent contract ok");
    expect(stdout.text).toContain("consumers ok");
  });

  it("exits non-zero when one consumer contract fails", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build"],
      cwd: "/repo",
      dependencies: fakeDependencies({ failingContract: "a8c-agent" }),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("PASS personal-agent contract");
    expect(stdout.text).toContain("FAIL a8c-agent contract: validation: fixture drift");
    expect(stdout.text).toContain("a8c-agent contract fail");
    expect(stdout.text).toContain("consumers fail");
  });

  it("adds a read-only downstream artifact audit when --consumer is supplied", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build", "--consumer", "/tmp/downstream-agent"],
      cwd: "/repo",
      dependencies: fakeDependencies({
        auditReport: cleanAuditReport({ parseFailureCount: 1 }),
      }),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("FAIL downstream-agent artifact audit: 1 parse failure(s)");
    expect(stdout.text).toContain("downstream-agent artifact audit fail");
    expect(stdout.text).toContain("consumers fail");
  });
});

function fakeDependencies(options = {}) {
  return {
    consumerContractNames: ["personal-agent", "a8c-agent"],
    validateConsumerContractFixture: async ({ name }) => ({
      name,
      ok: name !== options.failingContract,
      reportOk: name !== options.failingContract,
      networkCallCount: 0,
      sections: [],
      issues: name === options.failingContract ? [{ check: "validation", message: "fixture drift" }] : [],
    }),
    resolveAppArtifactDir: async () => "/tmp/artifacts",
    resolveAppTraceStaleAfterMs: async () => 30_000,
    auditRecordedRuns: async () => options.auditReport ?? cleanAuditReport(),
  };
}

function cleanAuditReport(overrides = {}) {
  return {
    artifactDir: "/tmp/artifacts",
    totalSummaryFiles: 2,
    parsedSummaryFiles: 2,
    parseFailureCount: 0,
    parseFailures: [],
    statusHistogram: {
      running: 0,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    },
    unrecognizedStatusCount: 0,
    unrecognizedStatuses: [],
    failureKindHistogram: {
      provider_unavailable: 0,
      provider_unavailable_exhausted: 0,
      usage_limit: 0,
      process_death: 0,
      runtime_error: 0,
      cancelled: 0,
    },
    summariesWithFailureKind: 0,
    unrecognizedFailureKindCount: 0,
    unrecognizedFailureKinds: [],
    staleRunningCount: 0,
    staleRunning: [],
    failureKindRates: [],
    rateDenominators: {
      parsedSummaries: 2,
      summariesWithFailureKind: 0,
    },
    warnings: [],
    ...overrides,
  };
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
