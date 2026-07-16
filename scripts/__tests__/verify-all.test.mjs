import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MINIMUM_NODE_VERSION } from "../node-version.mjs";
import {
  VERIFY_GATE_DELTA,
  createRepoGate,
  readReleaseSmokeTag,
  runVerifyAll,
} from "../verify-all.mjs";

const RELEASE_TAG_PLACEHOLDER = "<release-tag>";
const ALWAYS = "always";

describe("verify-all", () => {
  it("runs the repo gate in order, then ends with the exact green verdict lines", async () => {
    const stdout = sink();
    const execution = [];
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.11.2",
      nodeVersion: MINIMUM_NODE_VERSION,
      stdout,
      stderr: sink(),
      runCommand: async (command, args, options) => {
        execution.push(options.label);
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
      verifyConsumers: async (options) => {
        execution.push("verify:consumers");
        expect(options.argv).toEqual(["--skip-build"]);
        return {
          exitCode: 0,
          statusByLabel: new Map([
            ["local-agent-alpha contract", true],
            ["local-agent-beta contract", true],
          ]),
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(execution).toEqual([
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
      "verify:consumers",
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

  it("exits non-zero and skips consumers when a pre-build repo gate fails", async () => {
    const stdout = sink();
    const stderr = sink();
    let verifyConsumersCalled = false;
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.11.2",
      stdout,
      stderr,
      runCommand: async (_command, _args, options) => options.label === "check:architecture" ? 1 : 0,
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
    expect(stderr.text).toContain("Repo gate failed at check:architecture.");
    expect(stderr.text).toContain("Consumer verification skipped");
    expect(stdout.text).toContain("repo fail");
    expect(stdout.text).toContain("local-agent-alpha contract fail");
    expect(stdout.text).toContain("local-agent-beta contract fail");
  });

  it("fails fast before release and test commands when a consumer verdict is not green", async () => {
    const stdout = sink();
    const stderr = sink();
    const execution = [];
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.11.2",
      stdout,
      stderr,
      runCommand: async (_command, _args, options) => {
        execution.push(options.label);
        return 0;
      },
      verifyConsumers: async () => {
        execution.push("verify:consumers");
        return {
          exitCode: 1,
          statusByLabel: new Map([
            ["local-agent-alpha contract", true],
            ["local-agent-beta contract", false],
          ]),
        };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(execution).toEqual([
      "check:node",
      "check:secrets",
      "check:oss-hygiene",
      "check:licenses",
      "check:codex-discoverability",
      "release:validate",
      "check:architecture",
      "build",
      "verify:consumers",
    ]);
    expect(stderr.text).toContain("Consumer gate failed at verify:consumers; later repo gates skipped.");
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

  it("keeps every CI matrix leg at the exact documented semantic delta from verify-all", () => {
    expectCiParity(readCiWorkflow());
  });

  it("rejects release argv drift that removes the minimum-version proof", () => {
    const source = readCiWorkflow();
    const original = "        run: pnpm run release:consumer -- --tag \"${{ steps.release-smoke.outputs.tag }}\" --require-minimum";
    const mutated = "        run: pnpm run release:consumer -- --tag \"${{ steps.release-smoke.outputs.tag }}\"";
    const mutatedSource = replaceExactly(source, original, mutated);

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects moving the packed consumer condition to another Node version", () => {
    const source = readCiWorkflow();
    const original = "        if: ${{ matrix.node-version == '22.19.0' }}";
    const mutated = "        if: ${{ matrix.node-version == '24' }}";
    const mutatedSource = replaceExactly(source, original, mutated);

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects shared gate reordering", () => {
    const source = readCiWorkflow();
    const consumer = [
      "      - name: Verify consumer contracts",
      "        run: pnpm run verify:consumers --skip-build",
    ].join("\n");
    const pack = [
      "      - name: Validate package tarballs",
      "        run: pnpm run release:pack -- --tag \"${{ steps.release-smoke.outputs.tag }}\"",
    ].join("\n");
    const mutatedSource = replaceExactly(source, `${consumer}\n\n${pack}`, `${pack}\n\n${consumer}`);

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects stale intentional-delta declarations", () => {
    const source = readCiWorkflow();
    const ciOnlyStep = [
      "      - name: Build demos",
      "        run: pnpm run build:demo",
      "",
    ].join("\n");
    const mutatedSource = replaceExactly(source, ciOnlyStep, "");

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });
});

function expectCiParity(source) {
  const { gates: ciGates, matrixVersions } = parseCiVerifyJob(source);
  const allDeltaEntries = [
    ...VERIFY_GATE_DELTA.ciOnly,
    ...VERIFY_GATE_DELTA.commandDifferences,
    ...VERIFY_GATE_DELTA.matrixDifferences,
  ];
  expect(allDeltaEntries.every((entry) => entry.reason.length > 0)).toBe(true);
  expect(matrixVersions).toContain(MINIMUM_NODE_VERSION);
  expect(matrixVersions.some((version) => version !== MINIMUM_NODE_VERSION)).toBe(true);

  expect(ciGates
    .filter((gate) => gate.condition !== ALWAYS)
    .map((gate) => ({ label: gate.label, condition: gate.condition })))
    .toEqual(VERIFY_GATE_DELTA.matrixDifferences.map((entry) => ({
      label: entry.label,
      condition: entry.ciCondition,
    })));

  for (const nodeVersion of matrixVersions) {
    const actualCiGate = projectCiGate(ciGates, nodeVersion);
    let expectedCiGate = createRepoGate({
      releaseTag: RELEASE_TAG_PLACEHOLDER,
      nodeVersion,
    }).map(toGateDescriptor);

    for (const entry of VERIFY_GATE_DELTA.matrixDifferences) {
      if (nodeVersion !== entry.ciNodeVersion) {
        expectedCiGate = removeExactGate(expectedCiGate, entry.verifyAllOnlyGate, nodeVersion);
      }
    }

    for (const entry of VERIFY_GATE_DELTA.ciOnly) {
      const anchorIndexes = indexesOfLabel(expectedCiGate, entry.after);
      expect(anchorIndexes, `CI-only ${entry.gate.label} anchor on Node ${nodeVersion}`).toHaveLength(1);
      expectedCiGate.splice(anchorIndexes[0] + 1, 0, toGateDescriptor(entry.gate));
    }

    for (const entry of VERIFY_GATE_DELTA.commandDifferences) {
      const indexes = indexesOfLabel(expectedCiGate, entry.label);
      expect(indexes, `command delta ${entry.label} on Node ${nodeVersion}`).toHaveLength(1);
      expect(expectedCiGate[indexes[0]]).toEqual(toGateDescriptor(entry.verifyAll));
      expectedCiGate[indexes[0]] = toGateDescriptor(entry.ci);
    }

    expect(actualCiGate, `CI semantic gate for Node ${nodeVersion}`).toEqual(expectedCiGate);
  }
}

function parseCiVerifyJob(source) {
  const verifyStart = source.indexOf("  verify:\n");
  const websiteStart = source.indexOf("  website:\n", verifyStart);
  if (verifyStart < 0 || websiteStart < 0) {
    throw new Error("ci.yml must contain verify and website jobs.");
  }

  const verifyJob = source.slice(verifyStart, websiteStart);
  const matrixSource = /^        node-version: (\[[^\n]+\])$/mu.exec(verifyJob)?.[1];
  if (matrixSource === undefined) {
    throw new Error("The CI verify job must declare its Node matrix inline.");
  }
  const matrixVersions = JSON.parse(matrixSource);
  if (!Array.isArray(matrixVersions) || !matrixVersions.every((version) => typeof version === "string")) {
    throw new Error("The CI Node matrix must be a string array.");
  }

  const gates = [];
  const steps = verifyJob.split(/^      - name: /mu).slice(1);
  for (const step of steps) {
    const name = step.slice(0, step.indexOf("\n")).trim();
    const commandSource = readRunCommand(step);
    if (commandSource === undefined) {
      continue;
    }
    const condition = /^        if: (.+)$/mu.exec(step)?.[1].trim() ?? ALWAYS;
    const normalizedCommand = normalizeRunCommand(commandSource);
    const gate = classifyGate(normalizedCommand);
    if (gate !== undefined) {
      gates.push({ ...gate, condition });
      continue;
    }

    const environmentStep = ENVIRONMENT_RUN_STEPS.get(name);
    if (environmentStep === undefined) {
      throw new Error(`Unclassified CI run step: ${name}`);
    }
    if (condition !== ALWAYS || normalizedCommand !== environmentStep.command) {
      throw new Error(`Environment step semantics drifted: ${name}`);
    }
    if (environmentStep.id !== undefined && !step.includes(`        id: ${environmentStep.id}\n`)) {
      throw new Error(`Environment step id drifted: ${name}`);
    }
  }

  return { gates, matrixVersions };
}

const ENVIRONMENT_RUN_STEPS = new Map([
  ["Enable Corepack", { command: "corepack enable" }],
  ["Install dependencies", { command: "pnpm install --frozen-lockfile" }],
  ["Derive release smoke tag", {
    id: "release-smoke",
    command: [
      "set -euo pipefail",
      "VERSION=\"$(node -e \"process.stdout.write(require('./packages/agent-app/package.json').version)\")\"",
      "echo \"tag=v${VERSION}\" >> \"$GITHUB_OUTPUT\"",
    ].join("\n"),
  }],
]);

function readRunCommand(step) {
  const lines = step.split("\n");
  const runIndex = lines.findIndex((line) => line.startsWith("        run: "));
  if (runIndex < 0) {
    return undefined;
  }

  const scalar = lines[runIndex].slice("        run: ".length).trim();
  if (scalar !== "|" && scalar !== ">") {
    return scalar;
  }

  const body = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.startsWith("          ")) {
      body.push(line.slice(10));
      continue;
    }
    if (line.length === 0) {
      body.push("");
      continue;
    }
    break;
  }
  while (body.at(-1) === "") {
    body.pop();
  }
  return body.join("\n");
}

function normalizeRunCommand(command) {
  return command
    .replace(/\\\r?\n\s*/gu, " ")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function classifyGate(commandSource) {
  const words = parseShellWords(commandSource.replaceAll("\n", " "));
  if (words[0] === "pnpm" && words[1] === "run" && words[2] !== undefined) {
    return toGateDescriptor({
      label: words[2],
      command: words[0],
      args: words.slice(1),
    });
  }
  if (words[0] === "pnpm" && words[1] === "test") {
    return toGateDescriptor({ label: "test", command: "pnpm", args: words.slice(1) });
  }
  if (words[0] === "git" && words[1] === "diff" && words[2] === "--check" && words.length === 3) {
    return toGateDescriptor({ label: "git diff --check", command: "git", args: words.slice(1) });
  }
  if (words[0] === "docker" && words.some((word) => word.startsWith("ghcr.io/gitleaks/gitleaks:"))) {
    return toGateDescriptor({ label: "check:secrets", command: "docker", args: words.slice(1) });
  }
  return undefined;
}

function parseShellWords(source) {
  const words = [];
  let word = "";
  let quote;
  let escaping = false;

  for (const character of source) {
    if (escaping) {
      word += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (word.length > 0) {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += character;
  }

  if (escaping || quote !== undefined) {
    throw new Error(`Unterminated shell token in: ${source}`);
  }
  if (word.length > 0) {
    words.push(word);
  }
  return words;
}

function projectCiGate(gates, nodeVersion) {
  const projected = [];
  for (const gate of gates) {
    if (gate.condition === ALWAYS) {
      projected.push(toGateDescriptor(gate));
      continue;
    }

    const delta = VERIFY_GATE_DELTA.matrixDifferences.find((entry) => entry.label === gate.label);
    if (delta === undefined || gate.condition !== delta.ciCondition) {
      throw new Error(`Undocumented CI condition for ${gate.label}: ${gate.condition}`);
    }
    if (nodeVersion === delta.ciNodeVersion) {
      projected.push(toGateDescriptor(gate));
    }
  }
  return projected;
}

function removeExactGate(gates, expectedGate, nodeVersion) {
  const normalizedExpected = toGateDescriptor(expectedGate);
  const indexes = gates
    .map((gate, index) => sameGate(gate, normalizedExpected) ? index : -1)
    .filter((index) => index >= 0);
  expect(indexes, `verify-all-only ${expectedGate.label} on Node ${nodeVersion}`).toHaveLength(1);
  return gates.filter((_gate, index) => index !== indexes[0]);
}

function indexesOfLabel(gates, label) {
  return gates
    .map((gate, index) => gate.label === label ? index : -1)
    .filter((index) => index >= 0);
}

function sameGate(left, right) {
  return left.label === right.label
    && left.command === right.command
    && JSON.stringify(left.args) === JSON.stringify(right.args);
}

function toGateDescriptor(gate) {
  return {
    label: gate.label,
    command: gate.command,
    args: [...gate.args].map((arg) => arg === "${{ steps.release-smoke.outputs.tag }}"
      ? RELEASE_TAG_PLACEHOLDER
      : arg),
  };
}

function replaceExactly(source, original, replacement) {
  expect(source.split(original), `mutation fixture: ${original}`).toHaveLength(2);
  return source.replace(original, replacement);
}

function readCiWorkflow() {
  return readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
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
