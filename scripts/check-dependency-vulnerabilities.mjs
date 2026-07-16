#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SEVERITY_RANK = Object.freeze({ low: 0, moderate: 1, high: 2, critical: 3 });

export const DEFAULT_AUDIT_REGISTRY_URL = "https://registry.npmjs.org/";
export const DEFAULT_DISPOSITIONS_PATH = fileURLToPath(
  new URL("./dependency-vulnerability-dispositions.json", import.meta.url),
);

export function parsePnpmLicenseInventory(source) {
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(`pnpm production inventory was not valid JSON: ${reasonOf(error)}`);
  }
  if (!isRecord(document)) {
    throw new Error("pnpm production inventory must be an object grouped by license.");
  }

  const inventory = {};
  for (const entries of Object.values(document)) {
    if (!Array.isArray(entries)) {
      throw new Error("pnpm production inventory contains a non-array license group.");
    }
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.name !== "string" || !Array.isArray(entry.versions)) {
        throw new Error("pnpm production inventory contains a malformed package entry.");
      }
      inventory[entry.name] ??= [];
      for (const version of entry.versions) {
        if (typeof version !== "string" || version.length === 0) {
          throw new Error(`pnpm production inventory contains an invalid version for ${entry.name}.`);
        }
        inventory[entry.name].push(version);
      }
    }
  }
  return normalizeInventory(inventory);
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

export async function collectProductionInventory(options = {}) {
  const command = options.pnpmCommand ?? "pnpm";
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? runCommandCapture;
  const result = await runCommand(command, ["licenses", "list", "--prod", "--json"], { cwd });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`could not collect pnpm production inventory: ${detail}`);
  }
  return parsePnpmLicenseInventory(result.stdout);
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
      dependencyPaths: [...entry.dependencyPaths],
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  let response;
  let source;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "mono-agent-dependency-vulnerability-gate",
      },
      body: JSON.stringify(inventory),
      signal: controller.signal,
    });
    source = await response.text();
  } catch (error) {
    throw new Error(`bulk advisory request failed: ${reasonOf(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (source.length > MAX_RESPONSE_BYTES) {
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

export function evaluateDependencyVulnerabilities({ inventory, report, dispositions }) {
  const normalizedInventory = normalizeInventory(inventory);
  const normalizedDispositions = normalizeDispositions(dispositions);
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
      const normalized = normalizeLiveAdvisory(packageName, normalizedInventory[packageName], advisory);
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
    ok: unreviewed.length === 0 && mismatched.length === 0 && stale.length === 0,
    inventory: normalizedInventory,
    dispositions: normalizedDispositions,
    active,
    unreviewed,
    mismatched,
    stale,
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
    const inventory = options.inventory ?? await (options.collectInventory ?? collectProductionInventory)({
      cwd,
      pnpmCommand: options.pnpmCommand,
    });
    const dispositions = options.dispositions ?? await loadDependencyVulnerabilityDispositions(
      options.dispositionsPath ?? DEFAULT_DISPOSITIONS_PATH,
    );
    const registryUrl = options.registryUrl
      ?? process.env.MONO_AGENT_DEPENDENCY_AUDIT_REGISTRY
      ?? DEFAULT_AUDIT_REGISTRY_URL;
    const report = await (options.queryAdvisories ?? queryBulkAdvisories)(inventory, {
      registryUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    const evaluation = evaluateDependencyVulnerabilities({ inventory, report, dispositions });
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

function normalizeLiveAdvisory(packageName, versions, advisory) {
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
  return {
    package: packageName,
    versions: [...versions],
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
  for (const field of ["severity", "title", "url", "vulnerableVersions"]) {
    if (advisory[field] !== disposition[field]) {
      differences.push(`${field} changed`);
    }
  }
  return differences;
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
    "Audits installed production dependencies through npm's bulk advisory API.",
    "Fails closed on registry errors and on unreviewed, stale, or metadata/version-mismatched high/critical findings.",
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
