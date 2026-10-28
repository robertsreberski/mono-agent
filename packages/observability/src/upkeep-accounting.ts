import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { link, lstat, open, readdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseAgentUpkeepAccounting, mergeAgentUpkeepAccounting, type AgentUpkeepAccounting } from "@mono-agent/contracts";
import { safeArtifactName, isErrno } from "./artifact-fs.js";

export class UpkeepAccountingExportError extends Error {
  constructor(readonly code: "invalid_payload" | "namespace_invalid" | "origin_invalid" | "origin_conflict" | "companion_invalid" | "companion_conflict") { super(code); this.name = "UpkeepAccountingExportError"; }
}
export function assertUpkeepAccountingNamespace(namespace: string): void {
  if (!isAbsolute(namespace) || resolve(namespace) !== namespace) throw new UpkeepAccountingExportError("namespace_invalid");
}

export function upkeepCompanionPrefix(runId: string): string { return `${safeArtifactName(runId)}.upkeep.`; }
function companionName(a: AgentUpkeepAccounting): string {
  return `${upkeepCompanionPrefix(a.runId)}${createHash("sha256").update(a.operationId).digest("hex")}.${a.phase}.json`;
}
async function originExists(a: AgentUpkeepAccounting): Promise<boolean> {
  const path = join(a.recorderNamespace, `${safeArtifactName(a.runId)}.summary.json`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new UpkeepAccountingExportError("origin_invalid");
    const raw = await readFile(path, "utf8");
    let summary;
    try { summary = JSON.parse(raw); } catch { throw new UpkeepAccountingExportError("origin_invalid"); }
    if (summary?.runId !== a.runId || summary?.conversationId !== a.conversationId) throw new UpkeepAccountingExportError("origin_conflict");
    return true;
  } catch (error) { if (isErrno(error, "ENOENT")) return false; throw error; }
}

/** Never creates a namespace or summary. Absence alone is not pruning proof.
 * Retention removes the summary BEFORE companions; the post-write check closes
 * the opposing race (export after retention's directory scan). */
export async function exportUpkeepAccounting(value: unknown, options: {
  readonly originPreviouslySeen?: boolean; readonly onOriginSeen?: () => void;
} = {}): Promise<"exported" | "pruned" | "pending"> {
  let a: AgentUpkeepAccounting;
  try { a = parseAgentUpkeepAccounting(value); } catch { throw new UpkeepAccountingExportError("invalid_payload"); }
  assertUpkeepAccountingNamespace(a.recorderNamespace);
  if (!await originExists(a)) return options.originPreviouslySeen ? "pruned" : "pending";
  options.onOriginSeen?.();
  const path = join(a.recorderNamespace, companionName(a));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(a)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try { await link(temp, path); } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const info = await lstat(path);
      if (!info.isFile() || info.size > 32768) throw new UpkeepAccountingExportError("companion_invalid");
      const raw = await readFile(path, "utf8");
      let old: AgentUpkeepAccounting;
      try { old = parseAgentUpkeepAccounting(JSON.parse(raw)); } catch { throw new UpkeepAccountingExportError("companion_invalid"); }
      if (JSON.stringify(old) !== JSON.stringify(a)) throw new UpkeepAccountingExportError("companion_conflict");
    }
    if (!await originExists(a)) { await unlink(path).catch(error => { if (!isErrno(error, "ENOENT")) throw error; }); return "pruned"; }
    // Windows cannot open/fsync directory handles (same guard as retention).
    if (process.platform !== "win32") {
      const directory = await open(a.recorderNamespace, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return "exported";
  } finally { await unlink(temp).catch(error => { if (!isErrno(error, "ENOENT")) throw error; }); }
}

/** Canonical identity when present; legacy/missing namespaces still normalize lexically. */
export function canonicalUpkeepNamespace(namespace: string): string {
  try { return realpathSync.native(namespace); } catch { return resolve(namespace); }
}

/** Per-acceptance lifetime: cache aliases and their canonical result, not global state. */
export function createUpkeepNamespaceNormalizer(): (namespace: string) => string {
  const cache = new Map<string, string>();
  return namespace => {
    const known = cache.get(namespace);
    if (known !== undefined) return known;
    const canonical = canonicalUpkeepNamespace(namespace);
    cache.set(namespace, canonical); cache.set(canonical, canonical);
    return canonical;
  };
}

/** Index once per namespace, rather than rescanning the directory for each run. */
export function indexUpkeepCompanions(names: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const name of names) {
    const prefix = /^(.*\.upkeep\.)[a-f0-9]{64}\.(dispatch|result)\.json$/u.exec(name)?.[1];
    if (prefix) { const group = index.get(prefix) ?? []; group.push(name); index.set(prefix, group); }
  }
  return index;
}

/** Separate non-aggregate evidence; inclusive totals never rewrite raw inference. */
export async function readUpkeepAccounting(artifactDir: string, runId: string, conversationId: string, candidates: readonly unknown[], warnings: string[], options: {
  readonly companionNames?: readonly string[];
  readonly onEvidence?: () => void;
  readonly normalizeNamespace?: (namespace: string) => string;
} = {}): Promise<readonly AgentUpkeepAccounting[]> {
  const values = new Map<string, AgentUpkeepAccounting>();
  const normalizeNamespace = options.normalizeNamespace ?? createUpkeepNamespaceNormalizer();
  const namespace = normalizeNamespace(artifactDir);
  const accept = (value: unknown) => {
    const parsed = parseAgentUpkeepAccounting(value);
    const a = { ...parsed, recorderNamespace: normalizeNamespace(parsed.recorderNamespace) };
    if (a.runId !== runId || a.conversationId !== conversationId || a.recorderNamespace !== namespace) throw new Error("Conflicting upkeep origin");
    const old = values.get(a.operationId);
    values.set(a.operationId, mergeAgentUpkeepAccounting(old ? [old, a] : [a])[0]!);
  };
  if (candidates.length) options.onEvidence?.();
  for (const value of candidates) { try { accept(value); } catch { warnings.push("Upkeep accounting degraded: invalid or conflicting evidence."); } }
  try {
    const names = [...(options.companionNames ?? indexUpkeepCompanions(await readdir(artifactDir)).get(upkeepCompanionPrefix(runId)) ?? [])]
      .filter(name => name.startsWith(upkeepCompanionPrefix(runId)) && /\.[a-f0-9]{64}\.(dispatch|result)\.json$/u.test(name)).sort();
    if (names.length) options.onEvidence?.();
    if (names.length > 32768) warnings.push("Upkeep accounting degraded: companion limit exceeded.");
    for (const name of names.slice(0, 32768)) {
      try {
        const path = join(artifactDir, name), info = await lstat(path);
        if (!info.isFile() || info.size > 32768) throw new Error("Invalid upkeep companion");
        const value = JSON.parse(await readFile(path, "utf8"));
        if (companionName(parseAgentUpkeepAccounting(value)) !== name) throw new Error("Conflicting upkeep filename");
        accept(value);
      } catch { warnings.push("Upkeep accounting degraded: unreadable or conflicting companion."); }
    }
  } catch { warnings.push("Upkeep accounting degraded: companions unavailable."); }
  return [...values.values()];
}
