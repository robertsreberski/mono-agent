#!/usr/bin/env node
/**
 * check-changelog.mjs — fail-closed CHANGELOG.md gate.
 *
 * Three responsibilities:
 *
 *   A. Structure (always runs). The H1 must be exactly `# Release notes`,
 *      `## Unreleased` must be the first `##` section, and every other
 *      section must match `## X.Y.Z — <title> (YYYY-MM-DD)` with a valid
 *      semver, a non-empty title, and a real calendar date. Versions descend
 *      strictly with no duplicates. No line may carry trailing whitespace and
 *      every bullet marker must be `- `.
 *
 *   B. Published-version coverage (runs when tags are available). Every
 *      `v<semver>` tag reachable from HEAD must have a matching section.
 *      When no tags are visible (shallow clone without tags) the check prints
 *      "tags unavailable, coverage not checked" and passes this part instead
 *      of failing falsely.
 *
 *   C. PR entry gate (runs only in a PR context). The PR's diff against its
 *      base must add at least one new bullet under `## Unreleased`, unless an
 *      escape hatch applies or the diff is a release cut that only moves
 *      `Unreleased` content into a new version section.
 *
 * The script never calls the GitHub API. The CI workflow passes PR context
 * through the environment so the script stays a pure function of its inputs:
 *
 *   CHANGELOG_BASE_REF   Base git ref or SHA to diff against (for example
 *                        ${{ github.event.pull_request.base.sha }}). When empty
 *                        or unset, the PR gate is skipped with a note because
 *                        the run is not a pull request (push to main, local
 *                        run). This is the only variable that arms part C.
 *   CHANGELOG_PR_LABELS  PR label names: either a JSON array (what CI sends
 *                        via ${{ toJSON(github.event.pull_request.labels.*.name) }})
 *                        or a comma-separated list (convenient for local runs).
 *                        Containing `skip-changelog` passes the gate.
 *   CHANGELOG_PR_BODY    Full PR body text. A line matching
 *                        /^Changelog:\s*none\b/m passes the gate.
 *
 * Exit 0 only when every applicable part passes; every failure names the
 * offending file and line.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CHANGELOG_FILE_NAME = "CHANGELOG.md";
export const EXPECTED_H1 = "# Release notes";
export const UNRELEASED_HEADING = "## Unreleased";
export const SKIP_CHANGELOG_LABEL = "skip-changelog";
export const CHANGELOG_NONE_PATTERN = /^Changelog:\s*none\b/m;
const VERSION_HEADING_PATTERN = /^## (\S+) — (.+) \((\d{4}-\d{2}-\d{2})\)$/u;
const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const BAD_BULLET_PATTERN = /^\s*-(?!\s|$)/;
const TRAILING_WHITESPACE_PATTERN = /[ \t]+$/;

export function repoRootFromScript() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function parseSemver(text) {
  const match = SEMVER_PATTERN.exec(text || "");
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  if (left.prerelease === null && right.prerelease === null) {
    return 0;
  }
  if (left.prerelease === null) {
    return 1;
  }
  if (right.prerelease === null) {
    return -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.prerelease.length) {
      return -1;
    }
    if (index >= right.prerelease.length) {
      return 1;
    }
    const order = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (order !== 0) {
      return order < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function isRealCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
}

export function parseVersionHeading(line) {
  const match = VERSION_HEADING_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  const [, versionText, title, dateText] = match;
  const [yearText, monthText, dayText] = dateText.split("-");
  return {
    versionText,
    version: parseSemver(versionText),
    title: title.trim(),
    dateText,
    date: {
      year: Number(yearText),
      month: Number(monthText),
      day: Number(dayText),
    },
  };
}

/**
 * Parse the changelog into headed sections. Never throws for malformed
 * input; records every defect in `errors` with 1-based line numbers.
 */
