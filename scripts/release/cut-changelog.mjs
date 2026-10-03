#!/usr/bin/env node
/**
 * cut-changelog.mjs — move `## Unreleased` entries into a new version section.
 *
 * Usage:
 *   node scripts/release/cut-changelog.mjs --version X.Y.Z --title "Short theme" [--date YYYY-MM-DD]
 *   node scripts/release/cut-changelog.mjs --version X.Y.Z --title "Short theme" --check
 *
 * Moves everything under `## Unreleased` into a new `## X.Y.Z — <title> (<date>)`
 * section directly below a freshly emptied `## Unreleased`. The date defaults
 * to today in UTC. `--check` prints what would happen without writing.
 *
 * Refuses with a specific message and a non-zero exit when `## Unreleased`
 * has nothing to cut, the version already has a section, the version is not
 * greater than the current newest section, or the file fails the structure
 * check in `scripts/check-changelog.mjs`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CHANGELOG_FILE_NAME,
  checkChangelogStructure,
  compareSemver,
  isRealCalendarDate,
  parseChangelog,
  parseSemver,
} from "../check-changelog.mjs";

export function parseCutArgs(argv) {
  const args = { version: null, title: null, date: null, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      args.version = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--title") {
      args.title = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--date") {
      args.date = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--check") {
      args.check = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function cutUsage() {
  return [
    "Cut ## Unreleased entries into a new version section.",
    "",
    "Usage:",
    '  node scripts/release/cut-changelog.mjs --version X.Y.Z --title "Short theme" [--date YYYY-MM-DD] [--check]',
  ].join("\n");
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function parseCutDate(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText ?? "");
  if (!match) {
    return null;
  }
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isRealCalendarDate(date.year, date.month, date.day) ? dateText : null;
}

/**
 * Pure cut: returns the new file text or throws a refusal. Never touches disk.
 */
export function cutChangelog({ text, version, title, date = todayUtc() }) {
  const structureErrors = checkChangelogStructure(text);
  if (structureErrors.length > 0) {
    throw new Error(`${CHANGELOG_FILE_NAME} fails the structure check:\n${structureErrors.map((error) => `- ${error}`).join("\n")}`);
  }
  const parsedVersion = parseSemver(version ?? "");
  if (parsedVersion === null) {
    throw new Error(`Version must be semver X.Y.Z with an optional prerelease; received \`${version ?? "(missing)"}\`.`);
  }
  if ((title ?? "").trim() === "") {
    throw new Error("A non-empty --title naming the release theme is required.");
  }
  const cutDate = parseCutDate(date);
  if (cutDate === null) {
    throw new Error(`Date must be a real calendar date YYYY-MM-DD; received \`${date ?? "(missing)"}\`.`);
  }

  const { sections } = parseChangelog(text);
  const unreleased = sections.find((section) => section.kind === "unreleased");
  const versioned = sections.filter((section) => section.kind === "version");
  if (versioned.some((section) => section.versionText === version)) {
    throw new Error(`${CHANGELOG_FILE_NAME} already has a \`## ${version}\` section.`);
  }
  const newest = versioned.reduce(
    (max, section) => (max === null || compareSemver(section.version, max.version) > 0 ? section : max),
    null,
  );
  if (newest !== null && compareSemver(parsedVersion, newest.version) <= 0) {
    throw new Error(
      `Version \`${version}\` is not greater than the current newest section \`## ${newest.versionText}\`.`,
    );
  }

  const lines = text.split("\n");
  const trailingBlank = lines.length > 0 && lines[lines.length - 1] === "" ? [""] : [];
  const body = lines.slice(0, lines.length - trailingBlank.length);
  const headingIndex = unreleased.headingLine - 1;
  const nextHeadingIndex = body.findIndex((line, index) => index > headingIndex && line.startsWith("## "));
  const endIndex = nextHeadingIndex === -1 ? body.length : nextHeadingIndex;
  const moved = body.slice(headingIndex + 1, endIndex);
  if (!moved.some((line) => line.trim() !== "")) {
    throw new Error(`\`## Unreleased\` has no entries to cut; add bullets before cutting \`v${version}\`.`);
  }

  const heading = `## ${version} — ${title.trim()} (${cutDate})`;
  const output = [...body.slice(0, headingIndex + 1), "", heading, ...moved, ...body.slice(endIndex)];
  const movedBullets = moved.filter((line) => line.startsWith("- ")).length;
  return { text: [...output, ...trailingBlank].join("\n"), heading, movedBullets };
}

export async function runCutChangelog(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const read = options.readFile ?? readFile;
  const write = options.writeFile ?? writeFile;

  let args;
  try {
    args = parseCutArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${cutUsage()}\n`);
    return { exitCode: 1 };
  }
  if (args.help || args.version === null) {
    stdout.write(`${cutUsage()}\n`);
    return { exitCode: args.help ? 0 : 1 };
  }

  const filePath = join(root, CHANGELOG_FILE_NAME);
  let text;
  try {
    text = await read(filePath, "utf8");
  } catch (error) {
    stderr.write(`cannot read ${CHANGELOG_FILE_NAME}: ${error.message}\n`);
    return { exitCode: 1 };
  }

  let cut;
  try {
    cut = cutChangelog({ text, version: args.version, title: args.title, date: args.date ?? todayUtc() });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }

  if (args.check) {
    stdout.write(`Would cut ${cut.movedBullets} Unreleased bullet(s) into \`${cut.heading}\`.\n`);
    return { exitCode: 0 };
  }
  await write(filePath, cut.text, "utf8");
  stdout.write(`Cut ${cut.movedBullets} Unreleased bullet(s) into \`${cut.heading}\`.\n`);
  return { exitCode: 0 };
}

async function main() {
  const result = await runCutChangelog();
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
