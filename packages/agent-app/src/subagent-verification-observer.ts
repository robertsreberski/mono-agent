import { createHash } from "node:crypto";
import { resolveSubagentObservationGit } from "./subagent-observation-git.js";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { PreparedSandboxCommand, ProcessJobProcessResult, SandboxEngine, SandboxPolicy } from "@mono-agent/runtime-adapter";

export interface SubagentVerificationDeclaration { readonly workdir: string; readonly reportPath?: string }
export interface SubagentVerificationTarget extends SubagentVerificationDeclaration { readonly device: string; readonly inode: string }
export interface SubagentVerificationObservation {
  readonly schemaVersion: 1;
  readonly capturedAt: number;
  readonly policyRevision: string;
  readonly status: "observed" | "observation_policy_denied" | "observation_unavailable" | "observation_inconsistent" | "observation_truncated";
  readonly workdir?: string;
  readonly headBefore?: string;
  readonly headAfter?: string;
  paths?: { readonly path: string; readonly status: "tracked" | "untracked" }[];
  omitted?: number;
  readonly report?: { readonly path: string; readonly present: boolean };
}
export const SUBAGENT_OBSERVATION_MAX_BYTES = 4096;
interface Access {
  workspace: string;
  readableRoots: string[];
  sandboxPolicy?: SandboxPolicy;
  sandboxEngine?: SandboxEngine;
  runProbe?: (prepared: PreparedSandboxCommand, timeoutMs: number) => Promise<ProcessJobProcessResult>;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const path = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 2048 && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
const reportPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512 && !value.includes("\0") && !isAbsolute(value) && value.split(/[\\/]/u).every((part) => part && part !== "." && part !== "..");
const inside = (root: string, target: string): boolean => { const rel = relative(root, target); return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel)); };
export function isSubagentVerificationTarget(value: unknown): value is SubagentVerificationTarget {
  return object(value) && Object.keys(value).every((key) => ["workdir", "reportPath", "device", "inode"].includes(key)) && path(value.workdir)
    && (value.reportPath === undefined || reportPath(value.reportPath)) && typeof value.device === "string" && /^[0-9]{1,32}$/u.test(value.device)
    && typeof value.inode === "string" && /^[0-9]{1,32}$/u.test(value.inode);
}
export function isSubagentVerificationObservation(value: unknown): value is SubagentVerificationObservation {
  return object(value) && Object.keys(value).every((key) => ["schemaVersion", "capturedAt", "policyRevision", "status", "workdir", "headBefore", "headAfter", "paths", "omitted", "report"].includes(key))
    && value.schemaVersion === 1 && Number.isSafeInteger(value.capturedAt) && Number(value.capturedAt) >= 0
    && typeof value.policyRevision === "string" && /^[a-f0-9]{64}$/u.test(value.policyRevision)
    && ["observed", "observation_policy_denied", "observation_unavailable", "observation_inconsistent", "observation_truncated"].includes(String(value.status))
    && (value.workdir === undefined || path(value.workdir))
    && [value.headBefore, value.headAfter].every((head) => head === undefined || (typeof head === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)))
    && (value.omitted === undefined || (Number.isSafeInteger(value.omitted) && Number(value.omitted) >= 0))
    && (value.paths === undefined || (Array.isArray(value.paths) && value.paths.length <= 64 && value.paths.every((entry) => object(entry) && Object.keys(entry).length === 2 && reportPath(entry.path) && ["tracked", "untracked"].includes(String(entry.status)))))
    && (value.report === undefined || (object(value.report) && Object.keys(value.report).length === 2 && reportPath(value.report.path) && typeof value.report.present === "boolean"))
    && (value.status === "observed" ? path(value.workdir) && typeof value.headBefore === "string" && value.headAfter === value.headBefore && Array.isArray(value.paths) && Number.isSafeInteger(value.omitted)
      : [value.workdir, value.headBefore, value.headAfter, value.paths, value.omitted, value.report].every((field) => field === undefined))
    && Buffer.byteLength(JSON.stringify(value)) <= SUBAGENT_OBSERVATION_MAX_BYTES;
}
function access(value: unknown): Access {
  if (!object(value) || !path(value.workspace) || !Array.isArray(value.readableRoots) || value.readableRoots.length > 64 || !value.readableRoots.every(path)) throw new Error("observation_unavailable");
  return value as unknown as Access;
}
function lexicalAllowed(target: string, value: Access, privateRoots: readonly string[]): boolean {
  return path(target) && [value.workspace, ...value.readableRoots].some((root) => inside(root, target))
    && (!value.sandboxPolicy || value.sandboxPolicy.readableRoots.some((root) => inside(root, target)))
    && ![...privateRoots, ...(value.sandboxPolicy?.protectedRoots ?? [])].some((root) => inside(root, target));
}
export async function authorizeSubagentObservationPath(target: string, input: unknown, privateRoots: readonly string[]): Promise<string> {
  const current = access(input);
  if (!lexicalAllowed(target, current, privateRoots)) throw new Error("observation_policy_denied");
  const actual = await realpath(target);
  if (!lexicalAllowed(actual, current, privateRoots)) throw new Error("observation_policy_denied");
  return actual;
}
export async function registerSubagentVerification(declaration: SubagentVerificationDeclaration, input: unknown, privateRoots: readonly string[]): Promise<SubagentVerificationTarget> {
  if (!object(declaration) || Object.keys(declaration).some((key) => !["workdir", "reportPath"].includes(key)) || !path(declaration.workdir)
    || (declaration.reportPath !== undefined && !reportPath(declaration.reportPath))) throw new Error("Invalid observation-only verification target.");
  const workdir = await authorizeSubagentObservationPath(declaration.workdir, input, privateRoots);
  const stat = await lstat(workdir, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Invalid observation-only verification target.");
  if (declaration.reportPath && !lexicalAllowed(resolve(workdir, declaration.reportPath), access(input), privateRoots)) throw new Error("observation_policy_denied");
  return { workdir, device: String(stat.dev), inode: String(stat.ino), ...(declaration.reportPath ? { reportPath: declaration.reportPath } : {}) };
}
async function readMetadata(file: string, input: unknown, privateRoots: readonly string[]): Promise<string> {
  if (await authorizeSubagentObservationPath(file, input, privateRoots) !== file) throw new Error("observation_policy_denied");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 4096) throw new Error("observation_unavailable");
    const buffer = Buffer.alloc(4097); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("observation_unavailable");
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } finally { await handle.close(); }
}
const absent = (error: unknown): boolean => object(error) && error.code === "ENOENT";
async function metadata(root: string, input: unknown, privateRoots: readonly string[]) {
  const entry = resolve(root, ".git");
  await authorizeSubagentObservationPath(entry, input, privateRoots);
  const stat = await lstat(entry);
  if (stat.isSymbolicLink()) throw new Error("observation_policy_denied");
  let git = entry;
  if (stat.isFile()) {
    const content = await readMetadata(entry, input, privateRoots);
    if (!content.startsWith("gitdir: ") || content.includes("\n")) throw new Error("observation_unavailable");
    git = resolve(root, content.slice(8));
  }
  git = await authorizeSubagentObservationPath(git, input, privateRoots);
  let common = git;
  try { common = resolve(git, await readMetadata(resolve(git, "commondir"), input, privateRoots)); } catch (error) { if (!absent(error)) throw error; }
  common = await authorizeSubagentObservationPath(common, input, privateRoots);
  for (const location of new Set([git, common])) {
    for (const name of ["HEAD", "config", "config.worktree", "objects", "refs", "objects/info/alternates", "objects/info/http-alternates"]) {
      const target = resolve(location, name);
      if (!lexicalAllowed(target, access(input), privateRoots)) throw new Error("observation_policy_denied");
      try {
        const item = await lstat(target);
        if (item.isSymbolicLink() || name.endsWith("alternates")) throw new Error("observation_unavailable");
      } catch (error) { if (!absent(error)) throw error; }
    }
  }
  const identity = await Promise.all([root, entry, git, common, resolve(common, "config"), resolve(git, "config.worktree")].map(async (file) => {
    try { const stat = await lstat(file, { bigint: true }); return [file, String(stat.dev), String(stat.ino), stat.isDirectory() ? null : String(stat.mtimeNs)]; }
    catch (error) { if (absent(error)) return [file, null]; throw error; }
  }));
  return JSON.stringify(identity);
}