export function parseChangelog(text, fileName = CHANGELOG_FILE_NAME) {
  const errors = [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const at = (line) => `${fileName}:${line}`;

  if (lines[0] !== EXPECTED_H1) {
    errors.push(`${at(1)}: first line must be exactly \`${EXPECTED_H1}\``);
  }

  const sections = [];
  let current = null;
  const finishSection = (endLine) => {
    if (current !== null) {
      current.bodyEndLine = endLine;
      sections.push(current);
      current = null;
    }
  };
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.startsWith("## ")) {
      return;
    }
    finishSection(lineNumber - 1);
    if (line === UNRELEASED_HEADING) {
      current = {
        kind: "unreleased",
        heading: line,
        headingLine: lineNumber,
        versionText: null,
        version: null,
        title: null,
        dateText: null,
        bodyStartLine: lineNumber + 1,
        bodyEndLine: lineNumber,
        bullets: [],
      };
      return;
    }
    const parsed = parseVersionHeading(line);
    current = {
      kind: parsed === null ? "malformed" : "version",
      heading: line,
      headingLine: lineNumber,
      versionText: parsed?.versionText ?? null,
      version: parsed?.version ?? null,
      title: parsed?.title ?? null,
      dateText: parsed?.dateText ?? null,
      date: parsed?.date ?? null,
      bodyStartLine: lineNumber + 1,
      bodyEndLine: lineNumber,
      bullets: [],
    };
  });
  finishSection(lines.length);

  const headed = sections.filter((section) => section.kind !== "malformed");
  if (!headed.some((section) => section.kind === "unreleased")) {
    errors.push(`${at(1)}: \`${UNRELEASED_HEADING}\` must be the first \`##\` section`);
  } else if (headed[0].kind !== "unreleased") {
    errors.push(`${at(headed[0].headingLine)}: \`${UNRELEASED_HEADING}\` must be the first \`##\` section`);
  }

  for (const section of sections) {
    if (section.kind !== "malformed") {
      continue;
    }
    errors.push(
      `${at(section.headingLine)}: version section must match `
      + "`## X.Y.Z — <title> (YYYY-MM-DD)` with a valid semver, a non-empty title, "
      + "and a real calendar date",
    );
  }

  for (const section of sections) {
    if (section.kind !== "version") {
      continue;
    }
    if (section.version === null) {
      errors.push(`${at(section.headingLine)}: \`${section.versionText}\` is not a valid semver version`);
      continue;
    }
    if (section.title.length === 0) {
      errors.push(`${at(section.headingLine)}: version section title must not be empty`);
    }
    if (!isRealCalendarDate(section.date.year, section.date.month, section.date.day)) {
      errors.push(`${at(section.headingLine)}: \`${section.dateText}\` is not a real calendar date`);
    }
  }

  const versions = sections.filter((section) => section.kind === "version" && section.version !== null);
  const seen = new Map();
  for (const section of versions) {
    const previous = seen.get(section.versionText);
    if (previous !== undefined) {
      errors.push(
        `${at(section.headingLine)}: duplicate version section \`${section.versionText}\` `
        + `(first at line ${previous})`,
      );
    } else {
      seen.set(section.versionText, section.headingLine);
    }
  }
  for (let index = 1; index < versions.length; index += 1) {
    if (compareSemver(versions[index - 1].version, versions[index].version) <= 0) {
      errors.push(
        `${at(versions[index].headingLine)}: version sections must descend strictly by semver; `
        + `\`${versions[index].versionText}\` does not come after \`${versions[index - 1].versionText}\``,
      );
    }
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (TRAILING_WHITESPACE_PATTERN.test(line)) {
      errors.push(`${at(lineNumber)}: trailing whitespace`);
    }
    if (BAD_BULLET_PATTERN.test(line)) {
      errors.push(`${at(lineNumber)}: bullet markers must start with \`- \` (dash followed by a space)`);
    }
  });

  for (const section of sections) {
    for (let lineNumber = section.bodyStartLine; lineNumber <= section.bodyEndLine; lineNumber += 1) {
      const line = lines[lineNumber - 1];
      if (line !== undefined && line.startsWith("- ")) {
        section.bullets.push({ line: lineNumber, text: line.slice(2) });
      }
    }
  }

  return { sections, errors };
}

