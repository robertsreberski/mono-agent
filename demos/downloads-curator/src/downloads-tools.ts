import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export const CURATED_FOLDER = "_Curated";
export const CURATED_CATEGORIES = [
  "Documents",
  "Images",
  "Media",
  "Archives",
  "Installers",
  "Code",
  "Other",
] as const;

export type DownloadsCategory = typeof CURATED_CATEGORIES[number];
export type DownloadsActionKind = "move" | "trash";

export interface DownloadsToolContext {
  readonly downloadsRoot: string;
  readonly stateDir?: string;
  readonly trashDir?: string;
  readonly currentUserMessage?: string;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
}

export interface DownloadsEntry {
  readonly relativePath: string;
  readonly kind: "file" | "directory" | "other";
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly extension?: string;
  readonly hidden: boolean;
  readonly activeDownload: boolean;
  readonly suggestedCategory: DownloadsCategory;
}

export interface DownloadsListResult {
  readonly downloadsRoot: string;
  readonly entries: readonly DownloadsEntry[];
}

export type DownloadsProposalActionInput =
  | {
      readonly kind: "move";
      readonly source: string;
      readonly targetCategory: DownloadsCategory;
      readonly reason: string;
    }
  | {
      readonly kind: "trash";
      readonly source: string;
      readonly reason: string;
    };

export interface CreateDownloadsProposalInput {
  readonly rationale: string;
  readonly actions: readonly DownloadsProposalActionInput[];
}

export interface DownloadsProposalAction {
  readonly id: string;
  readonly kind: DownloadsActionKind;
  readonly source: string;
  readonly targetCategory?: DownloadsCategory;
  readonly reason: string;
  readonly sourceSnapshot: {
    readonly sizeBytes: number;
    readonly mtimeMs: number;
  };
}

export interface DownloadsProposal {
  readonly proposalId: string;
  readonly createdAt: string;
  readonly downloadsRoot: string;
  readonly trashDir: string;
  readonly rationale: string;
  readonly actions: readonly DownloadsProposalAction[];
  readonly approvalPhrase: string;
}

export interface ApplyDownloadsProposalInput {
  readonly proposalId: string;
  readonly approvalPhrase: string;
  readonly actionIds: readonly string[];
}

export interface AppliedDownloadsAction {
  readonly id: string;
  readonly kind: DownloadsActionKind;
  readonly source: string;
  readonly destinationRelativePath: string;
}

export interface ApplyDownloadsProposalResult {
  readonly proposalId: string;
  readonly applied: readonly AppliedDownloadsAction[];
}

const ACTIVE_DOWNLOAD_SUFFIXES = [
  ".crdownload",
  ".download",
  ".part",
  ".partial",
  ".tmp",
];

export class DownloadsCuratorToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DownloadsCuratorToolError";
    this.code = code;
  }
}

