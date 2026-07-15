import { describe, expect, it } from "vitest";

import { runVerifyAll } from "../verify-all.mjs";

describe("verify-all", () => {
  it("runs the repo gate in order, then ends with the exact green verdict lines", async () => {
    const stdout = sink();
    const labels = [];
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      stdout,
      stderr: sink(),
      runCommand: async (_command, _args, options) => {
        labels.push(options.label);
        return 0;
      },
      verifyConsumers: async () => ({
        exitCode: 0,
        statusByLabel: new Map([
          ["local-agent-alpha contract", true],
          ["local-agent-beta contract", true],
        ]),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(labels).toEqual([
      "check:node",
      "check:secrets",
      "check:oss-hygiene",
      "check:licenses",
      "check:codex-discoverability",
      "check:architecture",
      "build",
      "typecheck",
      "test",
      "test:demo",
      "git diff --check",
    ]);
    expect(stdout.text.endsWith([
      "repo green",
      "local-agent-alpha contract green",
      "local-agent-beta contract green",
      "",
    ].join("\n"))).toBe(true);
  });

  it("exits non-zero and skips consumers when the repo gate fails", async () => {
    const stdout = sink();
    const stderr = sink();
    let verifyConsumersCalled = false;
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      stdout,
      stderr,
      runCommand: async (_command, _args, options) => options.label === "typecheck" ? 1 : 0,
      verifyConsumers: async () => {
        verifyConsumersCalled = true;
        return {
          exitCode: 0,
          statusByLabel: new Map(),
        };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(verifyConsumersCalled).toBe(false);
    expect(stderr.text).toContain("Repo gate failed at typecheck.");
    expect(stderr.text).toContain("Consumer verification skipped");
    expect(stdout.text).toContain("repo fail");
    expect(stdout.text).toContain("local-agent-alpha contract fail");
    expect(stdout.text).toContain("local-agent-beta contract fail");
  });

  it("exits non-zero when a consumer verdict is not green", async () => {
    const stdout = sink();
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      stdout,
      stderr: sink(),
      runCommand: async () => 0,
      verifyConsumers: async () => ({
        exitCode: 1,
        statusByLabel: new Map([
          ["local-agent-alpha contract", true],
          ["local-agent-beta contract", false],
        ]),
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("repo ok");
    expect(stdout.text).toContain("local-agent-alpha contract ok");
    expect(stdout.text).toContain("local-agent-beta contract fail");
    expect(stdout.text.endsWith([
      "repo green",
      "local-agent-alpha contract green",
      "local-agent-beta contract failed",
      "",
    ].join("\n"))).toBe(true);
  });
});

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
