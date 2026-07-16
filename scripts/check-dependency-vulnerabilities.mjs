#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packageCatalog } from "./package-catalog.mjs";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TEMPORARY_ACCEPTANCE_DAYS = 90;
const DATE_ONLY_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const SEVERITY_RANK = Object.freeze({ low: 0, moderate: 1, high: 2, critical: 3 });
const DEFAULT_ROOT_PACKAGE_NAMES = packageCatalog
  .filter((entry) => entry.publishable === true)
  .map((entry) => entry.name)
  .sort();

export const DEFAULT_AUDIT_REGISTRY_URL = "https://registry.npmjs.org/";
export const DEFAULT_DISPOSITIONS_PATH = fileURLToPath(
  new URL("./dependency-vulnerability-dispositions.json", import.meta.url),
);

export function parsePnpmProductionInventory(source) {
  // `pnpm list --prod --recursive --depth Infinity --parseable` reads the full
  // lockfile graph, including skipped platform optionals, without materializing
  // the deeply duplicated JSON tree. Workspace links do not live in `.pnpm/`
  // and are deliberately excluded from the registry advisory request.
  const inventory = {};
  for (const rawPath of source.split(/\r?\n/u)) {
    const packagePath = rawPath.trim();
    if (packagePath.length === 0 || !packagePath.replaceAll("\\", "/").includes("/node_modules/.pnpm/")) {
      continue;
    }
    const { name, version } = parseVirtualStorePackagePath(packagePath);
    inventory[name] ??= [];
    inventory[name].push(version);
  }
  return normalizeInventory(inventory);
}

export function parsePnpmWhyDependencyPaths(source, options) {
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(`pnpm why output was not valid JSON: ${reasonOf(error)}`);
  }
  if (!Array.isArray(document)) {
    throw new Error("pnpm why output must be an array of workspace roots.");
  }
  const packageName = options?.packageName;
  const versions = options?.versions;
  if (typeof packageName !== "string" || packageName.length === 0 || !Array.isArray(versions)
    || versions.length === 0) {
    throw new Error("pnpm why path parsing requires a package name and versions.");
  }
  const targetVersions = new Set(versions);
  const rootPackageNames = new Set(normalizeRootPackageNames(
    options.rootPackageNames ?? DEFAULT_ROOT_PACKAGE_NAMES,
  ));
  const dependencyPaths = {};
  for (const root of document) {
    if (!isRecord(root) || typeof root.name !== "string" || root.name.length === 0) {
      throw new Error("pnpm why output contains a malformed workspace root.");
    }
    if (!rootPackageNames.has(root.name)) {
      continue;
    }
    traverseWhyChildren(root, [root.name], new Set(), false);
  }
  for (const version of targetVersions) {
    const key = packageVersionKey(packageName, version);
    if (!Array.isArray(dependencyPaths[key]) || dependencyPaths[key].length === 0) {
      throw new Error(`pnpm why found no production dependency path for ${key}.`);
    }
    dependencyPaths[key] = [...new Set(dependencyPaths[key])].sort();
  }
  return dependencyPaths;

  function traverseWhyChildren(parent, parentPath, ancestors, traversedWorkspaceLink) {
    for (const section of ["dependencies", "optionalDependencies"]) {
      const children = parent[section];
      if (children === undefined) {
        continue;
      }
      if (!isRecord(children)) {
        throw new Error(`pnpm why ${section} must be an object at ${parentPath.join(" -> ")}.`);
      }
      for (const [childName, child] of Object.entries(children).sort(([left], [right]) => left.localeCompare(right))) {
        if (!isRecord(child) || typeof child.version !== "string" || child.version.length === 0) {
          throw new Error(`pnpm why contains a malformed ${section} entry for ${childName}.`);
        }
        const nodeKey = packageVersionKey(childName, child.version);
        if (ancestors.has(nodeKey)) {
          continue;
        }
        const localWorkspaceLink = isLocalDependencyVersion(child.version);
        const label = localWorkspaceLink ? childName : nodeKey;
        const childPath = [...parentPath, label];
        const crossedWorkspaceBoundary = traversedWorkspaceLink || localWorkspaceLink;
        // Every catalog-publishable workspace package is queried as its own root.
        // Suppress paths that traverse another workspace link: their suffix is
        // represented from that package's root, avoiding redundant consumer paths.
        if (childName === packageName && targetVersions.has(child.version) && !crossedWorkspaceBoundary) {
          dependencyPaths[nodeKey] ??= [];
          dependencyPaths[nodeKey].push(childPath.join(" -> "));
        }
        traverseWhyChildren(
          child,
          childPath,
          new Set([...ancestors, nodeKey]),
          crossedWorkspaceBoundary,
        );
      }
    }
  }
}

