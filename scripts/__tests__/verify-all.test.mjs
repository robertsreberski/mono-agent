import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { Scalar, isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

import { MINIMUM_NODE_VERSION } from "../node-version.mjs";
import {
  VERIFY_GATE_DELTA,
  createRepoGate,
  readReleaseSmokeTag,
  runVerifyAll,
} from "../verify-all.mjs";

const RELEASE_TAG_PLACEHOLDER = "<release-tag>";
const ALWAYS = "always";
const CI_CHECKOUT_STEP = [
  "      - name: Checkout",
  "        uses: actions/checkout@v4",
].join("\n");
const CI_SETUP_NODE_STEP = [
  "      - name: Setup Node",
  "        uses: actions/setup-node@v4",
  "        with:",
  "          node-version: \"${{ matrix.node-version }}\"",
].join("\n");
const CI_ACTION_SEQUENCE = `${CI_CHECKOUT_STEP}\n\n${CI_SETUP_NODE_STEP}`;

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
    expect(stderr.text).toBe("Consumer gate failed at verify:consumers; later repo gates skipped.\n");
    expect(stdout.text).toBe([
      "final summary",
      "repo fail",
      "local-agent-alpha contract ok",
      "local-agent-beta contract fail",
      "repo failed",
      "local-agent-alpha contract green",
      "local-agent-beta contract failed",
      "",
    ].join("\n"));
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

  it("rejects executable gate steps that omit a display name", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const unnamedDuplicate = "      - run: pnpm run check:architecture";
    const mutatedSource = replaceExactly(
      source,
      architecture,
      `${architecture}\n\n${unnamedDuplicate}`,
    );

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("reads quoted keys, spaced colons, and dash-alone step mappings semantically", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const alternateYaml = [
      "      -",
      "        \"name\" : Check package architecture",
      "        \"run\" : \"pnpm run check:architecture\"",
    ].join("\n");

    expectCiParity(replaceExactly(source, architecture, alternateYaml));
  });

  it("rejects extra dash-alone steps with quoted execution keys", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const hiddenDuplicate = [
      "      -",
      "        \"run\" : pnpm run check:architecture",
    ].join("\n");
    const mutatedSource = replaceExactly(
      source,
      architecture,
      `${architecture}\n\n${hiddenDuplicate}`,
    );

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects alternate YAML spellings of hidden with, if, and continue-on-error fields", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const mutations = [
      [
        "      - name: Check package architecture",
        "        \"with\" :",
        "          cache: pnpm",
        "        run: pnpm run check:architecture",
      ].join("\n"),
      [
        "      - name: Check package architecture",
        "        \"if\" : ${{ github.ref == 'refs/heads/main' }}",
        "        run: pnpm run check:architecture",
      ].join("\n"),
      [
        "      - name: Check package architecture",
        "        \"continue-on-error\" : true",
        "        run: pnpm run check:architecture",
      ].join("\n"),
    ];

    for (const mutation of mutations) {
      const mutatedSource = replaceExactly(source, architecture, mutation);
      expect(() => expectCiParity(mutatedSource)).toThrow();
    }
  });

  it("rejects YAML aliases, merge keys, and duplicate semantic keys", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const anchoredAlias = [
      "      - &architecture-step",
      "        name: Check package architecture",
      "        run: pnpm run check:architecture",
      "      - *architecture-step",
    ].join("\n");
    const mergeKey = [
      "      - name: Check package architecture",
      "        <<: { continue-on-error: true }",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const duplicateKey = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
      "        \"run\" : pnpm run typecheck",
    ].join("\n");

    expect(() => parseCiVerifyJob(replaceExactly(source, architecture, anchoredAlias)))
      .toThrow(/YAML anchors|YAML aliases/u);
    expect(() => parseCiVerifyJob(replaceExactly(source, architecture, mergeKey)))
      .toThrow(/YAML merge keys|strict YAML/u);
    expect(() => parseCiVerifyJob(replaceExactly(source, architecture, duplicateKey)))
      .toThrow(/strict YAML|Duplicate YAML field/u);
  });

  it("rejects unmodeled execution fields on the workflow and verify job", () => {
    const source = readCiWorkflow();
    const jobOriginal = [
      "    timeout-minutes: 60",
      "    strategy:",
    ].join("\n");
    const jobDefaults = [
      "    timeout-minutes: 60",
      "    \"defaults\" : { run: { shell: bash } }",
      "    strategy:",
    ].join("\n");
    const workflowOriginal = [
      "permissions:",
      "  contents: read",
      "",
      "concurrency:",
    ].join("\n");
    const workflowDefaults = [
      "permissions:",
      "  contents: read",
      "",
      "\"defaults\" : { run: { shell: bash } }",
      "",
      "concurrency:",
    ].join("\n");

    expect(() => parseCiVerifyJob(replaceExactly(source, jobOriginal, jobDefaults)))
      .toThrow(/Unsupported CI verify job field/u);
    expect(() => parseCiVerifyJob(replaceExactly(source, workflowOriginal, workflowDefaults)))
      .toThrow(/Unsupported CI workflow field/u);
  });

  it("treats display names as non-semantic metadata", () => {
    const source = readCiWorkflow();
    const actionsRenamed = replaceExactly(
      source,
      CI_ACTION_SEQUENCE,
      CI_ACTION_SEQUENCE
        .replace("name: Checkout", "name: Renamed checkout display")
        .replace("name: Setup Node", "name: Renamed setup display"),
    );
    const mutatedSource = replaceExactly(
      actionsRenamed,
      "      - name: Check package architecture",
      "      - name: Renamed architecture display",
    );

    expectCiParity(mutatedSource);
  });

  it("rejects replaced or unknown CI actions", () => {
    const source = readCiWorkflow();
    const replacedSetup = replaceExactly(
      source,
      CI_ACTION_SEQUENCE,
      CI_ACTION_SEQUENCE.replace("actions/setup-node@v4", "example.invalid/reviewer-setup@v1"),
    );
    const unknownAction = "      - uses: example.invalid/reviewer-action@v1";
    const insertedUnknown = replaceExactly(
      source,
      CI_SETUP_NODE_STEP,
      `${CI_SETUP_NODE_STEP}\n\n${unknownAction}`,
    );

    expect(() => parseCiVerifyJob(replacedSetup)).toThrow(/Unclassified CI action step/u);
    expect(() => parseCiVerifyJob(insertedUnknown)).toThrow(/Unclassified CI action step/u);
  });

  it("rejects setup-node input drift and unmodeled nested inputs", () => {
    const source = readCiWorkflow();
    const matrixInput = "          node-version: \"${{ matrix.node-version }}\"";
    const fixedVersion = replaceExactly(source, matrixInput, "          node-version: 20");
    const missingVersion = replaceExactly(source, `${matrixInput}\n`, "");
    const extraCacheInput = replaceExactly(
      source,
      matrixInput,
      `${matrixInput}\n          cache: pnpm`,
    );

    expect(() => parseCiVerifyJob(fixedVersion)).toThrow(/CI action inputs drifted: Node setup/u);
    expect(() => parseCiVerifyJob(missingVersion)).toThrow(/CI action inputs drifted: Node setup/u);
    expect(() => parseCiVerifyJob(extraCacheInput)).toThrow(/CI action inputs drifted: Node setup/u);
  });

  it("rejects missing and duplicated required CI actions", () => {
    const source = readCiWorkflow();
    const missingSetup = replaceExactly(source, `${CI_SETUP_NODE_STEP}\n\n`, "");
    const duplicateCheckout = replaceExactly(
      source,
      CI_ACTION_SEQUENCE,
      `${CI_CHECKOUT_STEP}\n\n${CI_ACTION_SEQUENCE}`,
    );

    expect(() => parseCiVerifyJob(missingSetup)).toThrow();
    expect(() => parseCiVerifyJob(duplicateCheckout)).toThrow();
  });

  it("rejects CI action reordering and movement past run steps", () => {
    const source = readCiWorkflow();
    const reordered = replaceExactly(
      source,
      CI_ACTION_SEQUENCE,
      `${CI_SETUP_NODE_STEP}\n\n${CI_CHECKOUT_STEP}`,
    );
    const corepackStep = [
      "      - name: Enable Corepack",
      "        run: corepack enable",
    ].join("\n");
    const movedPastCorepack = replaceExactly(
      source,
      `${CI_ACTION_SEQUENCE}\n\n${corepackStep}`,
      `${CI_CHECKOUT_STEP}\n\n${corepackStep}\n\n${CI_SETUP_NODE_STEP}`,
    );

    expect(() => parseCiVerifyJob(reordered)).toThrow(/must remain at verify-step position/u);
    expect(() => parseCiVerifyJob(movedPastCorepack)).toThrow(/must remain at verify-step position/u);
  });

  it("rejects folded run blocks that change release-tag shell semantics", () => {
    const source = readCiWorkflow();
    const original = [
      "      - name: Derive release smoke tag",
      "        id: release-smoke",
      "        run: |",
    ].join("\n");
    const folded = original.replace("run: |", "run: >");
    const mutatedSource = replaceExactly(source, original, folded);

    expect(() => expectCiParity(mutatedSource)).toThrow(/Folded CI run blocks are not supported/u);
  });

  it("rejects continue-on-error on a deciding gate", () => {
    const source = readCiWorkflow();
    const original = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const continued = [
      "      - name: Check package architecture",
      "        continue-on-error: true",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const mutatedSource = replaceExactly(source, original, continued);

    expect(() => expectCiParity(mutatedSource)).toThrow(/must fail fast/u);
  });

  it("rejects unknown named and unnamed executable steps", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const unknownSteps = [
      [
        "      - name: Undeclared executable",
        "        run: echo unexpected",
      ].join("\n"),
      "      - run: echo unexpected",
    ];

    for (const unknownStep of unknownSteps) {
      const mutatedSource = replaceExactly(source, architecture, `${architecture}\n\n${unknownStep}`);
      expect(() => parseCiVerifyJob(mutatedSource)).toThrow(/Unclassified CI run step/u);
    }
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
  const document = parseDocument(source, {
    keepSourceTokens: true,
    merge: false,
    prettyErrors: false,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  const parseProblems = [...document.errors, ...document.warnings];
  if (parseProblems.length > 0) {
    throw new Error(`ci.yml must be strict YAML: ${parseProblems.map((problem) => problem.message).join("; ")}`);
  }

  const root = requireYamlMap(document.contents, "ci.yml root");
  assertNoYamlIndirection(root, "ci.yml");
  const rootFields = readYamlMap(root, "ci.yml root");
  assertExactMapFields(rootFields, ["name", "on", "permissions", "concurrency", "jobs"], "CI workflow");
  const jobs = requireMapField(rootFields, "jobs", "ci.yml root");
  const jobFields = readYamlMap(jobs, "ci.yml jobs");
  assertExactMapFields(jobFields, ["verify", "website"], "CI workflow jobs");
  const verifyJob = requireMapField(jobFields, "verify", "ci.yml jobs");
  requireYamlMap(jobFields.get("website"), "ci.yml website job");

  const verifyFields = readYamlMap(verifyJob, "CI verify job");
  assertExactMapFields(
    verifyFields,
    ["name", "runs-on", "timeout-minutes", "strategy", "steps"],
    "CI verify job",
  );
  requireStringField(verifyFields, "name", "CI verify job");
  if (requireScalarField(verifyFields, "runs-on", "CI verify job") !== "ubuntu-latest") {
    throw new Error("The CI verify job must run on ubuntu-latest.");
  }
  if (requireScalarField(verifyFields, "timeout-minutes", "CI verify job") !== 60) {
    throw new Error("The CI verify job timeout must remain 60 minutes.");
  }

  const strategy = requireMapField(verifyFields, "strategy", "CI verify job");
  const strategyFields = readYamlMap(strategy, "CI verify strategy");
  assertExactMapFields(strategyFields, ["fail-fast", "matrix"], "CI verify strategy");
  if (requireScalarField(strategyFields, "fail-fast", "CI verify strategy") !== false) {
    throw new Error("The CI verify matrix must keep fail-fast disabled so every Node leg reports.");
  }
  const matrix = requireMapField(strategyFields, "matrix", "CI verify strategy");
  const matrixFields = readYamlMap(matrix, "CI verify matrix");
  assertExactMapFields(matrixFields, ["node-version"], "CI verify matrix");
  const nodeVersions = requireYamlSeq(matrixFields.get("node-version"), "CI Node matrix");
  const matrixVersions = nodeVersions.items.map((node, index) => (
    requireYamlString(node, `CI Node matrix item ${index + 1}`)
  ));
  if (matrixVersions.length === 0 || new Set(matrixVersions).size !== matrixVersions.length) {
    throw new Error("The CI Node matrix must be a non-empty unique string array.");
  }

  const steps = requireYamlSeq(verifyFields.get("steps"), "CI verify steps").items;
  if (steps.length === 0) {
    throw new Error("The CI verify job must contain at least one step.");
  }

  const gates = [];
  const environmentCounts = new Map(ENVIRONMENT_RUN_STEPS.map((step) => [step.key, 0]));
  const actionCounts = new Map(ACTION_STEPS.map((step) => [step.key, 0]));
  const actionOrder = [];
  for (const [stepIndex, stepNode] of steps.entries()) {
    const step = requireYamlMap(stepNode, `CI verify step ${stepIndex + 1}`);
    const fields = readYamlMap(step, `CI verify step ${stepIndex + 1}`);
    const name = optionalStringField(fields, "name", `CI verify step ${stepIndex + 1}`) ?? "<unnamed>";
    const continueOnError = fields.get("continue-on-error");
    if (continueOnError !== undefined && (!isScalar(continueOnError) || continueOnError.value !== false)) {
      throw new Error(`CI step must fail fast: ${name}`);
    }

    const hasRun = fields.has("run");
    const hasUses = fields.has("uses");
    if (hasRun === hasUses) {
      throw new Error(`CI step must declare exactly one of run or uses: ${name}`);
    }

    if (hasUses) {
      assertOnlyStepFields(fields, USES_STEP_FIELDS, name);
      const uses = requireStringField(fields, "uses", `CI action step ${name}`);
      const actionStep = ACTION_STEPS.find((candidate) => candidate.uses === uses);
      if (actionStep === undefined) {
        throw new Error(`Unclassified CI action step: ${uses}`);
      }
      if (stepIndex !== actionStep.position) {
        throw new Error(`${actionStep.key} action must remain at verify-step position ${actionStep.position + 1}.`);
      }
      const condition = optionalStringField(fields, "if", `CI action step ${name}`) ?? ALWAYS;
      if (condition !== ALWAYS) {
        throw new Error(`CI action condition drifted: ${actionStep.key}`);
      }
      const id = optionalStringField(fields, "id", `CI action step ${name}`);
      if (id !== actionStep.id) {
        throw new Error(`CI action id drifted: ${actionStep.key}`);
      }
      let withInputs;
      try {
        withInputs = parseWithInputs(fields.get("with"), name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`CI action inputs drifted: ${actionStep.key} (${reason})`);
      }
      if (!sameStringRecord(withInputs, actionStep.withInputs)) {
        throw new Error(`CI action inputs drifted: ${actionStep.key}`);
      }
      actionCounts.set(actionStep.key, actionCounts.get(actionStep.key) + 1);
      actionOrder.push(actionStep.key);
      continue;
    }

    assertOnlyStepFields(fields, RUN_STEP_FIELDS, name);
    const condition = optionalStringField(fields, "if", `CI run step ${name}`) ?? ALWAYS;
    const run = readRunCommand(fields.get("run"), name);
    const normalizedCommand = normalizeRunCommand(run.command);
    const environmentStep = ENVIRONMENT_RUN_STEPS.find((candidate) => (
      candidate.command === normalizedCommand && candidate.style === run.style
    ));
    if (environmentStep !== undefined) {
      if (condition !== ALWAYS) {
        throw new Error(`Environment step condition drifted: ${name}`);
      }
      const id = optionalStringField(fields, "id", `CI environment step ${name}`);
      if (id !== environmentStep.id) {
        throw new Error(`Environment step id drifted: ${name}`);
      }
      environmentCounts.set(environmentStep.key, environmentCounts.get(environmentStep.key) + 1);
      continue;
    }

    const gate = classifyGate(normalizedCommand);
    if (gate === undefined) {
      throw new Error(`Unclassified CI run step: ${name}`);
    }
    if (fields.has("id")) {
      throw new Error(`Gate step id drifted: ${name}`);
    }
    gates.push({ ...gate, condition });
  }

  for (const environmentStep of ENVIRONMENT_RUN_STEPS) {
    const count = environmentCounts.get(environmentStep.key);
    if (count !== 1) {
      throw new Error(`Expected exactly one ${environmentStep.key} environment step; found ${count}.`);
    }
  }
  for (const actionStep of ACTION_STEPS) {
    const count = actionCounts.get(actionStep.key);
    if (count !== 1) {
      throw new Error(`Expected exactly one ${actionStep.key} action; found ${count}.`);
    }
  }
  if (JSON.stringify(actionOrder) !== JSON.stringify(ACTION_STEPS.map((step) => step.key))) {
    throw new Error(`CI action order drifted: ${actionOrder.join(", ")}`);
  }

  return { gates, matrixVersions };
}

const RUN_STEP_FIELDS = new Set(["name", "id", "if", "continue-on-error", "run"]);
const USES_STEP_FIELDS = new Set(["name", "id", "if", "continue-on-error", "uses", "with"]);

const ACTION_STEPS = Object.freeze([
  Object.freeze({
    key: "checkout",
    position: 0,
    uses: "actions/checkout@v4",
    withInputs: Object.freeze({}),
  }),
  Object.freeze({
    key: "Node setup",
    position: 1,
    uses: "actions/setup-node@v4",
    withInputs: Object.freeze({
      "node-version": "${{ matrix.node-version }}",
    }),
  }),
]);

const ENVIRONMENT_RUN_STEPS = Object.freeze([
  Object.freeze({ key: "corepack setup", command: "corepack enable", style: "scalar" }),
  Object.freeze({ key: "dependency install", command: "pnpm install --frozen-lockfile", style: "scalar" }),
  Object.freeze({
    key: "release-tag derivation",
    id: "release-smoke",
    style: "literal",
    command: [
      "set -euo pipefail",
      "VERSION=\"$(node -e \"process.stdout.write(require('./packages/agent-app/package.json').version)\")\"",
      "echo \"tag=v${VERSION}\" >> \"$GITHUB_OUTPUT\"",
    ].join("\n"),
  }),
]);

function assertNoYamlIndirection(node, context) {
  if (node === null || node === undefined) {
    return;
  }
  if (isAlias(node)) {
    throw new Error(`YAML aliases are not allowed in the CI parity contract: ${context}`);
  }
  if (node.anchor !== undefined) {
    throw new Error(`YAML anchors are not allowed in the CI parity contract: ${context}`);
  }
  if (node.tag !== undefined) {
    throw new Error(`Explicit YAML tags are not allowed in the CI parity contract: ${context}`);
  }
  if (isScalar(node)) {
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        throw new Error(`YAML merge keys are not allowed in the CI parity contract: ${context}`);
      }
      assertNoYamlIndirection(pair.key, `${context} key`);
      assertNoYamlIndirection(pair.value, `${context}.${String(isScalar(pair.key) ? pair.key.value : "<key>")}`);
    }
    return;
  }
  if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      assertNoYamlIndirection(item, `${context}[${index}]`);
    }
    return;
  }
  throw new Error(`Unsupported YAML node in CI parity contract: ${context}`);
}

