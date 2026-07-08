#!/usr/bin/env node
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const userDocRoots = ["AGENTS.md", "README.md", "PACKAGES.md", "docs"];

const monoPackage = (...nameParts) => `@mono-agent/${nameParts.join("-")}`;
const packageDir = (...nameParts) => `packages/${nameParts.join("-")}`;

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function packageReferencePattern(...nameParts) {
  const bareName = nameParts.join("-");
  return new RegExp([
    escapedPattern(monoPackage(...nameParts)),
    `\\b${escapedPattern(packageDir(...nameParts))}\\b`,
    `\\b${escapedPattern(bareName)}\\b`,
  ].join("|"), "iu");
}

function packageSurfacePattern(...nameParts) {
  const bareName = escapedPattern(nameParts.join("-"));
  return new RegExp([
    escapedPattern(monoPackage(...nameParts)),
    `\\b${escapedPattern(packageDir(...nameParts))}\\b`,
    `\\b${bareName}\\s+(?:package|workspace|surface|module)\\b`,
  ].join("|"), "iu");
}

const retiredDocReferences = [
  {
    label: "@mono-agent/agent-evals",
    pattern: /@mono-agent\/agent-evals|\bpackages\/agent-evals\b|\bagent-evals\b/iu,
  },
  {
    label: "demos package",
    pattern: /@mono-agent\/demos|\bpackages\/demos\b|\bdemos\s+(?:package|workspace|surface)\b/iu,
  },
  {
    label: "WhatsApp/A2A in core",
    pattern:
      /\b(?:whatsapp|a2a)(?:(?:\s+and\s+|\/)(?:whatsapp|a2a))?\s+(?:is|are|as)\s+(?:a\s+)?(?:built[- ]in|bundled|core|in[- ]core)\b|\b(?:built[- ]in|bundled|core|in[- ]core)\s+(?:whatsapp|a2a)(?:(?:\s+and\s+|\/)(?:whatsapp|a2a))?\s+(?:channel|adapter|package|surface)s?\b|\b(?:whatsapp|a2a)[-/](?:whatsapp|a2a)-in-core\b/iu,
  },
  {
    label: "@mono-agent/memory-store",
    pattern: /@mono-agent\/memory-store|\bpackages\/memory-store\b|\bmemory-store\b/iu,
  },
  {
    label: "@mono-agent/memory-search",
    pattern: /@mono-agent\/memory-search|\bpackages\/memory-search\b|\bmemory-search\b/iu,
  },
  {
    label: "memory-bujo package",
    pattern:
      /@mono-agent\/memory-bujo|\bpackages\/memory-bujo\b|\bmemory-bujo\b[^\n.]{0,80}\b(?:package|workspace|surface|module)\b|\b(?:package|workspace|surface|module)\b[^\n.]{0,80}\bmemory-bujo\b/iu,
  },
  {
    label: "@mono-agent/observability-otel",
    pattern: /@mono-agent\/observability-otel|\bpackages\/observability-otel\b|\bobservability-otel\b/iu,
  },
  {
    label: "@mono-agent/settings",
    pattern: /@mono-agent\/settings|\bpackages\/settings\b|\bsettings\s+(?:package|workspace|surface|module)\b/iu,
  },
  {
    label: monoPackage("agent", "host"),
    pattern: packageSurfacePattern("agent", "host"),
  },
  {
    label: monoPackage("tui", "adapter"),
    pattern: packageReferencePattern("tui", "adapter"),
  },
  {
    label: monoPackage("live", "adapter"),
    pattern: packageReferencePattern("live", "adapter"),
  },
  {
    label: "NotifyConversation",
    pattern: /\bNotifyConversation\b|\bnotify_conversation\b/iu,
  },
];

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

export async function checkConsumerDocsConsistency(consumerPaths, options = {}) {
  const warnings = [];
  const issues = [];
  let checked = 0;
  let userDocsChecked = 0;

  if (options.scanUserDocs !== false) {
    const repoRoot = resolve(options.repoRoot ?? process.cwd());
    const userDocRecords = options.userDocRecords ?? await readUserDocRecords(repoRoot);
    userDocsChecked = userDocRecords.length;
    issues.push(...scanRetiredDocReferences(userDocRecords));
  }

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

    issues.push(...scanRetiredDocReferences([{ path: readmePath, text: readme }]));

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

  return { checked, userDocsChecked, warnings, issues };
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

async function readUserDocRecords(repoRoot) {
  const records = [];
  for (const relativePath of userDocRoots) {
    const path = join(repoRoot, relativePath);
    if (!(await pathExists(path))) {
      continue;
    }
    const pathStat = await stat(path);
    if (pathStat.isDirectory()) {
      records.push(...await readMarkdownRecords(path));
      continue;
    }
    if (pathStat.isFile() && extname(path) === ".md") {
      records.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return records;
}

async function readMarkdownRecords(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      records.push(...await readMarkdownRecords(path));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".md") {
      records.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return records;
}

function scanRetiredDocReferences(records) {
  const issues = [];
  for (const record of records) {
    for (const retiredReference of retiredDocReferences) {
      for (const match of findPatternMatches(retiredReference.pattern, record.text)) {
        const location = lineAndColumn(record.text, match.index);
        issues.push(
          `${record.path}:${location.line}:${location.column}: references retired pre-v1 surface ` +
            `"${retiredReference.label}". Update the user docs to the current v1 package map.`,
        );
      }
    }
  }
  return issues;
}

function findPatternMatches(pattern, text) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({ index: match.index });
    if (match[0] === "") {
      regex.lastIndex += 1;
    }
  }
  return matches;
}

function lineAndColumn(text, index) {
  const prefix = text.slice(0, index);
  const line = prefix.split("\n").length;
  const lastNewlineIndex = prefix.lastIndexOf("\n");
  const column = lastNewlineIndex === -1 ? index + 1 : index - lastNewlineIndex;
  return { line, column };
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
    `  node ${bin} [--consumer <path> ...]`,
    "",
    "Scans repo user docs (AGENTS.md, README.md, PACKAGES.md, docs/**/*.md) for retired pre-v1 surfaces.",
    "Each optional consumer folder should contain README.md and mono-agent.config.json.",
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
  const result = await checkConsumerDocsConsistency(parsed.consumers, { repoRoot: cliRepoRoot() });
  for (const warning of result.warnings) {
    process.stderr.write(`WARN ${warning}\n`);
  }
  if (result.checked === 0 && result.userDocsChecked === 0) {
    process.stderr.write(
      "ERROR No repo user docs or consumer folders were checked.\n",
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

  process.stdout.write(
    `Repo/consumer docs/config consistency passed for ${result.userDocsChecked} repo doc file(s) ` +
      `and ${result.checked} consumer folder(s).\n`,
  );
}

function cliRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  await main();
}
