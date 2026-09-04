#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_AUDIT_REGISTRY_URL,
  collectProductionGraph,
  normalizeBulkAdvisoryReport,
  normalizeProductionGraph,
  queryBulkAdvisories,
  runDependencyVulnerabilityCheck,
} from "./check-dependency-vulnerabilities.mjs";
import {
  ISOLATED_DEPENDENCY_GRAPHS,
  parseNpmLockProductionGraph,
} from "./check-isolated-dependency-vulnerabilities.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEPENDENCY_AUDIT_GRAPHS = Object.freeze([
  Object.freeze({
    kind: "pnpm",
    label: "workspace",
    cwd: ".",
    dispositions: "scripts/dependency-vulnerability-dispositions.json",
    isolated: false,
  }),
  ...ISOLATED_DEPENDENCY_GRAPHS.map((graph) => Object.freeze({
    ...graph,
    isolated: true,
  })),
]);

export function mergeProductionInventories(productionGraphs) {
  const versionsByPackage = new Map();
  for (const productionGraph of productionGraphs) {
    const inventory = normalizeProductionGraph(productionGraph).inventory;
    for (const [packageName, versions] of Object.entries(inventory)) {
      const mergedVersions = versionsByPackage.get(packageName) ?? new Set();
      for (const version of versions) mergedVersions.add(version);
      versionsByPackage.set(packageName, mergedVersions);
    }
  }
  return Object.fromEntries(
    [...versionsByPackage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([packageName, versions]) => [packageName, [...versions].sort()]),
  );
}

export function filterBulkAdvisoryReport(report, inventory) {
  // npm reports an advisory when any submitted exact version is vulnerable.
  // Keep that advisory for every graph containing the package: when graphs use
  // different versions this can over-fail, but it cannot hide a vulnerability.
  return Object.fromEntries(
    Object.entries(report).filter(([packageName]) => Object.hasOwn(inventory, packageName)),
  );
}

export async function runAllDependencyVulnerabilityChecks(options = {}) {
  const root = resolve(options.repoRoot ?? repoRoot);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const read = options.readFile ?? readFile;
  const collectGraph = options.collectGraph ?? collectProductionGraph;
  const queryAdvisories = options.queryAdvisories ?? queryBulkAdvisories;
  const runCheck = options.runCheck ?? runDependencyVulnerabilityCheck;
  const graphs = options.graphs ?? DEPENDENCY_AUDIT_GRAPHS;
  const prepared = [];

  try {
    for (const graph of graphs) {
      const productionGraph = graph.kind === "npm-lock"
        ? parseNpmLockProductionGraph(await read(resolve(root, graph.lockfile), "utf8"))
        : await collectGraph({
          cwd: resolve(root, graph.cwd),
          rootPackageNames: graph.rootPackageNames,
          pnpmCommand: options.pnpmCommand,
          runCommand: options.runCommand,
        });
      prepared.push({ graph, productionGraph });
    }
  } catch (error) {
    stderr.write(`dependency vulnerability check: FAILED — ${reasonOf(error)}\n`);
    return { exitCode: 1 };
  }

  const inventory = mergeProductionInventories(prepared.map(({ productionGraph }) => productionGraph));
  let sharedReport;
  try {
    const report = await queryAdvisories(inventory, {
      registryUrl: options.registryUrl
        ?? process.env.MONO_AGENT_DEPENDENCY_AUDIT_REGISTRY
        ?? DEFAULT_AUDIT_REGISTRY_URL,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      transientRetries: options.transientRetries,
      retryDelayMs: options.retryDelayMs,
    });
    sharedReport = normalizeBulkAdvisoryReport(report, inventory);
  } catch (error) {
    stderr.write(`dependency vulnerability check: FAILED — ${reasonOf(error)}\n`);
    return { exitCode: 1 };
  }

  let exitCode = 0;
  for (const { graph, productionGraph } of prepared) {
    if (graph.isolated) {
      stdout.write(`Auditing isolated ${graph.label} production graph.\n`);
    }
    const result = await runCheck({
      cwd: resolve(root, graph.cwd),
      productionGraph,
      dispositionsPath: resolve(root, graph.dispositions),
      stdout,
      stderr,
      rootPackageNames: graph.rootPackageNames,
      pnpmCommand: options.pnpmCommand,
      runCommand: options.runCommand,
      queryAdvisories: async (graphInventory) => filterBulkAdvisoryReport(
        sharedReport,
        graphInventory,
      ),
    });
    if (result.exitCode !== 0) exitCode = 1;
  }
  return { exitCode };
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  const result = await runAllDependencyVulnerabilityChecks();
  process.exitCode = result.exitCode;
}
