import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DENYLIST_FILES = [
  ".mono-agent/repo-visible-denylist.jsonl",
  ".mono-agent/repo-visible-denylist.txt",
] as const;

const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export type RepoVisibleGuardErrorCode =
  | "denylist_parse_failed"
  | "denylist_read_failed"
  | "repo_visible_denylist_match"
  | "repo_visible_scan_failed";

export type RepoVisibleGuardErrorDetails = Record<string, unknown>;

export class RepoVisibleGuardError extends Error {
  readonly code: RepoVisibleGuardErrorCode;
  readonly details: RepoVisibleGuardErrorDetails;

  constructor(code: RepoVisibleGuardErrorCode, message: string, details: RepoVisibleGuardErrorDetails = {}) {
    super(message);
    this.name = "RepoVisibleGuardError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface CreateRepoVisibleDenylistEntry {
  readonly label?: string;
  readonly value: string;
  readonly variants?: readonly string[];
}

export interface RepoVisibleDenylistEntry {
  readonly label: string;
  readonly value: string;
  readonly variants: readonly string[];
  readonly source?: string;
}

export interface RepoVisibleDenylistSource {
  readonly kind: "env" | "file" | "default-file" | "empty";
  readonly reference: string;
  readonly entryCount: number;
}

export interface RepoVisibleDenylist {
  readonly entries: readonly RepoVisibleDenylistEntry[];
  readonly sources: readonly RepoVisibleDenylistSource[];
  readonly warnings: readonly string[];
}

export interface LoadRepoVisibleDenylistOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly filePath?: string;
}

export interface RepoVisibleFinding {
  readonly surface: string;
  readonly identifier?: string;
  readonly fieldPath: string;
  readonly label: string;
  readonly matchKind: "literal" | "generated_variant";
  readonly line?: number;
  readonly column?: number;
}

export interface ScanRepoVisibleValueOptions {
  readonly surface?: string;
  readonly identifier?: string;
  readonly fieldPath?: string;
}

export interface RepoVisibleScanSource {
  readonly kind: "local_files" | "github_metadata";
  readonly scanned: number;
  readonly skipped: number;
  readonly warnings: readonly string[];
}

export interface RepoVisibleScanResult {
  readonly findings: readonly RepoVisibleFinding[];
  readonly sources: readonly RepoVisibleScanSource[];
}

export interface RepoVisibleCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

export type RepoVisibleCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<RepoVisibleCommandResult>;

export interface ScanLocalRepoFilesOptions {
  readonly cwd?: string;
  readonly denylist: RepoVisibleDenylist | readonly RepoVisibleDenylistEntry[];
  readonly includeUntracked?: boolean;
  readonly maxFileBytes?: number;
  readonly runCommand?: RepoVisibleCommandRunner;
}

export interface ScanGitHubRepoMetadataOptions {
  readonly cwd?: string;
  readonly repo: string;
  readonly denylist: RepoVisibleDenylist | readonly RepoVisibleDenylistEntry[];
  readonly runCommand?: RepoVisibleCommandRunner;
}

interface NormalizedRawEntry {
  readonly label?: string;
  readonly value: string;
  readonly variants?: readonly string[];
}

interface TextScanInput {
  readonly text: string;
  readonly denylist: readonly RepoVisibleDenylistEntry[];
  readonly surface: string;
  readonly fieldPath: string;
  readonly identifier?: string;
}

export async function loadRepoVisibleDenylist(options: LoadRepoVisibleDenylistOptions = {}): Promise<RepoVisibleDenylist> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const rawEntries: NormalizedRawEntry[] = [];
  const sources: RepoVisibleDenylistSource[] = [];

  const envRaw = env.MONO_AGENT_REPO_VISIBLE_DENYLIST?.trim();
  if (envRaw !== undefined && envRaw.length > 0) {
    const parsed = parseDenylistText(envRaw, "MONO_AGENT_REPO_VISIBLE_DENYLIST");
    rawEntries.push(...parsed);
    sources.push({ kind: "env", reference: "MONO_AGENT_REPO_VISIBLE_DENYLIST", entryCount: parsed.length });
  }

  const explicitFile = options.filePath ?? env.MONO_AGENT_REPO_VISIBLE_DENYLIST_FILE?.trim();
  if (explicitFile !== undefined && explicitFile.length > 0) {
    const resolvedPath = resolve(cwd, explicitFile);
    const parsed = await readDenylistFile(resolvedPath, "file");
    rawEntries.push(...parsed);
    sources.push({ kind: "file", reference: resolvedPath, entryCount: parsed.length });
  } else {
    for (const file of DEFAULT_DENYLIST_FILES) {
      const resolvedPath = resolve(cwd, file);
      if (!existsSync(resolvedPath)) {
        continue;
      }
      const parsed = await readDenylistFile(resolvedPath, "default-file");
      rawEntries.push(...parsed);
      sources.push({ kind: "default-file", reference: resolvedPath, entryCount: parsed.length });
    }
  }

  return createDenylistWithSources(rawEntries, sources);
}

