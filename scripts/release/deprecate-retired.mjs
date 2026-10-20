#!/usr/bin/env node
// Deprecate retired npm package names so installs point at their replacements.
// Run by the manually dispatched "npm deprecate retired" workflow with NPM_TOKEN.
//
//   node scripts/release/deprecate-retired.mjs [--dry-run]
//
// Every replacement must already be published as `latest` before an old name points at it.
// Packages that already carry the exact message are skipped, so reruns are safe.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { packageCatalog } from "../package-catalog.mjs";

export const REGISTRY = "https://registry.npmjs.org/";
const RELEASE_NOTES = "https://github.com/robertsreberski/mono-agent/releases/tag/v0.26.0";
const GENERIC = "No longer maintained. Use the current @mono-agent packages; start with npm create mono-agent.";

/** Old name -> current package that replaces it, retired in the given release. */
const RENAMED = [
  ["@mono-agent/agent-app", "@mono-agent/app"],
  ["@mono-agent/agent-harness", "@mono-agent/conversation"],
  ["@mono-agent/agent-runtime", "@mono-agent/turn"],
  ["@mono-agent/agent-contracts", "@mono-agent/contracts"],
  ["@mono-agent/agent-orchestrator", "@mono-agent/orchestrator"],
  ["@mono-agent/slack-adapter", "@mono-agent/channel-slack"],
  ["@mono-agent/telegram-adapter", "@mono-agent/channel-telegram"],
  ["@mono-agent/openai-api-adapter", "@mono-agent/channel-openai-api"],
  ["@mono-agent/operator-adapter", "@mono-agent/channel-operator"],
  ["@mono-agent/whatsapp-adapter", "@mono-agent/channel-whatsapp"],
  ["@mono-agent/messenger-adapter", "@mono-agent/channel-messenger"],
  ["@mono-agent/a2a-adapter", "@mono-agent/channel-a2a"],
  ["@mono-agent/cron-adapter", "@mono-agent/trigger-cron"],
  ["@mono-agent/webhook-adapter", "@mono-agent/trigger-webhook"],
];

export const RETIRED_PACKAGES = [
  ...RENAMED.map(([name, replacement]) => ({
    name,
    replacement,
    message: `Renamed to ${replacement} in 0.26.0. Install ${replacement} instead: ${RELEASE_NOTES}`,
  })),
  {
    name: "@mono-agent/runtime-adapter",
    replacement: "@mono-agent/turn",
    message: `Folded into @mono-agent/turn (host subpaths) in 0.26.0. Install @mono-agent/turn instead: ${RELEASE_NOTES}`,
  },
  { name: "@mono-agent/tui", replacement: "@mono-agent/app", message: "Retired. Use mono-agent web from @mono-agent/app for live operation." },
  { name: "@mono-agent/session-web", replacement: "@mono-agent/app", message: "Retired. Use mono-agent web or mono-agent runs from @mono-agent/app." },
  { name: "@mono-agent/memory-supermemory", replacement: "@mono-agent/memory", message: "Retired without replacement. Use the built-in memory tiers in @mono-agent/memory." },
  { name: "@mono-agent/memory-bujo", replacement: "@mono-agent/memory", message: "No longer maintained. Use @mono-agent/memory." },
  { name: "@mono-agent/memory-search", replacement: "@mono-agent/memory", message: "No longer maintained. Use @mono-agent/memory." },
  { name: "@mono-agent/memory-store", replacement: "@mono-agent/memory", message: "No longer maintained. Use @mono-agent/memory." },
  ...[
    "memory-mcp",
    "agent-evals",
    "agent-host",
    "context",
    "observability-otel",
    "openai-agents-runtime",
    "operator-console",
    "sandbox",
    "settings",
    "skills",
    "tool-policy",
  ].map((dir) => ({ name: `@mono-agent/${dir}`, replacement: "create-mono-agent", message: GENERIC })),
];

/** Return a list of problems with the retired list against the current catalog. */
export function retiredPackageProblems(retired = RETIRED_PACKAGES, catalog = packageCatalog) {
  const current = new Set(catalog.filter((entry) => entry.publishable).map((entry) => entry.name));
  const problems = [];
  const seen = new Set();
  for (const entry of retired) {
    if (seen.has(entry.name)) problems.push(`${entry.name} is listed twice`);
    seen.add(entry.name);
    if (current.has(entry.name)) problems.push(`${entry.name} is still a publishable catalog package`);
    if (!current.has(entry.replacement)) problems.push(`${entry.name} points at ${entry.replacement}, which is not a publishable catalog package`);
    if (!entry.message.trim() || entry.message.length > 1024) problems.push(`${entry.name} needs a 1-1024 character message`);
  }
  return problems;
}

function npm(args, { allowFailure = false } = {}) {
  const result = spawnSync("npm", [...args, "--registry", REGISTRY], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr || ""}`.split("\n").filter((line) => line.includes("npm error")).slice(0, 3).join("\n");
    throw new Error(`npm ${args[0]} ${args[1] ?? ""} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

function viewField(name, field) {
  const result = npm(["view", name, field, "--json"], { allowFailure: true });
  if (result.status !== 0) return undefined;
  const output = result.stdout.trim();
  return output === "" ? "" : JSON.parse(output);
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const problems = retiredPackageProblems();
  if (problems.length > 0) throw new Error(`retired package list is inconsistent:\n${problems.join("\n")}`);

  for (const replacement of new Set(RETIRED_PACKAGES.map((entry) => entry.replacement))) {
    if (!viewField(replacement, "dist-tags.latest")) throw new Error(`${replacement} has no published latest version`);
  }

  let changed = 0;
  for (const { name, message } of RETIRED_PACKAGES) {
    const current = viewField(name, "deprecated");
    if (current === undefined) throw new Error(`${name} is not on the registry`);
    if (current === message) {
      console.log(`${name}: already deprecated`);
      continue;
    }
    if (dryRun) {
      console.log(`${name}: would deprecate: ${message}`);
      continue;
    }
    npm(["deprecate", name, message]);
    changed += 1;
    console.log(`${name}: deprecated`);
  }
  console.log(dryRun ? "dry run: no registry changes" : `deprecated ${changed} package(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
