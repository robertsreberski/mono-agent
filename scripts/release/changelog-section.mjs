#!/usr/bin/env node
/**
 * changelog-section.mjs — print one version section for use as release notes.
 *
 * Usage:
 *   node scripts/release/changelog-section.mjs --version X.Y.Z
 *
 * Prints the body of the `## X.Y.Z — <title> (<date>)` section (without the
 * heading line) to stdout. A leading `v` on the version is accepted. Exits
 * non-zero naming the missing section when the version is not filed, so the
 * release workflow fails instead of publishing empty notes.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CHANGELOG_FILE_NAME, parseChangelog } from "../check-changelog.mjs";

export function parseSectionArgs(argv) {
  let version = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      version = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { version: version?.startsWith("v") ? version.slice(1) : version, help };
}

export function sectionUsage() {
  return [
    "Print one CHANGELOG version section body for use as release notes.",
    "",
    "Usage:",
    "  node scripts/release/changelog-section.mjs --version X.Y.Z",
  ].join("\n");
}

/**
 * Pure extraction: returns the section body or throws naming the problem.
 */
export function extractChangelogSection(text, version) {
  if ((version ?? "").trim() === "") {
    throw new Error("A --version X.Y.Z argument is required.");
  }
  const { sections } = parseChangelog(text);
  const section = sections.find((item) => item.kind === "version" && item.versionText === version);
  if (section === undefined) {
    throw new Error(`${CHANGELOG_FILE_NAME} has no \`## ${version}\` section.`);
  }
  const lines = text.split("\n");
  const body = lines.slice(section.bodyStartLine - 1, section.bodyEndLine);
  while (body.length > 0 && body[0].trim() === "") {
    body.shift();
  }
  while (body.length > 0 && body[body.length - 1].trim() === "") {
    body.pop();
  }
  return `${body.join("\n")}\n`;
}

export async function runChangelogSection(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const read = options.readFile ?? readFile;

  let args;
  try {
    args = parseSectionArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${sectionUsage()}\n`);
    return { exitCode: 1 };
  }
  if (args.help || args.version === null) {
    stdout.write(`${sectionUsage()}\n`);
    return { exitCode: args.help ? 0 : 1 };
  }

  let text;
  try {
    text = await read(join(root, CHANGELOG_FILE_NAME), "utf8");
  } catch (error) {
    stderr.write(`cannot read ${CHANGELOG_FILE_NAME}: ${error.message}\n`);
    return { exitCode: 1 };
  }

  try {
    stdout.write(extractChangelogSection(text, args.version));
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}

async function main() {
  const result = await runChangelogSection();
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