export function loadRepoVisibleDenylistSync(options: LoadRepoVisibleDenylistOptions = {}): RepoVisibleDenylist {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const rawEntries: NormalizedRawEntry[] = [];
  const sources: RepoVisibleDenylistSource[] = [];

  const envRaw = env.MONO_AGENT_REPO_VISIBLE_DENYLIST?.trim();
  if (envRaw !== undefined && envRaw.length > 0) {
    const parsed = parseDenylistText(envRaw, "MONO_AGENT_REPO_VISIBLE_DENYLIST");
    rawEntries.push(...parsed);
    sources.push({ kind: "env", reference: "MONO_AGENT_REPO_VISIBLE_DENYLIST", entryCount: parsed.length });
  }

  const explicitFile = options.filePath ?? env.MONO_AGENT_REPO_VISIBLE_DENYLIST_FILE?.trim();
  if (explicitFile !== undefined && explicitFile.length > 0) {
    const resolvedPath = resolve(cwd, explicitFile);
    const parsed = readDenylistFileSync(resolvedPath);
    rawEntries.push(...parsed);
    sources.push({ kind: "file", reference: resolvedPath, entryCount: parsed.length });
  } else {
    for (const file of DEFAULT_DENYLIST_FILES) {
      const resolvedPath = resolve(cwd, file);
      if (!existsSync(resolvedPath)) {
        continue;
      }
      const parsed = readDenylistFileSync(resolvedPath);
      rawEntries.push(...parsed);
      sources.push({ kind: "default-file", reference: resolvedPath, entryCount: parsed.length });
    }
  }

  return createDenylistWithSources(rawEntries, sources);
}

export function createRepoVisibleDenylist(entries: readonly CreateRepoVisibleDenylistEntry[]): RepoVisibleDenylist {
  return createDenylistWithSources(entries, [{ kind: "empty", reference: "in-memory", entryCount: entries.length }]);
}

export function scanRepoVisibleValue(
  value: unknown,
  denylistInput: RepoVisibleDenylist | readonly RepoVisibleDenylistEntry[],
  options: ScanRepoVisibleValueOptions = {},
): readonly RepoVisibleFinding[] {
  const denylist = entriesFromDenylist(denylistInput);
  if (denylist.length === 0) {
    return [];
  }

  const findings: RepoVisibleFinding[] = [];
  const seen = new WeakSet<object>();
  scanUnknownValue(value, {
    denylist,
    surface: options.surface ?? "payload",
    fieldPath: options.fieldPath ?? "$",
    ...(options.identifier === undefined ? {} : { identifier: options.identifier }),
  }, seen, findings);
  return findings;
}

export function guardRepoVisiblePayload(
  value: unknown,
  options: ScanRepoVisibleValueOptions & { readonly denylist: RepoVisibleDenylist | readonly RepoVisibleDenylistEntry[] },
): void {
  const findings = scanRepoVisibleValue(value, options.denylist, options);
  if (findings.length === 0) {
    return;
  }

  const summary = summarizeFindings(findings);
  throw new RepoVisibleGuardError("repo_visible_denylist_match", `Repo-visible payload blocked by local denylist: ${summary}.`, {
    surface: options.surface ?? "payload",
    findings,
  });
}