function requireYamlMap(node, context) {
  if (!isMap(node)) {
    throw new Error(`${context} must be a mapping.`);
  }
  return node;
}

function requireYamlSeq(node, context) {
  if (!isSeq(node)) {
    throw new Error(`${context} must be a sequence.`);
  }
  return node;
}

function requireYamlString(node, context) {
  if (!isScalar(node) || typeof node.value !== "string") {
    throw new Error(`${context} must be a string scalar.`);
  }
  return node.value;
}

function readYamlMap(node, context) {
  const fields = new Map();
  for (const pair of requireYamlMap(node, context).items) {
    const key = requireYamlString(pair.key, `${context} key`);
    if (key === "<<") {
      throw new Error(`YAML merge keys are not allowed in the CI parity contract: ${context}`);
    }
    if (fields.has(key)) {
      throw new Error(`Duplicate YAML field ${key}: ${context}`);
    }
    fields.set(key, pair.value);
  }
  return fields;
}

function requireMapField(fields, key, context) {
  return requireYamlMap(fields.get(key), `${context}.${key}`);
}

function requireScalarField(fields, key, context) {
  const node = fields.get(key);
  if (!isScalar(node)) {
    throw new Error(`${context}.${key} must be a scalar.`);
  }
  return node.value;
}

function requireStringField(fields, key, context) {
  return requireYamlString(fields.get(key), `${context}.${key}`);
}