export function normalizeInventory(input) {
  if (!isRecord(input)) {
    throw new Error("production dependency inventory must be an object.");
  }
  const entries = Object.entries(input)
    .map(([name, versions]) => {
      if (name.length === 0 || !Array.isArray(versions) || versions.length === 0) {
        throw new Error(`production dependency inventory has no versions for ${name || "<empty name>"}.`);
      }
      const normalizedVersions = [...new Set(versions.map((version) => {
        if (typeof version !== "string" || version.length === 0) {
          throw new Error(`production dependency inventory contains an invalid version for ${name}.`);
        }
        return version;
      }))].sort();
      return [name, normalizedVersions];
    })
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    throw new Error("production dependency inventory is empty; run pnpm install --frozen-lockfile first.");
  }
  return Object.fromEntries(entries);
}

export function normalizeProductionGraph(input) {
  if (!isRecord(input)) {
    throw new Error("production dependency graph must be an object.");
  }
  const inventory = normalizeInventory(input.inventory);
  if (!isRecord(input.dependencyPaths)) {
    throw new Error("production dependency graph must include dependencyPaths.");
  }

  const expectedKeys = new Set(
    Object.entries(inventory).flatMap(([packageName, versions]) => (
      versions.map((version) => packageVersionKey(packageName, version))
    )),
  );
  const dependencyPaths = {};
  for (const [key, paths] of Object.entries(input.dependencyPaths)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`production dependency graph contains paths for absent package version ${key}.`);
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error(`production dependency graph has an invalid empty path set for ${key}.`);
    }
    const normalizedPaths = [...new Set(paths.map((path) => {
      if (typeof path !== "string" || path.length === 0) {
        throw new Error(`production dependency graph contains an invalid path for ${key}.`);
      }
      if (!path.endsWith(` -> ${key}`)) {
        throw new Error(`production dependency path does not end at ${key}: ${path}`);
      }
      return path;
    }))].sort();
    dependencyPaths[key] = normalizedPaths;
  }
  return { inventory, dependencyPaths };
}

export async function collectProductionGraph(options = {}) {
  const command = options.pnpmCommand ?? "pnpm";
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? runCommandCapture;
  const result = await runCommand(
    command,
    ["list", "--prod", "--recursive", "--depth", "Infinity", "--parseable"],
    { cwd },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`could not collect pnpm production graph: ${detail}`);
  }
  return { inventory: parsePnpmProductionInventory(result.stdout), dependencyPaths: {} };
}

export async function collectAdvisoryDependencyPaths(productionGraph, packageNames, options = {}) {
  const graph = normalizeProductionGraph(productionGraph);
  const command = options.pnpmCommand ?? "pnpm";
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? runCommandCapture;
  const dependencyPaths = { ...graph.dependencyPaths };
  for (const packageName of [...new Set(packageNames)].sort()) {
    const versions = graph.inventory[packageName];
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new Error(`cannot collect dependency paths for package absent from inventory: ${packageName}.`);
    }
    const result = await runCommand(
      command,
      ["why", packageName, "--prod", "--recursive", "--json"],
      { cwd },
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
      throw new Error(`could not collect pnpm dependency paths for ${packageName}: ${detail}`);
    }
    Object.assign(dependencyPaths, parsePnpmWhyDependencyPaths(result.stdout, {
      packageName,
      versions,
      rootPackageNames: options.rootPackageNames,
    }));
  }
  return normalizeProductionGraph({ inventory: graph.inventory, dependencyPaths });
}

