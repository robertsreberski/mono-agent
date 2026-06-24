#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const forbiddenTerms = [
  { label: "downstream-agent-personal", value: parts("personal", "agent") },
  { label: "downstream-agent-a8c", value: parts("a8c", "agent") },
  { label: "downstream-agent-work", value: parts("work", "agent") },
  { label: "downstream-repo-path", value: parts("a8c", "agents") },
  { label: "operator-path", value: slashPath("Users", word("roberts", "reberski")) },
  { label: "operator-username", value: word("roberts", "reberski") },
  { label: "operator-name", value: word("Ro", "bert") },
  { label: "operator-entity-id", value: `person:${word("ro", "bert")}` },
  { label: "personal-contact-paola", value: word("Pao", "la") },
  { label: "personal-contact-ambra", value: word("Am", "bra") },
  { label: "work-org-name", value: word("Auto", "mattic") },
  { label: "work-cli-profile", value: parts("a8c", "cli") },
  { label: "work-gws-profile", value: parts("gws", "a8c") },
];

const allowedRangePatterns = [
  new RegExp(`${escapeRegExp(`https://github.com/${word("roberts", "reberski")}/mono-agent`)}(?:[^\\s<> )"']*)?`, "gu"),
];

export function scanSanitizedText(text, options = {}) {
  const file = options.file ?? "<text>";
  const allowedRanges = allowedRangePatterns.flatMap((pattern) => rangesForPattern(text, pattern));
  const findings = [];

  for (const term of forbiddenTerms) {
    let start = 0;
    while (start < text.length) {
      const index = text.indexOf(term.value, start);
      if (index === -1) {
        break;
      }
      const end = index + term.value.length;
      if (!rangesOverlapAny(index, end, allowedRanges)) {
        const location = locationForIndex(text, index);
        findings.push({
          file,
          line: location.line,
          column: location.column,
          label: term.label,
        });
      }
      start = end;
    }
  }

  return findings.sort(compareFindings);
}

export async function runCheckSanitizedContent(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandDefault;

  const listed = await runCommand("git", ["ls-files", "-z"], { cwd });
  if (listed.status !== 0) {
    stderr.write(listed.stderr.length > 0 ? listed.stderr : "git ls-files failed\n");
    return { exitCode: 1, findings: [] };
  }

  const files = listed.stdout.split("\0").filter(Boolean).sort();
  const findings = [];
  for (const file of files) {
    findings.push(...scanSanitizedText(file, { file, pathOnly: true }).map((finding) => ({
      ...finding,
      line: 0,
    })));

    const fullPath = resolve(cwd, file);
    let buffer;
    try {
      buffer = await readFile(fullPath);
    } catch {
      continue;
    }
    if (buffer.includes(0)) {
      continue;
    }
    findings.push(...scanSanitizedText(buffer.toString("utf8"), { file }));
  }

  stdout.write(renderSanitizedContentReport(findings));
  return { exitCode: findings.length === 0 ? 0 : 1, findings };
}

export function renderSanitizedContentReport(findings) {
  if (findings.length === 0) {
    return "Sanitized content check passed\n";
  }

  const lines = [
    "Sanitized content check failed",
    `Findings: ${findings.length}`,
  ];
  for (const finding of findings.sort(compareFindings)) {
    lines.push(`  ${sanitizeForReport(finding.file)}:${finding.line}:${finding.column} label=${finding.label}`);
  }
  return `${lines.join("\n")}\n`;
}

function rangesForPattern(text, pattern) {
  const ranges = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) {
      continue;
    }
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function rangesOverlapAny(start, end, ranges) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function locationForIndex(text, index) {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function compareFindings(a, b) {
  return a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column
    || a.label.localeCompare(b.label);
}

function sanitizeForReport(value) {
  let result = value;
  for (const term of [...forbiddenTerms].sort((a, b) => b.value.length - a.value.length)) {
    result = result.split(term.value).join(`[${term.label}]`);
  }
  return result;
}

function parts(...values) {
  return values.join("-");
}

function slashPath(...values) {
  return `/${values.join("/")}`;
}

function word(...values) {
  return values.join("");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function runCommandDefault(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : String(error),
    };
  }
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runCheckSanitizedContent();
  process.exitCode = result.exitCode;
}