function optionalStringField(fields, key, context) {
  return fields.has(key) ? requireStringField(fields, key, context) : undefined;
}

function assertExactMapFields(fields, expectedKeys, context) {
  const expected = new Set(expectedKeys);
  for (const key of fields.keys()) {
    if (!expected.has(key)) {
      throw new Error(`Unsupported ${context} field: ${key}`);
    }
  }
  for (const key of expected) {
    if (!fields.has(key)) {
      throw new Error(`Missing ${context} field: ${key}`);
    }
  }
}

function assertOnlyStepFields(fields, allowedFields, name) {
  for (const field of fields.keys()) {
    if (!allowedFields.has(field)) {
      throw new Error(`Unsupported execution field ${field} on CI step: ${name}`);
    }
  }
}

function parseWithInputs(withNode, name) {
  if (withNode === undefined) {
    return {};
  }
  const inputs = {};
  for (const [key, valueNode] of readYamlMap(withNode, `CI action inputs on ${name}`)) {
    inputs[key] = requireYamlString(valueNode, `${key} on ${name}`);
  }
  return inputs;
}

function sameStringRecord(left, right) {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function readRunCommand(runNode, name) {
  const command = requireYamlString(runNode, `run on ${name}`);
  if (runNode.type === Scalar.BLOCK_FOLDED) {
    throw new Error("Folded CI run blocks are not supported because they change shell command boundaries.");
  }
  if (command.length === 0) {
    throw new Error("CI run steps must contain a command.");
  }
  if (runNode.type === Scalar.BLOCK_LITERAL) {
    const header = runNode.srcToken?.type === "block-scalar"
      ? runNode.srcToken.props.find((token) => token.type === "block-scalar-header")?.source
      : undefined;
    if (header !== "|") {
      throw new Error(`Unsupported literal CI run-block modifier: ${header ?? "<unknown>"}`);
    }
    return { command, style: "literal" };
  }
  if (![Scalar.PLAIN, Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE].includes(runNode.type)) {
    throw new Error(`Unsupported CI run scalar style: ${runNode.type ?? "<unknown>"}`);
  }
  return { command, style: "scalar" };
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