export async function loadDependencyVulnerabilityDispositions(path = DEFAULT_DISPOSITIONS_PATH) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`could not read dependency vulnerability dispositions at ${path}: ${reasonOf(error)}`);
  }
  try {
    return normalizeDispositions(JSON.parse(source));
  } catch (error) {
    throw new Error(`invalid dependency vulnerability dispositions at ${path}: ${reasonOf(error)}`);
  }
}

export function normalizeDispositions(input) {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.minimumSeverity !== "high") {
    throw new Error("dispositions must use schemaVersion 1 and minimumSeverity high.");
  }
  if (typeof input.reviewedAt !== "string" || input.reviewedAt.length === 0 || !Array.isArray(input.advisories)) {
    throw new Error("dispositions must include reviewedAt and an advisories array.");
  }
  const reviewedAtEpoch = parseDateOnly(input.reviewedAt, "dispositions reviewedAt");

  const seen = new Set();
  const advisories = input.advisories.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("dispositions contain a malformed advisory entry.");
    }
    const requiredStrings = [
      "package",
      "severity",
      "title",
      "url",
      "vulnerableVersions",
      "disposition",
      "expiresAt",
      "rationale",
    ];
    for (const field of requiredStrings) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(`disposition advisory ${String(entry.id)} is missing ${field}.`);
      }
    }
    if (entry.disposition !== "accepted-temporarily") {
      throw new Error(`disposition advisory ${String(entry.id)} must be accepted-temporarily.`);
    }
    const expiresAtEpoch = parseDateOnly(
      entry.expiresAt,
      `disposition advisory ${String(entry.id)} expiresAt`,
    );
    const acceptanceDays = (expiresAtEpoch - reviewedAtEpoch) / 86_400_000;
    if (acceptanceDays <= 0 || acceptanceDays > MAX_TEMPORARY_ACCEPTANCE_DAYS) {
      throw new Error(
        `disposition advisory ${String(entry.id)} expiresAt must be after reviewedAt and within `
        + `${MAX_TEMPORARY_ACCEPTANCE_DAYS} days.`,
      );
    }
    if (!(entry.severity in SEVERITY_RANK) || SEVERITY_RANK[entry.severity] < SEVERITY_RANK.high) {
      throw new Error(`disposition advisory ${String(entry.id)} must be high or critical.`);
    }
    if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
      throw new Error(`disposition advisory ${String(entry.id)} must pin at least one exact version.`);
    }
    const versions = entry.versions.map((version) => {
      if (typeof version !== "string" || version.length === 0) {
        throw new Error(`disposition advisory ${String(entry.id)} contains an invalid exact version.`);
      }
      return version;
    });
    if (!Array.isArray(entry.dependencyPaths) || entry.dependencyPaths.length === 0
      || entry.dependencyPaths.some((path) => typeof path !== "string" || path.length === 0)) {
      throw new Error(`disposition advisory ${String(entry.id)} must name its production dependency paths.`);
    }
    if ((typeof entry.id !== "number" && typeof entry.id !== "string") || String(entry.id).length === 0) {
      throw new Error("disposition advisory is missing id.");
    }
    const key = advisoryKey(entry.package, entry.id);
    if (seen.has(key)) {
      throw new Error(`duplicate disposition for ${key}.`);
    }
    seen.add(key);
    return {
      ...entry,
      id: String(entry.id),
      versions: [...new Set(versions)].sort(),
      dependencyPaths: [...new Set(entry.dependencyPaths)].sort(),
    };
  }).sort(compareAdvisories);

  return {
    schemaVersion: 1,
    minimumSeverity: "high",
    reviewedAt: input.reviewedAt,
    advisories,
  };
}

