import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MINIMUM_NODE_VERSION } from "../node-version.mjs";
import {
  VERIFY_GATE_DELTA,
  createRepoGate,
  readReleaseSmokeTag,
  runVerifyAll,
} from "../verify-all.mjs";

describe("verify-all", () => {
  it("runs the repo gate in order, then ends with the exact green verdict lines", async () => {
    const stdout = sink();
    const labels = [];
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.11.2",
      nodeVersion: MINIMUM_NODE_VERSION,
      stdout,
      stderr: sink(),
      runCommand: async (command, args, options) => {
        labels.push(options.label);
        if (options.label === "release:validate") {
          expect({ command, args }).toEqual({
            command: "pnpm",
            args: ["run", "release:validate", "--", "--tag", "v0.11.2"],
          });
        }
        if (options.label === "release:pack") {
          expect({ command, args }).toEqual({
            command: "pnpm",
            args: ["run", "release:pack", "--", "--tag", "v0.11.2"],
          });
        }
        if (options.label === "release:consumer") {
          expect({ command, args }).toEqual({
            command: "pnpm",
            args: ["run", "release:consumer", "--", "--tag", "v0.11.2", "--require-minimum"],
          });
        }
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
      "check:pnpm-policy",
      "check:secrets",
      "check:oss-hygiene",
      "check:licenses",
      "check:dependency-vulnerabilities",
      "check:codex-discoverability",
      "release:validate",
      "check:architecture",
      "build",
      "release:pack",
      "release:consumer",
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
      releaseTag: "v0.11.2",
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
      releaseTag: "v0.11.2",
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

  it("runs packed-consumer smoke coverage on newer Node without claiming the minimum-version proof", () => {
    const releaseConsumer = createRepoGate({
      releaseTag: "v0.11.2",
      nodeVersion: "24.0.0",
    }).find((command) => command.label === "release:consumer");

    expect(releaseConsumer).toEqual({
      label: "release:consumer",
      command: "pnpm",
      args: ["run", "release:consumer", "--", "--tag", "v0.11.2"],
    });
  });

  it("derives the release smoke tag from the agent-app manifest", () => {
    const calls = [];
    expect(readReleaseSmokeTag("/repo", (path, encoding) => {
      calls.push({ path, encoding });
      return JSON.stringify({ version: "1.2.3-beta.1" });
    })).toBe("v1.2.3-beta.1");
    expect(calls).toEqual([{
      path: "/repo/packages/agent-app/package.json",
      encoding: "utf8",
    }]);
  });

  it("keeps the CI and verify-all gate lists at only the documented intentional delta", () => {
    const ciSource = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const ciGate = ciVerifyGateLabels(ciSource);
    const verifyAllGate = [
      ...createRepoGate({ releaseTag: "v0.11.2", nodeVersion: MINIMUM_NODE_VERSION })
        .map((command) => command.label),
      "verify:consumers",
    ];
    const ciOnly = ciGate.filter((label) => !verifyAllGate.includes(label));
    const verifyAllOnly = verifyAllGate.filter((label) => !ciGate.includes(label));

    expect(ciOnly).toEqual(VERIFY_GATE_DELTA.ciOnly.map((entry) => entry.label));
    expect(verifyAllOnly).toEqual(VERIFY_GATE_DELTA.verifyAllOnly.map((entry) => entry.label));
    expect(ciGate.filter((label) => !ciOnly.includes(label))).toEqual(
      verifyAllGate.filter((label) => !verifyAllOnly.includes(label)),
    );
    expect(VERIFY_GATE_DELTA.ciOnly.every((entry) => entry.reason.length > 0)).toBe(true);
    expect(VERIFY_GATE_DELTA.verifyAllOnly.every((entry) => entry.reason.length > 0)).toBe(true);
  });
});

function ciVerifyGateLabels(source) {
  const verifyJob = source.slice(source.indexOf("  verify:"), source.indexOf("  website:"));
  const steps = verifyJob.split(/^      - name: /mu).slice(1);
  const labels = [];

  for (const step of steps) {
    if (step.includes("ghcr.io/gitleaks/gitleaks")) {
      labels.push("check:secrets");
      continue;
    }
    const script = /^        run: pnpm run ([a-z0-9:-]+)/mu.exec(step)?.[1];
    if (script !== undefined) {
      labels.push(script);
      continue;
    }
    if (/^        run: pnpm test$/mu.test(step)) {
      labels.push("test");
      continue;
    }
    if (/^        run: git diff --check$/mu.test(step)) {
      labels.push("git diff --check");
    }
  }

  return labels;
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