export function checkChangelogStructure(text, fileName = CHANGELOG_FILE_NAME) {
  return parseChangelog(text, fileName).errors;
}

export function releasedVersionsFromTags(tagNames) {
  const versions = [];
  for (const tag of tagNames) {
    const match = TAG_PATTERN.exec(tag.trim());
    if (match) {
      versions.push(match[1]);
    }
  }
  return versions;
}

export function checkPublishedCoverage({ changelogText, tagNames, fileName = CHANGELOG_FILE_NAME }) {
  if (tagNames.length === 0) {
    return { errors: [], note: "tags unavailable, coverage not checked", grandfathered: [] };
  }
  const { sections } = parseChangelog(changelogText, fileName);
  const sectioned = sections.filter((section) => section.kind === "version" && section.version !== null);
  // The changelog does not go back that far: tags older than the oldest
  // version section present in the file predate release notes and are
  // grandfathered. The boundary is derived from the file, so extending the
  // history backwards tightens the gate automatically. Grandfathered tags
  // are reported, never silent.
  const oldest = sectioned.reduce(
    (min, section) => (min === null || compareSemver(section.version, min) < 0 ? section.version : min),
    null,
  );
  const oldestText = sectioned.find((section) => oldest !== null && compareSemver(section.version, oldest) === 0)
    ?.versionText ?? null;
  const errors = [];
  const grandfathered = [];
  for (const version of releasedVersionsFromTags(tagNames)) {
    if (oldest !== null && compareSemver(parseSemver(version), oldest) < 0) {
      grandfathered.push(version);
      continue;
    }
    if (!sectioned.some((section) => section.versionText === version)) {
      errors.push(`${fileName}: published tag \`v${version}\` has no matching \`## ${version}\` section`);
    }
  }
  grandfathered.sort(compareSemverStrings);
  return { errors, note: null, grandfathered, grandfatheredOlderThan: oldestText };
}

function compareSemverStrings(left, right) {
  return compareSemver(parseSemver(left), parseSemver(right));
}

export function parsePrLabels(raw) {
  const text = (raw ?? "").trim();
  if (text === "" || text === "null") {
    return [];
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((label) => String(label).trim()).filter(Boolean);
      }
    } catch {
      return [];
    }
    return [];
  }
  return text.split(",").map((label) => label.trim()).filter(Boolean);
}

function bulletCounts(bullets) {
  const counts = new Map();
  for (const bullet of bullets) {
    counts.set(bullet.text, (counts.get(bullet.text) ?? 0) + 1);
  }
  return counts;
}

export function evaluatePrGate({
  baseText,
  headText,
  labels = [],
  prBody = "",
  fileName = CHANGELOG_FILE_NAME,
}) {
  if (labels.includes(SKIP_CHANGELOG_LABEL)) {
    return { status: "pass", detail: `escape hatch: \`${SKIP_CHANGELOG_LABEL}\` label` };
  }
  if (CHANGELOG_NONE_PATTERN.test(prBody ?? "")) {
    return { status: "pass", detail: "escape hatch: `Changelog: none` in the PR body" };
  }
  const base = parseChangelog(baseText, `base:${fileName}`);
  const head = parseChangelog(headText, fileName);
  const baseVersions = new Set(
    base.sections.filter((section) => section.kind === "version").map((section) => section.versionText),
  );
  const versionSectionAdded = head.sections.some(
    (section) => section.kind === "version" && !baseVersions.has(section.versionText),
  );
  const baseUnreleased = base.sections.find((section) => section.kind === "unreleased");
  const headUnreleased = head.sections.find((section) => section.kind === "unreleased");
  const remaining = bulletCounts(baseUnreleased?.bullets ?? []);
  let added = 0;
  for (const bullet of headUnreleased?.bullets ?? []) {
    const left = remaining.get(bullet.text) ?? 0;
    if (left > 0) {
      remaining.set(bullet.text, left - 1);
    } else {
      added += 1;
    }
  }
  if (added > 0) {
    return { status: "pass", detail: `${added} new bullet(s) under \`## Unreleased\`` };
  }
  if (versionSectionAdded) {
    return { status: "pass", detail: "release cut: new version section, no new `## Unreleased` bullets required" };
  }
  return {
    status: "fail",
    detail: `${fileName}: PR adds no new bullet under \`## Unreleased\``,
  };
}