export async function queryBulkAdvisories(inventory, options = {}) {
  const registryUrl = options.registryUrl ?? DEFAULT_AUDIT_REGISTRY_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoint = new URL("-/npm/v1/security/advisories/bulk", ensureTrailingSlash(registryUrl));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("bulk advisory timeout must be a positive finite number.");
  }
  const controller = new AbortController();
  const timeoutError = new Error(`request timed out after ${timeoutMs}ms`);
  let timeout;

  let response;
  let source;
  try {
    const request = Promise.resolve().then(async () => {
      const fetched = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "mono-agent-dependency-vulnerability-gate",
        },
        body: JSON.stringify(inventory),
        signal: controller.signal,
      });
      if (typeof fetched?.ok !== "boolean" || typeof fetched.status !== "number"
        || typeof fetched.text !== "function") {
        throw new Error("bulk advisory endpoint returned a malformed HTTP response");
      }
      const responseSource = await fetched.text();
      if (typeof responseSource !== "string") {
        throw new Error("bulk advisory endpoint returned a non-text response body");
      }
      return { response: fetched, source: responseSource };
    });
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    ({ response, source } = await Promise.race([request, timedOut]));
  } catch (error) {
    if (error === timeoutError) {
      throw new Error(`bulk advisory request timed out after ${timeoutMs}ms.`);
    }
    throw new Error(`bulk advisory request failed: ${reasonOf(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`bulk advisory response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
  }
  if (!response.ok) {
    throw new Error(`bulk advisory endpoint ${endpoint.href} returned HTTP ${response.status}: ${source.slice(0, 500)}`);
  }
  try {
    const document = JSON.parse(source);
    if (!isRecord(document)) {
      throw new Error("response root is not an object");
    }
    return document;
  } catch (error) {
    throw new Error(`bulk advisory response was not valid JSON: ${reasonOf(error)}`);
  }
}

export function evaluateDependencyVulnerabilities({ productionGraph, report, dispositions, now = new Date() }) {
  const normalizedGraph = normalizeProductionGraph(productionGraph);
  const normalizedInventory = normalizedGraph.inventory;
  const normalizedDispositions = normalizeDispositions(dispositions);
  const todayEpoch = utcDayEpoch(now);
  const reviewedAtEpoch = parseDateOnly(normalizedDispositions.reviewedAt, "dispositions reviewedAt");
  if (reviewedAtEpoch > todayEpoch) {
    throw new Error(`dispositions reviewedAt ${normalizedDispositions.reviewedAt} is in the future.`);
  }
  if (!isRecord(report)) {
    throw new Error("bulk advisory report must be an object keyed by package name.");
  }

  const active = [];
  for (const [packageName, advisories] of Object.entries(report)) {
    if (!(packageName in normalizedInventory)) {
      throw new Error(`bulk advisory report returned package absent from inventory: ${packageName}.`);
    }
    if (!Array.isArray(advisories)) {
      throw new Error(`bulk advisory report for ${packageName} is not an array.`);
    }
    for (const advisory of advisories) {
      const normalized = normalizeLiveAdvisory(
        packageName,
        normalizedInventory[packageName],
        normalizedGraph.dependencyPaths,
        advisory,
      );
      if (SEVERITY_RANK[normalized.severity] >= SEVERITY_RANK.high) {
        active.push(normalized);
      }
    }
  }
  active.sort(compareAdvisories);

  const activeByKey = new Map(active.map((advisory) => [advisoryKey(advisory.package, advisory.id), advisory]));
  const dispositionsByKey = new Map(
    normalizedDispositions.advisories.map((advisory) => [advisoryKey(advisory.package, advisory.id), advisory]),
  );
  const unreviewed = [];
  const mismatched = [];
  const stale = [];
  const expired = normalizedDispositions.advisories.filter(
    (disposition) => parseDateOnly(
      disposition.expiresAt,
      `disposition advisory ${disposition.id} expiresAt`,
    ) <= todayEpoch,
  );

  for (const advisory of active) {
    const disposition = dispositionsByKey.get(advisoryKey(advisory.package, advisory.id));
    if (disposition === undefined) {
      unreviewed.push(advisory);
      continue;
    }
    const differences = dispositionDifferences(advisory, disposition);
    if (differences.length > 0) {
      mismatched.push({ advisory, disposition, differences });
    }
  }
  for (const disposition of normalizedDispositions.advisories) {
    if (!activeByKey.has(advisoryKey(disposition.package, disposition.id))) {
      stale.push(disposition);
    }
  }

  return {
    ok: unreviewed.length === 0 && mismatched.length === 0 && stale.length === 0 && expired.length === 0,
    productionGraph: normalizedGraph,
    inventory: normalizedInventory,
    dispositions: normalizedDispositions,
    active,
    unreviewed,
    mismatched,
    stale,
    expired,
  };
}