export function sanitizeRepoVisibleString(
  value: string,
  options: {
    readonly denylist: RepoVisibleDenylist | readonly RepoVisibleDenylistEntry[];
    readonly replacement?: string | ((entry: RepoVisibleDenylistEntry) => string);
  },
): string {
  let sanitized = value;
  const entries = entriesFromDenylist(options.denylist);
  const variants = entries
    .flatMap((entry) => entry.variants.map((variant) => ({ entry, variant })))
    .filter(({ variant }) => variant.length > 0)
    .sort((a, b) => b.variant.length - a.variant.length);

  for (const { entry, variant } of variants) {
    const replacement = typeof options.replacement === "function"
      ? options.replacement(entry)
      : options.replacement ?? `[redacted:${entry.label}]`;
    sanitized = sanitized.split(variant).join(replacement);
  }
  return sanitized;
}

export function repoVisibleSlugVariant(value: string): string {
  return slugVariant(value);
}

export async function scanLocalRepoFiles(options: ScanLocalRepoFilesOptions): Promise<RepoVisibleScanResult> {
  const cwd = options.cwd ?? process.cwd();
  const denylist = entriesFromDenylist(options.denylist);
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const warnings: string[] = [];
  const tracked = await gitLsFiles(cwd, ["ls-files", "-z"], runCommand);
  const untracked = options.includeUntracked === true
    ? await gitLsFiles(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], runCommand)
    : [];
  const files = [...new Set([...tracked, ...untracked])].sort();
  const findings: RepoVisibleFinding[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const file of files) {
    if (shouldSkipLocalFile(file)) {
      skipped += 1;
      continue;
    }

    const fullPath = resolve(cwd, file);
    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch (error) {
      skipped += 1;
      warnings.push(`Skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!fileStat.isFile() || fileStat.size > maxFileBytes) {
      skipped += 1;
      continue;
    }

    const buffer = await readFile(fullPath);
    if (buffer.includes(0)) {
      skipped += 1;
      continue;
    }

    scanned += 1;
    findings.push(...scanTextForDenylist({
      text: buffer.toString("utf8"),
      denylist,
      surface: "local_file",
      identifier: file,
      fieldPath: "content",
    }));
  }

  return {
    findings,
    sources: [{ kind: "local_files", scanned, skipped, warnings }],
  };
}

export async function scanGitHubRepoMetadata(options: ScanGitHubRepoMetadataOptions): Promise<RepoVisibleScanResult> {
  const cwd = options.cwd ?? process.cwd();
  const repo = normalizeGitHubRepo(options.repo);
  const denylist = entriesFromDenylist(options.denylist);
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const findings: RepoVisibleFinding[] = [];
  const warnings: string[] = [];
  let scanned = 0;

  const issues = await ghApiArray(cwd, runCommand, `repos/${repo}/issues?state=all&per_page=100`);
  for (const issue of issues) {
    if (!isRecord(issue)) {
      continue;
    }
    if (isRecord(issue.pull_request)) {
      continue;
    }
    const number = readNumber(issue.number);
    const surface = "github_issue";
    const identifier = number === undefined ? surface : `${surface}#${number}`;
    scanned += scanGitHubRecord(issue, denylist, findings, surface, identifier, ["title", "body"]);
  }

  const issueComments = await ghApiArray(cwd, runCommand, `repos/${repo}/issues/comments?per_page=100`);
  for (const comment of issueComments) {
    if (!isRecord(comment)) {
      continue;
    }
    const id = readNumber(comment.id);
    const identifier = id === undefined ? "github_issue_comment" : `github_issue_comment#${id}`;
    scanned += scanGitHubRecord(comment, denylist, findings, "github_issue_comment", identifier, ["body"]);
  }

  const pulls = await ghApiArray(cwd, runCommand, `repos/${repo}/pulls?state=all&per_page=100`);
  const pullNumbers: number[] = [];
  for (const pull of pulls) {
    if (!isRecord(pull)) {
      continue;
    }
    const number = readNumber(pull.number);
    if (number !== undefined) {
      pullNumbers.push(number);
    }
    const identifier = number === undefined ? "github_pr" : `github_pr#${number}`;
    scanned += scanGitHubRecord(pull, denylist, findings, "github_pr", identifier, ["title", "body"]);
    scanned += scanGitHubNestedRecord(pull, denylist, findings, "github_pr", identifier, [["head", "ref"], ["base", "ref"]]);
  }

  const reviewComments = await ghApiArray(cwd, runCommand, `repos/${repo}/pulls/comments?per_page=100`);
  for (const comment of reviewComments) {
    if (!isRecord(comment)) {
      continue;
    }
    const id = readNumber(comment.id);
    const identifier = id === undefined ? "github_review_comment" : `github_review_comment#${id}`;
    scanned += scanGitHubRecord(comment, denylist, findings, "github_review_comment", identifier, ["body"]);
  }

  for (const pullNumber of pullNumbers) {
    try {
      const reviews = await ghApiArray(cwd, runCommand, `repos/${repo}/pulls/${pullNumber}/reviews?per_page=100`);
      for (const review of reviews) {
        if (!isRecord(review)) {
          continue;
        }
        const id = readNumber(review.id);
        const identifier = id === undefined ? `github_pr_review#${pullNumber}` : `github_pr_review#${id}`;
        scanned += scanGitHubRecord(review, denylist, findings, "github_pr_review", identifier, ["body"]);
      }
    } catch (error) {
      warnings.push(`Skipped PR #${pullNumber} reviews: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    findings,
    sources: [{ kind: "github_metadata", scanned, skipped: 0, warnings }],
  };
}

async function readDenylistFile(path: string, sourceKind: "file" | "default-file"): Promise<readonly NormalizedRawEntry[]> {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new RepoVisibleGuardError("denylist_read_failed", `Unable to read repo-visible denylist file: ${path}`, {
      sourceKind,
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return parseDenylistText(text, path);
}

function readDenylistFileSync(path: string): readonly NormalizedRawEntry[] {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new RepoVisibleGuardError("denylist_read_failed", `Unable to read repo-visible denylist file: ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return parseDenylistText(text, path);
}

function parseDenylistText(text: string, source: string): readonly NormalizedRawEntry[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    try {
      return parseJsonDenylist(JSON.parse(trimmed), source);
    } catch (error) {
      if (error instanceof RepoVisibleGuardError) {
        throw error;
      }
      throw new RepoVisibleGuardError("denylist_parse_failed", `Invalid repo-visible denylist JSON at ${source}.`, {
        source,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const entries: NormalizedRawEntry[] = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    try {
      if (line.startsWith("{") || line.startsWith("\"")) {
        entries.push(parseDenylistEntry(JSON.parse(line), source, index + 1));
      } else {
        entries.push({ value: line });
      }
    } catch (error) {
      throw new RepoVisibleGuardError("denylist_parse_failed", `Invalid repo-visible denylist entry at ${source}:${index + 1}.`, {
        source,
        line: index + 1,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return entries;
}

function parseJsonDenylist(value: unknown, source: string): readonly NormalizedRawEntry[] {
  if (!Array.isArray(value)) {
    throw new RepoVisibleGuardError("denylist_parse_failed", "Repo-visible denylist JSON must be an array.", { source });
  }
  return value.map((entry, index) => parseDenylistEntry(entry, source, index + 1));
}

function parseDenylistEntry(value: unknown, source: string, ordinal: number): NormalizedRawEntry {
  if (typeof value === "string") {
    return { value };
  }
  if (!isRecord(value)) {
    throw new RepoVisibleGuardError("denylist_parse_failed", "Repo-visible denylist entries must be strings or objects.", {
      source,
      ordinal,
    });
  }
  if (typeof value.value !== "string") {
    throw new RepoVisibleGuardError("denylist_parse_failed", "Repo-visible denylist object entries require a string value.", {
      source,
      ordinal,
    });
  }
  const label = value.label === undefined ? undefined : requireString(value.label, "label", source, ordinal);
  const variants = value.variants === undefined
    ? undefined
    : requireStringArray(value.variants, "variants", source, ordinal);
  return {
    ...(label === undefined ? {} : { label }),
    value: value.value,
    ...(variants === undefined ? {} : { variants }),
  };
}

function createDenylistWithSources(
  entries: readonly CreateRepoVisibleDenylistEntry[],
  sources: readonly RepoVisibleDenylistSource[],
): RepoVisibleDenylist {
  const normalizedEntries: RepoVisibleDenylistEntry[] = [];
  let ordinal = 1;
  for (const entry of entries) {
    const value = normalizeDenylistValue(entry.value);
    if (value === undefined) {
      continue;
    }
    const label = normalizeLabel(entry.label, ordinal);
    normalizedEntries.push({
      label,
      value,
      variants: buildEntryVariants(value, entry.variants),
    });
    ordinal += 1;
  }

  const sourceList = sources.length === 0
    ? [{ kind: "empty" as const, reference: "no denylist configured", entryCount: 0 }]
    : sources;
  const warnings = normalizedEntries.length === 0
    ? ["No repo-visible denylist entries loaded; GitHub metadata guard checks will be a no-op."]
    : [];

  return { entries: normalizedEntries, sources: sourceList, warnings };
}

function normalizeDenylistValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function normalizeLabel(label: string | undefined, ordinal: number): string {
  if (label === undefined || label.trim().length === 0) {
    return `entry-${ordinal}`;
  }
  return label.trim().replace(/[^\w.-]+/gu, "-").replace(/^-+|-+$/gu, "") || `entry-${ordinal}`;
}

function buildEntryVariants(value: string, configuredVariants: readonly string[] | undefined): readonly string[] {
  const variants = new Set<string>();
  variants.add(value);
  const lower = value.toLowerCase();
  variants.add(lower);
  const slug = slugVariant(value);
  if (slug.length > 0) {
    variants.add(slug);
    variants.add(slug.replace(/-/gu, "_"));
  }
  const base = basename(value);
  if (base !== value && base.length > 0) {
    variants.add(base);
    const baseSlug = slugVariant(base);
    if (baseSlug.length > 0) {
      variants.add(baseSlug);
      variants.add(baseSlug.replace(/-/gu, "_"));
    }
  }
  for (const configured of configuredVariants ?? []) {
    const normalized = configured.trim();
    if (normalized.length > 0) {
      variants.add(normalized);
    }
  }
  return [...variants].filter((variant) => variant.length > 0);
}

function slugVariant(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

function scanUnknownValue(
  value: unknown,
  options: Required<Pick<ScanRepoVisibleValueOptions, "surface" | "fieldPath">> & Pick<ScanRepoVisibleValueOptions, "identifier"> & {
    readonly denylist: readonly RepoVisibleDenylistEntry[];
  },
  seen: WeakSet<object>,
  findings: RepoVisibleFinding[],
): void {
  if (typeof value === "string") {
    findings.push(...scanTextForDenylist({
      text: value,
      denylist: options.denylist,
      surface: options.surface,
      ...(options.identifier === undefined ? {} : { identifier: options.identifier }),
      fieldPath: options.fieldPath,
    }));
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      scanUnknownValue(item, { ...options, fieldPath: `${options.fieldPath}[${index}]` }, seen, findings);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    scanUnknownValue(nested, { ...options, fieldPath: joinFieldPath(options.fieldPath, key) }, seen, findings);
  }
}

function scanTextForDenylist(input: TextScanInput): readonly RepoVisibleFinding[] {
  if (input.text.length === 0 || input.denylist.length === 0) {
    return [];
  }

  const findings: RepoVisibleFinding[] = [];
  const seen = new Set<string>();
  for (const entry of input.denylist) {
    for (const variant of entry.variants) {
      const index = input.text.indexOf(variant);
      if (index === -1) {
        continue;
      }
      const key = `${entry.label}\0${input.surface}\0${input.identifier ?? ""}\0${input.fieldPath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const location = locationAt(input.text, index);
      findings.push({
        surface: input.surface,
        ...(input.identifier === undefined ? {} : { identifier: input.identifier }),
        fieldPath: input.fieldPath,
        label: entry.label,
        matchKind: variant === entry.value ? "literal" : "generated_variant",
        line: location.line,
        column: location.column,
      });
    }
  }
  return findings;
}

function locationAt(text: string, index: number): { readonly line: number; readonly column: number } {
  let line = 1;
  let lineStart = 0;
  for (let offset = 0; offset < index; offset += 1) {
    if (text[offset] === "\n") {
      line += 1;
      lineStart = offset + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

function joinFieldPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function summarizeFindings(findings: readonly RepoVisibleFinding[]): string {
  return findings
    .slice(0, 5)
    .map((finding) => `${finding.fieldPath} matched ${finding.label}`)
    .join(", ");
}

function entriesFromDenylist(input: RepoVisibleDenylist | readonly RepoVisibleDenylistEntry[]): readonly RepoVisibleDenylistEntry[] {
  if (Array.isArray(input)) {
    return input as readonly RepoVisibleDenylistEntry[];
  }
  return (input as RepoVisibleDenylist).entries;
}

async function gitLsFiles(
  cwd: string,
  args: readonly string[],
  runCommand: RepoVisibleCommandRunner,
): Promise<readonly string[]> {
  const result = await runCommand("git", args, { cwd });
  if (result.status !== 0) {
    throw new RepoVisibleGuardError("repo_visible_scan_failed", "Unable to list repository files.", {
      command: `git ${args.join(" ")}`,
      stderr: result.stderr,
    });
  }
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

function shouldSkipLocalFile(file: string): boolean {
  if (
    file.startsWith(".git/") ||
    file.startsWith(".mono-agent/") ||
    file.startsWith(".ultrawork/") ||
    file.startsWith(".workflow/") ||
    file.includes("/node_modules/") ||
    file.includes("/dist/") ||
    file.includes("/coverage/")
  ) {
    return true;
  }
  const name = basename(file);
  return name === "pnpm-lock.yaml" || name === "package-lock.json" || name === "yarn.lock";
}

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<RepoVisibleCommandResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, status: 0 };
  } catch (error) {
    if (isExecFileError(error)) {
      return {
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : error.message,
        status: typeof error.code === "number" ? error.code : 1,
      };
    }
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), status: 1 };
  }
}

async function ghApiArray(
  cwd: string,
  runCommand: RepoVisibleCommandRunner,
  endpoint: string,
): Promise<readonly unknown[]> {
  const result = await runCommand("gh", ["api", "--paginate", "--slurp", endpoint], { cwd });
  if (result.status !== 0) {
    throw new RepoVisibleGuardError("repo_visible_scan_failed", "Unable to read GitHub metadata.", {
      endpoint,
      stderr: result.stderr,
    });
  }
  try {
    return flattenGhPages(JSON.parse(result.stdout));
  } catch (error) {
    throw new RepoVisibleGuardError("repo_visible_scan_failed", "Unable to parse GitHub metadata.", {
      endpoint,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function flattenGhPages(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    return [value];
  }
  if (value.every((page) => Array.isArray(page))) {
    return value.flatMap((page) => page as readonly unknown[]);
  }
  return value;
}

function scanGitHubRecord(
  record: Record<string, unknown>,
  denylist: readonly RepoVisibleDenylistEntry[],
  findings: RepoVisibleFinding[],
  surface: string,
  identifier: string,
  fields: readonly string[],
): number {
  let scanned = 0;
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    scanned += 1;
    findings.push(...scanTextForDenylist({
      text: value,
      denylist,
      surface,
      identifier,
      fieldPath: field,
    }));
  }
  return scanned;
}

function scanGitHubNestedRecord(
  record: Record<string, unknown>,
  denylist: readonly RepoVisibleDenylistEntry[],
  findings: RepoVisibleFinding[],
  surface: string,
  identifier: string,
  paths: readonly (readonly string[])[],
): number {
  let scanned = 0;
  for (const path of paths) {
    let value: unknown = record;
    for (const segment of path) {
      value = isRecord(value) ? value[segment] : undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    scanned += 1;
    findings.push(...scanTextForDenylist({
      text: value,
      denylist,
      surface,
      identifier,
      fieldPath: path.join("."),
    }));
  }
  return scanned;
}

function normalizeGitHubRepo(repo: string): string {
  const normalized = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) {
    throw new RepoVisibleGuardError("repo_visible_scan_failed", "GitHub repo must look like owner/name.", { repo: normalized });
  }
  return normalized;
}

function requireString(value: unknown, field: string, source: string, ordinal: number): string {
  if (typeof value !== "string") {
    throw new RepoVisibleGuardError("denylist_parse_failed", `${field} must be a string.`, { source, ordinal });
  }
  return value;
}

function requireStringArray(value: unknown, field: string, source: string, ordinal: number): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RepoVisibleGuardError("denylist_parse_failed", `${field} must be an array of strings.`, { source, ordinal });
  }
  return value as readonly string[];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExecFileError(value: unknown): value is Error & {
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly code?: unknown;
} {
  return value instanceof Error;
}