/** Fixed read-only probes only; never host fallback, report contents, or command replay. */
export async function observeSubagentVerification(target: SubagentVerificationTarget, input: unknown, privateRoots: readonly string[]): Promise<SubagentVerificationObservation> {
  const capturedAt = Date.now();
  const policyRevision = createHash("sha256").update(JSON.stringify([object(input) ? input.workspace : null, object(input) ? input.readableRoots : null, object(input) ? input.sandboxPolicy : null, privateRoots])).digest("hex");
  const base = { schemaVersion: 1 as const, capturedAt, policyRevision };
  try {
    const current = access(input);
    const checked = await registerSubagentVerification({ workdir: target.workdir, ...(target.reportPath ? { reportPath: target.reportPath } : {}) }, input, privateRoots);
    if (checked.workdir !== target.workdir || checked.device !== target.device || checked.inode !== target.inode) throw new Error("observation_inconsistent");
    const before = await metadata(target.workdir, input, privateRoots);
    if (!current.sandboxPolicy || !current.sandboxEngine || !current.runProbe || !await current.sandboxEngine.isAvailable()) throw new Error("observation_unavailable");
    const policy: SandboxPolicy = { ...current.sandboxPolicy, mode: "native", writableRoots: [],
      protectedRoots: [...privateRoots, ...(current.sandboxPolicy.protectedRoots ?? [])], network: { mode: "none", allowlist: [] }, fallback: "fail-closed", unsafeAllowHostProcess: false };
    const deadline = capturedAt + 6000;
    const executable = await resolveSubagentObservationGit();
    // Executable runtime access does not override an explicit protected path.
    // File-read denial alone need not prohibit native process-exec on macOS.
    if (policy.protectedRoots?.some((root) => inside(root, executable.path))) throw new Error("observation_policy_denied");
    const attest = async () => {
      const current = await resolveSubagentObservationGit();
      if (current.path !== executable.path || current.identity !== executable.identity) throw new Error("observation_unavailable");
    };
    const git = async (args: string[]): Promise<string> => {
      if (Date.now() >= deadline) throw new Error("observation_unavailable");
      await attest();
      const prepared = await current.sandboxEngine!.prepareCommand({ command: executable.path, cwd: target.workdir,
        args: [`--work-tree=${target.workdir}`, "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.untrackedCache=false", ...args],
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      }, policy);
      if (!prepared.sandboxed || prepared.command !== executable.path || prepared.cwd !== target.workdir || Date.now() >= deadline) {
        await prepared.cleanup?.(); throw new Error("observation_unavailable");
      }
      const result = await current.runProbe!(prepared, Math.min(1500, deadline - Date.now()));
      if (result.groupExitConfirmed === true) await prepared.cleanup?.();
      if (result.truncated || result.bufferExceeded) throw new Error("observation_truncated");
      if (result.code !== 0 || result.timedOut || result.aborted || result.spawnError || result.groupExitConfirmed !== true) throw new Error("observation_unavailable");
      await attest();
      return result.stdout;
    };
    // Names only: never collect remote URLs, credentials, or arbitrary config values.
    const names = (await git(["config", "--name-only", "--null", "--list", "--includes"])).split("\0");
    if (names.some((name) => name.toLowerCase().startsWith("filter."))) throw new Error("observation_unavailable");
    const headBefore = (await git(["rev-parse", "--verify", "HEAD"])).trim();
    const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
    const headAfter = (await git(["rev-parse", "--verify", "HEAD"])).trim();
    if (headBefore !== headAfter || before !== await metadata(target.workdir, input, privateRoots)) throw new Error("observation_inconsistent");
    const paths: { path: string; status: "tracked" | "untracked" }[] = [];
    for (const item of status.split("\0").filter(Boolean)) {
      if (item.length < 4 || !/^[ MADRCU?!]{2}$/u.test(item.slice(0, 2)) || item[2] !== " " || !reportPath(item.slice(3))) throw new Error("observation_unavailable");
      const name = item.slice(3); if (!lexicalAllowed(resolve(target.workdir, name), current, privateRoots)) throw new Error("observation_policy_denied");
      paths.push({ path: name, status: item.startsWith("??") ? "untracked" : "tracked" });
    }
    let report: { path: string; present: boolean } | undefined;
    if (target.reportPath) {
      const file = resolve(target.workdir, target.reportPath);
      if (!lexicalAllowed(file, current, privateRoots)) throw new Error("observation_policy_denied");
      try { if (await authorizeSubagentObservationPath(file, input, privateRoots) !== file || !(await lstat(file)).isFile()) throw new Error("observation_policy_denied"); report = { path: target.reportPath, present: true }; }
      catch (error) { if (!absent(error)) throw error; const parent = resolve(file, ".."); await authorizeSubagentObservationPath(parent, input, privateRoots); report = { path: target.reportPath, present: false }; }
    }
    const value: SubagentVerificationObservation = { ...base, status: "observed", workdir: target.workdir, headBefore, headAfter, paths: paths.slice(0, 64), omitted: Math.max(0, paths.length - 64), ...(report ? { report } : {}) };
    while (value.paths!.length && Buffer.byteLength(JSON.stringify(value)) > SUBAGENT_OBSERVATION_MAX_BYTES) { value.paths!.pop(); value.omitted!++; }
    if (!isSubagentVerificationObservation(value)) throw new Error("observation_unavailable");
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ...base, status: (["observation_policy_denied", "observation_inconsistent", "observation_truncated"].includes(message) ? message : "observation_unavailable") as SubagentVerificationObservation["status"] };
  }
}

export async function authorizeSubagentVerificationMetadata(target: SubagentVerificationTarget, input: unknown, privateRoots: readonly string[]): Promise<void> {
  await metadata(target.workdir, input, privateRoots);
}