export async function runDependencyVulnerabilityCheck(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let parsed;
  try {
    parsed = parseArgs(options.argv ?? process.argv.slice(2));
  } catch (error) {
    stderr.write(`${reasonOf(error)}\n\n${usage()}\n`);
    return { exitCode: 1 };
  }
  if (parsed.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0 };
  }

  try {
    const cwd = options.cwd ?? process.cwd();
    const productionGraph = options.productionGraph ?? await (
      options.collectGraph ?? collectProductionGraph
    )({
      cwd,
      pnpmCommand: options.pnpmCommand,
      rootPackageNames: options.rootPackageNames,
      runCommand: options.runCommand,
    });
    const dispositions = options.dispositions ?? await loadDependencyVulnerabilityDispositions(
      options.dispositionsPath ?? DEFAULT_DISPOSITIONS_PATH,
    );
    const registryUrl = options.registryUrl
      ?? process.env.MONO_AGENT_DEPENDENCY_AUDIT_REGISTRY
      ?? DEFAULT_AUDIT_REGISTRY_URL;
    const normalizedGraph = normalizeProductionGraph(productionGraph);
    const report = await (options.queryAdvisories ?? queryBulkAdvisories)(normalizedGraph.inventory, {
      registryUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    const highSeverityPackages = highSeverityReportPackageNames(report, normalizedGraph.inventory);
    const packagesMissingPaths = highSeverityPackages.filter((packageName) => (
      normalizedGraph.inventory[packageName].some((version) => (
        !Array.isArray(normalizedGraph.dependencyPaths[packageVersionKey(packageName, version)])
      ))
    ));
    const graphWithPaths = packagesMissingPaths.length === 0
      ? normalizedGraph
      : await (options.collectDependencyPaths ?? collectAdvisoryDependencyPaths)(
        normalizedGraph,
        packagesMissingPaths,
        {
          cwd,
          pnpmCommand: options.pnpmCommand,
          rootPackageNames: options.rootPackageNames,
          runCommand: options.runCommand,
        },
      );
    const evaluation = evaluateDependencyVulnerabilities({
      productionGraph: graphWithPaths,
      report,
      dispositions,
      now: options.now,
    });
    renderEvaluation(evaluation, { stdout, stderr });
    return { exitCode: evaluation.ok ? 0 : 1, evaluation };
  } catch (error) {
    stderr.write(`dependency vulnerability check: FAILED — ${reasonOf(error)}\n`);
    return { exitCode: 1, error };
  }
}

function renderEvaluation(evaluation, { stdout, stderr }) {
  const packageCount = Object.keys(evaluation.inventory).length;
  const versionCount = Object.values(evaluation.inventory).reduce((total, versions) => total + versions.length, 0);
  if (!evaluation.ok) {
    stderr.write(
      `dependency vulnerability check: FAILED — ${packageCount} production packages / ${versionCount} versions; `
      + `${evaluation.active.length} high-or-critical advisories.\n`,
    );
    for (const advisory of evaluation.unreviewed) {
      stderr.write(`  UNREVIEWED ${formatAdvisory(advisory)}\n`);
    }
    for (const mismatch of evaluation.mismatched) {
      stderr.write(`  MISMATCH ${formatAdvisory(mismatch.advisory)} — ${mismatch.differences.join("; ")}\n`);
    }
    for (const disposition of evaluation.expired) {
      stderr.write(
        `  EXPIRED [${disposition.severity}] ${disposition.package}@${disposition.versions.join(",")} `
        + `${disposition.url} — temporary acceptance expired ${disposition.expiresAt}\n`,
      );
    }
    for (const disposition of evaluation.stale) {
      stderr.write(
        `  STALE [${disposition.severity}] ${disposition.package}@${disposition.versions.join(",")} `
        + `${disposition.url} — no matching active advisory\n`,
      );
    }
    return;
  }

  stdout.write(
    `dependency vulnerability check: OK — ${packageCount} production packages / ${versionCount} versions; `
    + `${evaluation.active.length} high-or-critical advisories, all exactly dispositioned.\n`,
  );
  for (const advisory of evaluation.active) {
    const disposition = evaluation.dispositions.advisories.find(
      (entry) => advisoryKey(entry.package, entry.id) === advisoryKey(advisory.package, advisory.id),
    );
    stdout.write(`  DISPOSITIONED ${formatAdvisory(advisory)} — ${disposition.rationale}\n`);
  }
}

function normalizeLiveAdvisory(packageName, versions, dependencyPaths, advisory) {
  if (!isRecord(advisory)) {
    throw new Error(`bulk advisory report for ${packageName} contains a malformed entry.`);
  }
  const severity = advisory.severity;
  if (typeof severity !== "string" || !(severity in SEVERITY_RANK)) {
    throw new Error(`bulk advisory ${String(advisory.id)} for ${packageName} has an unknown severity.`);
  }
  const requiredStrings = ["title", "url", "vulnerable_versions"];
  for (const field of requiredStrings) {
    if (typeof advisory[field] !== "string" || advisory[field].length === 0) {
      throw new Error(`bulk advisory ${String(advisory.id)} for ${packageName} is missing ${field}.`);
    }
  }
  if ((typeof advisory.id !== "number" && typeof advisory.id !== "string") || String(advisory.id).length === 0) {
    throw new Error(`bulk advisory for ${packageName} is missing id.`);
  }
  const advisoryDependencyPaths = SEVERITY_RANK[severity] >= SEVERITY_RANK.high
    ? versions.flatMap((version) => {
      const key = packageVersionKey(packageName, version);
      const paths = dependencyPaths[key];
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error(`production dependency graph has no paths for advisory package ${key}.`);
      }
      return paths;
    }).sort()
    : [];
  return {
    package: packageName,
    versions: [...versions],
    dependencyPaths: advisoryDependencyPaths,
    id: String(advisory.id),
    severity,
    title: advisory.title,
    url: advisory.url,
    vulnerableVersions: advisory.vulnerable_versions,
  };
}

