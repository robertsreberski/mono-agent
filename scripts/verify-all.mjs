#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MINIMUM_NODE_VERSION } from "./node-version.mjs";
import { runVerifyConsumers } from "./verify-consumers.mjs";

/**
 * Raw command-list differences from the CI verify job.
 *
 * The shared order and these exact labels are checked against ci.yml by
 * scripts/__tests__/verify-all.test.mjs. Setup, the Node matrix, the pinned
 * gitleaks container, and the separate website job are execution-environment
 * differences rather than repo-gate commands.
 */
export const VERIFY_GATE_DELTA = Object.freeze({
  ciOnly: Object.freeze([
    Object.freeze({
      label: "build:demo",
      reason: "CI repeats the demo build already included by the root build command; removal is tracked by #284.",
    }),
    Object.freeze({
      label: "typecheck:demo",
      reason: "CI repeats the demo typecheck already included by the root typecheck command; removal is tracked by #284.",
    }),
  ]),
  verifyAllOnly: Object.freeze([
    Object.freeze({
      label: "verify:consumers",
      reason: "The local aggregate gate checks golden consumer contracts; adding the same CI step is tracked by #270.",
    }),
  ]),
});

export function createRepoGate({ releaseTag, nodeVersion = process.versions.node }) {
  const packedConsumerArgs = ["run", "release:consumer", "--", "--tag", releaseTag];
  if (nodeVersion === MINIMUM_NODE_VERSION) {
    packedConsumerArgs.push("--require-minimum");
  }

  return [
    { label: "check:node", command: "pnpm", args: ["run", "check:node"] },
    { label: "check:pnpm-policy", command: "pnpm", args: ["run", "check:pnpm-policy"] },
    { label: "check:secrets", command: "pnpm", args: ["run", "check:secrets"] },
    { label: "check:oss-hygiene", command: "pnpm", args: ["run", "check:oss-hygiene"] },
    { label: "check:licenses", command: "pnpm", args: ["run", "check:licenses"] },
    {
      label: "check:dependency-vulnerabilities",
      command: "pnpm",
      args: ["run", "check:dependency-vulnerabilities"],
    },
    { label: "check:codex-discoverability", command: "pnpm", args: ["run", "check:codex-discoverability"] },
    { label: "release:validate", command: "pnpm", args: ["run", "release:validate", "--", "--tag", releaseTag] },
    { label: "check:architecture", command: "pnpm", args: ["run", "check:architecture"] },
    { label: "build", command: "pnpm", args: ["run", "build"] },
    { label: "release:pack", command: "pnpm", args: ["run", "release:pack", "--", "--tag", releaseTag] },
    { label: "release:consumer", command: "pnpm", args: packedConsumerArgs },
    { label: "typecheck", command: "pnpm", args: ["run", "typecheck"] },
    { label: "test", command: "pnpm", args: ["run", "test"] },
    { label: "test:demo", command: "pnpm", args: ["run", "test:demo"] },
    { label: "git diff --check", command: "git", args: ["diff", "--check"] },
  ];
}

export function readReleaseSmokeTag(cwd, readFile = readFileSync) {
  const manifest = JSON.parse(readFile(resolve(cwd, "packages/agent-app/package.json"), "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("packages/agent-app/package.json must contain a version for release smoke checks.");
  }
  return `v${manifest.version}`;
}

export function parseVerifyAllArgs(argv) {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false };
}

export async function runVerifyAll(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandStdio;
  const verifyConsumers = options.verifyConsumers ?? runVerifyConsumers;

  let parsed;
  try {
    parsed = parseVerifyAllArgs(argv);
  } catch (error) {
    stderr.write(`${reasonOf(error)}\n\n${usage()}\n`);
    stdout.write(renderFinalSummary({ repoOk: false, alphaOk: false, betaOk: false }));
    return { exitCode: 1 };
  }

  if (parsed.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0 };
  }

  const releaseTag = options.releaseTag ?? readReleaseSmokeTag(cwd);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  let repoOk = true;
  for (const command of createRepoGate({ releaseTag, nodeVersion })) {
    const result = await runCommand(command.command, command.args, { cwd, label: command.label });
    if (result !== 0) {
      repoOk = false;
      stderr.write(`Repo gate failed at ${command.label}.\n`);
      break;
    }
  }

  let alphaOk = false;
  let betaOk = false;
  if (repoOk) {
    const consumerResult = await verifyConsumers({
      argv: ["--skip-build"],
      cwd,
      stdout,
      stderr,
      runCommand,
      writeOutput: true,
    });
    alphaOk = consumerResult.statusByLabel.get("local-agent-alpha contract") === true;
    betaOk = consumerResult.statusByLabel.get("local-agent-beta contract") === true;
  } else {
    stderr.write("Consumer verification skipped because the repo gate is not green.\n");
  }

  stdout.write(renderFinalSummary({ repoOk, alphaOk, betaOk }));
  return {
    exitCode: repoOk && alphaOk && betaOk ? 0 : 1,
  };
}

export function renderFinalSummary(input) {
  return [
    "final summary",
    `repo ${input.repoOk ? "ok" : "fail"}`,
    `local-agent-alpha contract ${input.alphaOk ? "ok" : "fail"}`,
    `local-agent-beta contract ${input.betaOk ? "ok" : "fail"}`,
    `repo ${input.repoOk ? "green" : "failed"}`,
    `local-agent-alpha contract ${input.alphaOk ? "green" : "failed"}`,
    `local-agent-beta contract ${input.betaOk ? "green" : "failed"}`,
  ].join("\n") + "\n";
}

async function runCommandStdio(command, args, options) {
  return await new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
    });
    child.on("error", () => resolveExit(1));
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}

function usage() {
  return [
    "Usage:",
    "  pnpm run verify:all",
    "",
    "Runs the CI-aligned repo gate, including pnpm and dependency-vulnerability policy checks, release validation, package packing, and a packed-consumer smoke test, then verify:consumers.",
  ].join("\n");
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runVerifyAll();
  process.exitCode = result.exitCode;
}
