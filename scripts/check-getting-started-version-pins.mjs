#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Getting-started install docs used to carry literal `@mono-agent/<pkg>@X.Y.Z`
 * pins that silently rotted one release behind (goal #164 E-evidence: docs pinned
 * `0.4.0` while the packages had already shipped `0.4.1`). This check reads the
 * lockstep version from `packages/agent-app/package.json` and fails whenever any
 * version pin in the getting-started docs disagrees with it — so a pin is either
 * current or the docs go versionless (the preferred, un-rottable form). A shell
 * placeholder like `@mono-agent/agent-app@$version` is NOT a pin and is ignored.
 *
 * Covers the scoped `@mono-agent/<pkg>@X.Y.Z` pins, the unscoped
 * `create-mono-agent@X.Y.Z` installer, and (still) the bare `mono-agent@X.Y.Z`
 * form — all release in the same lockstep, so any pinned `npm i -g …@X.Y.Z` in
 * these docs must track the same version. (The bare `mono-agent` name is no longer
 * published, but the pattern is kept so an accidental stale pin can't slip in.)
 *
 * A separate offline check below keeps the three active published-baseline claims
 * consistent with one another. It intentionally does not compare that baseline
 * with the source package version or query npm: an unreleased source bump must not
 * become a false publication claim, while historical version citations stay valid.
 */

const GETTING_STARTED_DIR = join("docs", "getting-started");
const AGENT_APP_PACKAGE_JSON = join("packages", "agent-app", "package.json");
const PUBLISHED_BASELINE_PATHS = [
  "README.md",
  join("docs", "index.md"),
  join("docs", "reference", "release-status.md"),
];

// These are active claims about the latest published installer, not arbitrary
// version citations. Historical release comparisons and changelog entries stay
// outside this deliberately narrow check. Keep this independent from the source
// manifest version: source may be bumped before the corresponding npm release.
const PUBLISHED_BASELINE_PATTERN =
  /(?:published baseline checked on|latest published npm release)[^\n]*?`create-mono-agent@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`/giu;

// A literal, concrete version pin for the scoped `@mono-agent/<name>`, the
// unscoped `create-mono-agent` installer, or the bare `mono-agent` name. The
// leading negative lookbehind stops a shorter alternative from matching inside a
// longer name (e.g. the `mono-agent` inside `@mono-agent/…` — preceded by `@` — or
// inside `create-mono-agent` — preceded by `-`); the longer `create-mono-agent`
// alternative is listed before `mono-agent` so it wins. The version must start
// with a digit, so `$version` / `<published-version>` placeholders and dist-tags
// (`@latest`) never match.
const VERSION_PIN_PATTERN =
  /(?<![\w@/-])(?:@mono-agent\/[a-z0-9-]+|create-mono-agent|mono-agent)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu;

/**
 * @param {{ repoRoot?: string, docRecords?: { path: string, text: string }[], agentAppVersion?: string }} [options]
 * @returns {Promise<{ agentAppVersion: string, pins: { path: string, line: number, pin: string, version: string }[], issues: string[] }>}
 */
export async function checkGettingStartedVersionPins(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? cliRepoRoot());
  const agentAppVersion = options.agentAppVersion ?? await readAgentAppVersion(repoRoot);
  const docRecords = options.docRecords ?? await readGettingStartedDocs(repoRoot);

  const pins = [];
  const issues = [];
  for (const record of docRecords) {
    for (const match of record.text.matchAll(VERSION_PIN_PATTERN)) {
      const version = match[1];
      const line = record.text.slice(0, match.index).split("\n").length;
      pins.push({ path: record.path, line, pin: match[0], version });
      if (version !== agentAppVersion) {
        issues.push(
          `${record.path}:${line}: version pin \`${match[0]}\` disagrees with the lockstep ` +
            `@mono-agent/agent-app version \`${agentAppVersion}\`. Update the pin or make the docs versionless.`,
        );
      }
    }
  }

  return { agentAppVersion, pins, issues };
}

/**
 * Keep explicit active claims about the latest published installer consistent.
 * This is intentionally offline and does not compare with package manifests or
 * query npm: a source version bump can legitimately lead the published release.
 *
 * @param {{ repoRoot?: string, docRecords?: { path: string, text: string }[] }} [options]
 * @returns {Promise<{ references: { path: string, line: number, version: string }[], issues: string[] }>}
 */
export async function checkPublishedBaselineReferences(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? cliRepoRoot());
  const docRecords = options.docRecords ?? await readPublishedBaselineDocs(repoRoot);
  const references = [];
  const issues = [];

  for (const record of docRecords) {
    const matches = [...record.text.matchAll(PUBLISHED_BASELINE_PATTERN)];
    if (matches.length !== 1) {
      issues.push(
        `${record.path}: expected exactly one explicit latest-published ` +
          `create-mono-agent@<version> baseline; found ${matches.length}.`,
      );
      continue;
    }
    const match = matches[0];
    references.push({
      path: record.path,
      line: record.text.slice(0, match.index).split("\n").length,
      version: match[1],
    });
  }

  const expected = references[0]?.version;
  if (expected !== undefined) {
    for (const reference of references.slice(1)) {
      if (reference.version !== expected) {
        issues.push(
          `${reference.path}:${reference.line}: published baseline ` +
            `create-mono-agent@${reference.version} disagrees with ` +
            `${references[0].path}:${references[0].line} ` +
            `(create-mono-agent@${expected}).`,
        );
      }
    }
  }

  return { references, issues };
}

async function readAgentAppVersion(repoRoot) {
  const raw = await readFile(join(repoRoot, AGENT_APP_PACKAGE_JSON), "utf8");
  const version = JSON.parse(raw).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${AGENT_APP_PACKAGE_JSON} has no version field.`);
  }
  return version;
}

async function readGettingStartedDocs(repoRoot) {
  const dir = join(repoRoot, GETTING_STARTED_DIR);
  const entries = await readdir(dir, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name) === ".md") {
      const path = join(dir, entry.name);
      records.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return records;
}

async function readPublishedBaselineDocs(repoRoot) {
  return await Promise.all(PUBLISHED_BASELINE_PATHS.map(async (path) => ({
    path,
    text: await readFile(join(repoRoot, path), "utf8"),
  })));
}

function cliRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main() {
  const [pinResult, baselineResult] = await Promise.all([
    checkGettingStartedVersionPins(),
    checkPublishedBaselineReferences(),
  ]);
  const issues = [...pinResult.issues, ...baselineResult.issues];
  if (issues.length > 0) {
    for (const issue of issues) {
      process.stderr.write(`ERROR ${issue}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Getting-started version pins OK: ${pinResult.pins.length} pin(s) checked against ` +
      `@mono-agent/agent-app@${pinResult.agentAppVersion}; ` +
      `${baselineResult.references.length} published-baseline reference(s) agree.\n`,
  );
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  await main();
}