function dispositionDifferences(advisory, disposition) {
  const differences = [];
  if (JSON.stringify(advisory.versions) !== JSON.stringify(disposition.versions)) {
    differences.push(`exact versions changed (${disposition.versions.join(",")} -> ${advisory.versions.join(",")})`);
  }
  if (JSON.stringify(advisory.dependencyPaths) !== JSON.stringify(disposition.dependencyPaths)) {
    differences.push("production dependency paths changed");
  }
  for (const field of ["severity", "title", "url", "vulnerableVersions"]) {
    if (advisory[field] !== disposition[field]) {
      differences.push(`${field} changed`);
    }
  }
  return differences;
}

function highSeverityReportPackageNames(report, inventory) {
  if (!isRecord(report)) {
    throw new Error("bulk advisory report must be an object keyed by package name.");
  }
  const packageNames = [];
  for (const [packageName, advisories] of Object.entries(report)) {
    if (!(packageName in inventory)) {
      throw new Error(`bulk advisory report returned package absent from inventory: ${packageName}.`);
    }
    if (!Array.isArray(advisories)) {
      throw new Error(`bulk advisory report for ${packageName} is not an array.`);
    }
    let active = false;
    for (const advisory of advisories) {
      if (!isRecord(advisory) || typeof advisory.severity !== "string"
        || !(advisory.severity in SEVERITY_RANK)) {
        throw new Error(`bulk advisory report for ${packageName} contains an unknown severity.`);
      }
      active ||= SEVERITY_RANK[advisory.severity] >= SEVERITY_RANK.high;
    }
    if (active) {
      packageNames.push(packageName);
    }
  }
  return packageNames.sort();
}

