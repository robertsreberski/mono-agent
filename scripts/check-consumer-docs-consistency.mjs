#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const retiredSurfaces = [
  {
    label: "@mono-agent/memory-mcp",
    readmePattern: /@mono-agent\/memory-mcp|\bmemory-mcp\b/iu,
    exposurePattern: /@mono-agent\/memory-mcp|\bmemory-mcp\b/iu,
  },
  {
    label: "memory_note",
    readmePattern: /\bmemory_note\b/iu,
    exposurePattern: /\bmemory_note\b/iu,
  },
  {
    label: "operator console",
    readmePattern: /@mono-agent\/operator-console|\boperator[ -]console\b/iu,
    exposurePattern: /@mono-agent\/operator-console|\boperator-console\b/iu,
  },
];

export async function checkConsumerDocsConsistency(consumerPaths) {
  const warnings = [];
  const issues = [];
  let checked = 0;

  for (const rawPath of consumerPaths) {
    const consumerDir = resolve(rawPath);
    const readmePath = join(consumerDir, "README.md");
    if (!(await pathExists(readmePath))) {
      warnings.push(`${consumerDir}: README.md missing; skipped.`);
      continue;
    }

    checked += 1;
    const configPath = join(consumerDir, "mono-agent.config.json");
    const readme = await readFile(readmePath, "utf8");
    const config = await readConsumerConfig(configPath, issues);
    if (config === undefined) {
      continue;
    }

    const mcpTexts = await readConfiguredMcpTexts(consumerDir, config);
    const exposureText = [
      JSON.stringify(config),
      ...mcpTexts,
    ].join("\n");

    for (const surface of retiredSurfaces) {
      if (surface.readmePattern.test(readme) && !surface.exposurePattern.test(exposureText)) {
        issues.push(
          `${readmePath}: references retired surface "${surface.label}", but mono-agent.config.json` +
            " and its configured MCP file do not expose it.",
        );
      }
    }
  }

  return { checked, warnings, issues };
}

function parseArgs(argv) {
  const consumers = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, consumers };
    }
    if (arg === "--consumer") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--consumer requires a path.");
      }
      consumers.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false, consumers };
}

async function readConsumerConfig(configPath, issues) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    issues.push(`${configPath}: could not read mono-agent.config.json (${reasonOf(error)}).`);
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    issues.push(`${configPath}: malformed JSON (${reasonOf(error)}).`);
    return undefined;
  }
}

async function readConfiguredMcpTexts(consumerDir, config) {
  const mcpConfigPath = config?.tools?.mcpConfigPath;
  if (typeof mcpConfigPath !== "string" || mcpConfigPath.trim().length === 0) {
    return [];
  }

  const path = resolve(consumerDir, mcpConfigPath);
  try {
    return [await readFile(path, "utf8")];
  } catch {
    return [];
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function usage() {
  const bin = fileURLToPath(import.meta.url);
  return [
    "Usage:",
    `  node ${bin} --consumer <path> [--consumer <path> ...]`,
    "",
    "Each consumer folder should contain README.md and mono-agent.config.json.",
  ].join("\n");
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${reasonOf(error)}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.consumers.length === 0) {
    process.stderr.write(`At least one --consumer path is required.\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const result = await checkConsumerDocsConsistency(parsed.consumers);
  for (const warning of result.warnings) {
    process.stderr.write(`WARN ${warning}\n`);
  }
  if (result.checked === 0) {
    process.stderr.write(
      "ERROR No consumer folders were checked; at least one requested --consumer path must contain README.md.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      process.stderr.write(`ERROR ${issue}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Consumer docs/config consistency passed for ${result.checked} consumer folder(s).\n`);
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  await main();
}