async function defaultGit(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error?.code ?? 1, stdout: error?.stdout ?? "" };
  }
}

export async function runCheckChangelog(options = {}) {
  const cwd = options.cwd ?? repoRootFromScript();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const git = options.git ?? ((args) => defaultGit(args, cwd));
  const changelogText = options.changelogText
    ?? await readFile(join(cwd, CHANGELOG_FILE_NAME), "utf8").catch((error) => {
      throw new Error(`cannot read ${CHANGELOG_FILE_NAME}: ${error.message}`);
    });

  const failures = [];
  const notes = [];

  const structureErrors = checkChangelogStructure(changelogText);
  failures.push(...structureErrors);
  stdout.write(
    structureErrors.length === 0
      ? "changelog structure: ok\n"
      : `changelog structure: ${structureErrors.length} problem(s)\n`,
  );

  const tagsResult = await git(["tag", "--list", "v*"]);
  const tagNames = tagsResult.status === 0
    ? tagsResult.stdout.split("\n").map((tag) => tag.trim()).filter(Boolean)
    : [];
  if (tagsResult.status !== 0 || tagNames.length === 0) {
    const note = "tags unavailable, coverage not checked";
    notes.push(note);
    stdout.write(`published-version coverage: ${note}\n`);
  } else {
    const coverage = checkPublishedCoverage({ changelogText, tagNames });
    failures.push(...coverage.errors);
    const covered = releasedVersionsFromTags(tagNames).length - coverage.grandfathered.length;
    if (coverage.grandfathered.length > 0) {
      stdout.write(
        `published-version coverage: grandfathered ${coverage.grandfathered.length} tag(s) `
        + `older than the oldest sectioned version (${coverage.grandfatheredOlderThan}): `
        + `${coverage.grandfathered.map((version) => `v${version}`).join(", ")}\n`,
      );
    }
    stdout.write(
      coverage.errors.length === 0
        ? `published-version coverage: ok (${covered} tag(s))\n`
        : `published-version coverage: ${coverage.errors.length} problem(s)\n`,
    );
  }

  const baseRef = (env.CHANGELOG_BASE_REF ?? "").trim();
  if (baseRef === "") {
    const note = "not a PR context (CHANGELOG_BASE_REF is empty), PR entry gate not checked";
    notes.push(note);
    stdout.write(`PR entry gate: ${note}\n`);
  } else {
    const baseFile = await git(["show", `${baseRef}:${CHANGELOG_FILE_NAME}`]);
    if (baseFile.status !== 0) {
      failures.push(`${CHANGELOG_FILE_NAME}: cannot read base file at \`${baseRef}\` for the PR entry gate`);
    } else {
      const gate = evaluatePrGate({
        baseText: baseFile.stdout,
        headText: changelogText,
        labels: parsePrLabels(env.CHANGELOG_PR_LABELS),
        prBody: env.CHANGELOG_PR_BODY ?? "",
      });
      if (gate.status === "pass") {
        stdout.write(`PR entry gate: pass (${gate.detail})\n`);
      } else {
        failures.push(gate.detail);
      }
    }
  }

  if (failures.length > 0) {
    stderr.write("Changelog check failed:\n");
    for (const failure of failures) {
      stderr.write(`- ${failure}\n`);
    }
    return { exitCode: 1, failures, notes };
  }
  stdout.write("Changelog check passed.\n");
  return { exitCode: 0, failures, notes };
}

async function main() {
  try {
    const result = await runCheckChangelog();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