function parseArgs(argv) {
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { help };
}

function usage() {
  return [
    "Usage:",
    "  pnpm run check:dependency-vulnerabilities",
    "",
    "Audits the full publishable cross-platform production/optional dependency graph through npm's bulk advisory API.",
    "Fails closed on registry errors and on unreviewed, expired, stale, or metadata/version/path-mismatched high/critical findings.",
    "Set MONO_AGENT_DEPENDENCY_AUDIT_REGISTRY only to use a compatible registry mirror.",
  ].join("\n");
}

async function runCommandCapture(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : reasonOf(error),
    };
  }
}

function formatAdvisory(advisory) {
  return `[${advisory.severity}] ${advisory.package}@${advisory.versions.join(",")} ${advisory.url}`;
}

function compareAdvisories(left, right) {
  return left.package.localeCompare(right.package) || String(left.id).localeCompare(String(right.id));
}

function advisoryKey(packageName, id) {
  return `${packageName}:${String(id)}`;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeRootPackageNames(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("production graph rootPackageNames must be a non-empty array.");
  }
  const names = input.map((name) => {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("production graph rootPackageNames contains an invalid package name.");
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("production graph rootPackageNames contains duplicates.");
  }
  return [...names].sort();
}

function parseVirtualStorePackagePath(value) {
  const normalizedPath = value.replaceAll("\\", "/");
  const marker = "/node_modules/.pnpm/";
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`pnpm production inventory path is not in the virtual store: ${value}`);
  }
  const relative = normalizedPath.slice(markerIndex + marker.length);
  const nodeModulesMarker = "/node_modules/";
  const nodeModulesIndex = relative.indexOf(nodeModulesMarker);
  if (nodeModulesIndex < 0) {
    throw new Error(`pnpm production inventory path has no package suffix: ${value}`);
  }
  const virtualStoreDirectory = relative.slice(0, nodeModulesIndex);
  const packageSegments = relative.slice(nodeModulesIndex + nodeModulesMarker.length).split("/");
  const name = packageSegments[0]?.startsWith("@")
    ? packageSegments.slice(0, 2).join("/")
    : packageSegments[0];
  if (typeof name !== "string" || name.length === 0 || (name.startsWith("@") && !name.includes("/"))) {
    throw new Error(`pnpm production inventory path has an invalid package name: ${value}`);
  }
  const encodedPrefix = `${name.replace("/", "+")}@`;
  if (!virtualStoreDirectory.startsWith(encodedPrefix)) {
    throw new Error(`pnpm virtual-store directory does not match package ${name}: ${value}`);
  }
  const version = virtualStoreDirectory.slice(encodedPrefix.length).split("_", 1)[0];
  if (version.length === 0) {
    throw new Error(`pnpm production inventory path has no version for ${name}: ${value}`);
  }
  return { name, version };
}

function isLocalDependencyVersion(version) {
  return version.startsWith("link:") || version.startsWith("file:") || version.startsWith("workspace:");
}

function packageVersionKey(packageName, version) {
  return `${packageName}@${version}`;
}

function parseDateOnly(value, description) {
  if (typeof value !== "string") {
    throw new Error(`${description} must be a valid YYYY-MM-DD date.`);
  }
  const match = DATE_ONLY_PATTERN.exec(value);
  if (match?.groups === undefined) {
    throw new Error(`${description} must be a valid YYYY-MM-DD date.`);
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`${description} must be a valid YYYY-MM-DD date.`);
  }
  return epoch;
}

function utcDayEpoch(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("dependency vulnerability evaluation time must be a valid date.");
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  const result = await runDependencyVulnerabilityCheck();
  process.exitCode = result.exitCode;
}