export async function listDownloads(context: Pick<DownloadsToolContext, "downloadsRoot">): Promise<DownloadsListResult> {
  const downloadsRoot = resolve(context.downloadsRoot);
  await mkdir(downloadsRoot, { recursive: true });
  const entries = await readdir(downloadsRoot, { withFileTypes: true });
  const results: DownloadsEntry[] = [];

  for (const entry of entries) {
    const fullPath = join(downloadsRoot, entry.name);
    const entryStat = await lstat(fullPath);
    const kind = entryStat.isFile()
      ? "file"
      : entryStat.isDirectory()
        ? "directory"
        : "other";
    const extension = entryStat.isFile() ? extname(entry.name).toLowerCase() : undefined;
    const activeDownload = isActiveDownloadName(entry.name);
    results.push({
      relativePath: entry.name,
      kind,
      sizeBytes: entryStat.size,
      mtimeMs: entryStat.mtimeMs,
      ...(extension === undefined || extension.length === 0 ? {} : { extension }),
      hidden: entry.name.startsWith("."),
      activeDownload,
      suggestedCategory: activeDownload ? "Other" : categoryForName(entry.name, kind),
    });
  }

  return {
    downloadsRoot,
    entries: results.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

export async function createDownloadsProposal(
  context: DownloadsToolContext,
  input: CreateDownloadsProposalInput,
): Promise<DownloadsProposal> {
  const normalized = normalizeContext(context);
  const proposalId = sanitizeId(context.idGenerator?.() ?? `proposal_${randomUUID()}`);
  const createdAt = (context.now?.() ?? new Date()).toISOString();
  const actions: DownloadsProposalAction[] = [];

  if (input.actions.length === 0) {
    throw new DownloadsCuratorToolError("empty_proposal", "Proposal must contain at least one action.");
  }

  for (const [index, action] of input.actions.entries()) {
    const source = await resolveSafeExistingSource(normalized.downloadsRoot, action.source);
    if (source.relativePath.split(sep).includes(CURATED_FOLDER)) {
      throw new DownloadsCuratorToolError("invalid_source", "Proposal source is already inside the curated Downloads folder.");
    }
    if (isActiveDownloadName(source.relativePath)) {
      throw new DownloadsCuratorToolError("active_download", "Proposal source appears to be an active download.");
    }
    actions.push({
      id: `act_${index + 1}`,
      kind: action.kind,
      source: source.relativePath,
      ...(action.kind === "move" ? { targetCategory: action.targetCategory } : {}),
      reason: normalizeText(action.reason, "action reason"),
      sourceSnapshot: {
        sizeBytes: Number(source.stats.size),
        mtimeMs: Number(source.stats.mtimeMs),
      },
    });
  }

  const approvalPhrase = approvalPhraseFor(proposalId, actions.map((action) => action.id));
  const proposal: DownloadsProposal = {
    proposalId,
    createdAt,
    downloadsRoot: normalized.downloadsRoot,
    trashDir: normalized.trashDir,
    rationale: normalizeText(input.rationale, "proposal rationale"),
    actions,
    approvalPhrase,
  };

  await writeJson(proposalPath(normalized.stateDir, proposalId), proposal);
  return proposal;
}

export async function applyDownloadsProposal(
  context: DownloadsToolContext,
  input: ApplyDownloadsProposalInput,
): Promise<ApplyDownloadsProposalResult> {
  const normalized = normalizeContext(context);
  const proposal = await readProposal(normalized.stateDir, input.proposalId);
  const requested = new Set(input.actionIds);
  const expectedPhrase = proposal.approvalPhrase;

  if (input.approvalPhrase !== expectedPhrase) {
    throw new DownloadsCuratorToolError("approval_mismatch", "Approval phrase does not match the pending proposal.");
  }
  if (context.currentUserMessage !== expectedPhrase) {
    throw new DownloadsCuratorToolError("approval_mismatch", "The current user message must match the exact approval phrase.");
  }
  if (requested.size === 0) {
    throw new DownloadsCuratorToolError("empty_apply", "At least one action id is required.");
  }

  const applied: AppliedDownloadsAction[] = [];
  for (const actionId of requested) {
    const action = proposal.actions.find((candidate) => candidate.id === actionId);
    if (action === undefined) {
      throw new DownloadsCuratorToolError("unknown_action", `Unknown proposal action id: ${actionId}`);
    }
    const source = await resolveSafeExistingSource(normalized.downloadsRoot, action.source);
    assertUnchanged(action, source.stats);
    const destination = action.kind === "move"
      ? await destinationForMove(normalized.downloadsRoot, action)
      : await destinationForTrash(normalized.trashDir, source.relativePath);
    await mkdir(dirname(destination.fullPath), { recursive: true });
    await rename(source.fullPath, destination.fullPath);
    const appliedAction: AppliedDownloadsAction = {
      id: action.id,
      kind: action.kind,
      source: action.source,
      destinationRelativePath: destination.relativePath,
    };
    applied.push(appliedAction);
    await appendManifest(normalized.stateDir, {
      appliedAt: (context.now?.() ?? new Date()).toISOString(),
      proposalId: proposal.proposalId,
      action: appliedAction,
    });
  }

  return {
    proposalId: proposal.proposalId,
    applied,
  };
}

function normalizeContext(context: DownloadsToolContext): {
  readonly downloadsRoot: string;
  readonly stateDir: string;
  readonly trashDir: string;
} {
  const downloadsRoot = resolve(context.downloadsRoot);
  return {
    downloadsRoot,
    stateDir: resolve(context.stateDir ?? join(downloadsRoot, ".downloads-curator-state")),
    trashDir: resolve(context.trashDir ?? join(process.env.HOME ?? dirname(downloadsRoot), ".Trash")),
  };
}

async function resolveSafeExistingSource(downloadsRoot: string, source: string): Promise<{
  readonly fullPath: string;
  readonly relativePath: string;
  readonly stats: Awaited<ReturnType<typeof lstat>>;
}> {
  const normalizedSource = normalizeText(source, "source");
  const fullPath = resolve(downloadsRoot, normalizedSource);
  assertInsideRoot(downloadsRoot, fullPath);
  const sourceStats = await lstat(fullPath);
  if (sourceStats.isSymbolicLink()) {
    throw new DownloadsCuratorToolError("invalid_source", "Proposal source must not be a symlink.");
  }
  if (!sourceStats.isFile() && !sourceStats.isDirectory()) {
    throw new DownloadsCuratorToolError("invalid_source", "Proposal source must be a file or directory.");
  }
  return {
    fullPath,
    relativePath: relative(downloadsRoot, fullPath),
    stats: sourceStats,
  };
}

function assertInsideRoot(root: string, fullPath: string): void {
  const relativePath = relative(root, fullPath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    relativePath.includes(`${sep}..${sep}`) ||
    resolve(fullPath) === resolve(root)
  ) {
    throw new DownloadsCuratorToolError("invalid_source", "Path must resolve inside Downloads and must not be the Downloads root.");
  }
}

function assertUnchanged(action: DownloadsProposalAction, current: Awaited<ReturnType<typeof stat>>): void {
  if (
    Number(current.size) !== action.sourceSnapshot.sizeBytes ||
    Math.abs(Number(current.mtimeMs) - action.sourceSnapshot.mtimeMs) > 1
  ) {
    throw new DownloadsCuratorToolError("source_changed", `Source ${action.source} changed since proposal creation.`);
  }
}

async function destinationForMove(downloadsRoot: string, action: DownloadsProposalAction): Promise<{
  readonly fullPath: string;
  readonly relativePath: string;
}> {
  const category = action.targetCategory ?? "Other";
  if (!isDownloadsCategory(category)) {
    throw new DownloadsCuratorToolError("invalid_category", `Unsupported category: ${category}`);
  }
  const baseDestination = join(downloadsRoot, CURATED_FOLDER, category, basename(action.source));
  const fullPath = await collisionSafePath(baseDestination);
  return {
    fullPath,
    relativePath: relative(downloadsRoot, fullPath),
  };
}

async function destinationForTrash(trashDir: string, source: string): Promise<{
  readonly fullPath: string;
  readonly relativePath: string;
}> {
  const fullPath = await collisionSafePath(join(trashDir, basename(source)));
  return {
    fullPath,
    relativePath: join("..", basename(trashDir), basename(fullPath)),
  };
}

async function collisionSafePath(basePath: string): Promise<string> {
  const extension = extname(basePath);
  const stem = extension.length === 0 ? basePath : basePath.slice(0, -extension.length);
  for (let index = 0; index < 10_000; index++) {
    const candidate = index === 0 ? basePath : `${stem}-${index}${extension}`;
    try {
      await lstat(candidate);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return candidate;
      }
      throw error;
    }
  }
  throw new DownloadsCuratorToolError("destination_collision", "Unable to find a collision-safe destination.");
}

function approvalPhraseFor(proposalId: string, actionIds: readonly string[]): string {
  return `APPROVE ${proposalId}: ${actionIds.join(",")}`;
}

function proposalPath(stateDir: string, proposalId: string): string {
  return join(stateDir, "pending", `${sanitizeId(proposalId)}.json`);
}

async function readProposal(stateDir: string, proposalId: string): Promise<DownloadsProposal> {
  const raw = await readFile(proposalPath(stateDir, proposalId), "utf8");
  return JSON.parse(raw) as DownloadsProposal;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendManifest(stateDir: string, value: unknown): Promise<void> {
  const path = join(stateDir, "actions.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export function isDownloadsCategory(value: unknown): value is DownloadsCategory {
  return typeof value === "string" && (CURATED_CATEGORIES as readonly string[]).includes(value);
}

function categoryForName(name: string, kind: DownloadsEntry["kind"]): DownloadsCategory {
  if (kind === "directory") {
    return "Other";
  }
  const extension = extname(name).toLowerCase();
  if ([".pdf", ".doc", ".docx", ".txt", ".rtf", ".csv", ".xls", ".xlsx", ".ppt", ".pptx"].includes(extension)) {
    return "Documents";
  }
  if ([".jpg", ".jpeg", ".png", ".gif", ".heic", ".webp", ".svg"].includes(extension)) {
    return "Images";
  }
  if ([".mp3", ".wav", ".mp4", ".mov", ".m4a", ".avi", ".mkv"].includes(extension)) {
    return "Media";
  }
  if ([".zip", ".tar", ".gz", ".tgz", ".rar", ".7z"].includes(extension)) {
    return "Archives";
  }
  if ([".dmg", ".pkg", ".iso", ".app"].includes(extension)) {
    return "Installers";
  }
  if ([".js", ".ts", ".json", ".py", ".rb", ".go", ".rs", ".java", ".sh"].includes(extension)) {
    return "Code";
  }
  return "Other";
}

function isActiveDownloadName(name: string): boolean {
  const normalized = name.toLowerCase();
  return ACTIVE_DOWNLOAD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function normalizeText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new DownloadsCuratorToolError("invalid_input", `${label} must be a string.`);
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    throw new DownloadsCuratorToolError("invalid_input", `${label} must not be empty.`);
  }
  return normalized;
}

function sanitizeId(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (normalized.length === 0) {
    throw new DownloadsCuratorToolError("invalid_id", "Generated proposal id must not be empty.");
  }
  return normalized;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
