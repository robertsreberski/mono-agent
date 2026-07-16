#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runVerifyConsumers } from "./verify-consumers.mjs";

const repoGate = [
  { label: "check:node", command: "pnpm", args: ["run", "check:node"] },
  { label: "check:pnpm-policy", command: "pnpm", args: ["run", "check:pnpm-policy"] },
  { label: "check:secrets", command: "pnpm", args: ["run", "check:secrets"] },
  { label: "check:oss-hygiene", command: "pnpm", args: ["run", "check:oss-hygiene"] },
  { label: "check:licenses", command: "pnpm", args: ["run", "check:licenses"] },
  { label: "check:dependency-vulnerabilities", command: "pnpm", args: ["run", "check:dependency-vulnerabilities"] },
  { label: "check:codex-discoverability", command: "pnpm", args: ["run", "check:codex-discoverability"] },
  { label: "check:architecture", command: "pnpm", args: ["run", "check:architecture"] },
  { label: "build", command: "pnpm", args: ["run", "build"] },
  { label: "typecheck", command: "pnpm", args: ["run", "typecheck"] },
  { label: "test", command: "pnpm", args: ["run", "test"] },
  { label: "test:demo", command: "pnpm", args: ["run", "test:demo"] },
  { label: "git diff --check", command: "git", args: ["diff", "--check"] },
];

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

  let repoOk = true;
  for (const command of repoGate) {
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
    "Runs check:node, check:pnpm-policy, check:secrets, check:oss-hygiene, check:licenses, check:dependency-vulnerabilities, check:codex-discoverability, check:architecture, build, typecheck, test, test:demo, git diff --check, then verify:consumers.",
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
