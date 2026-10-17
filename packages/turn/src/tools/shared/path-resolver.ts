import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { requireToolContext, resolveSandboxPolicy } from "./tool-context.js";

/** @typedef {import("./tool-context.js").ToolContext} ToolContext */
/** @typedef {{ctx: ToolContext, sandboxPolicy?: import("../../agent/sandbox-seam.js").SandboxPolicy}} PublicPathGuardOptions */

// Filesystem policy checks require the owning runtime context. Missing context
// must not silently drop the host workspace or sandbox policy.
function configured(ctx: any) {
  const { workspace, repoRoot, additionalReadRoots, additionalWriteRoots } = requireToolContext(ctx);
  return { workspace, repoRoot, additionalReadRoots, additionalWriteRoots };
}

export function workspaceRoot(workdir: any, ctx: any): string {
  const { workspace, repoRoot } = configured(ctx);
  return resolve(workdir || workspace || repoRoot || process.cwd());
}

export function resolveToolPath(path: any, workdir: any, ctx: any): any {
  if (!path || typeof path !== "string") return path;
  return resolve(isAbsolute(path) ? path : resolve(workspaceRoot(workdir, ctx), path));
}

/**
 * @param {string} path
 * @param {string|undefined} workdir
 * @param {PublicPathGuardOptions} options
 */
export function isPathAllowed(path: string, workdir: string | undefined, options: PublicPathGuardOptions): boolean {
  return isPathAllowedFor(path, workdir, "read", options ?? {});
}

export function isWritablePathAllowed(path: any, workdir: any, options: {} = {}): boolean {
  return isPathAllowedFor(path, workdir, "write", options);
}

// Protected filesystem operations use these metadata-free checks only as a
// lexical policy preflight. The native sandbox remains responsible for
// resolving symlinks and enforcing the real path at the operation syscall.
export function isPathLexicallyAllowed(path: any, workdir: any, options: {} = {}): boolean {
  return isPathLexicallyAllowedFor(path, workdir, "read", options);
}

export function isWritablePathLexicallyAllowed(path: any, workdir: any, options: {} = {}): boolean {
  return isPathLexicallyAllowedFor(path, workdir, "write", options);
}

function isPathAllowedFor(path: any, workdir: any, access: any, options: any) {
  const ctx = options.ctx;
  const r = resolveToolPath(path, workdir, ctx);
  const policy = resolveSandboxPolicy(requireToolContext(ctx), options.sandboxPolicy);
  if (policy) {
    const field = access === "write" ? policy.writableRoots : policy.readableRoots;
    return !insideProtectedRoots(Array.isArray(policy.protectedRoots) ? policy.protectedRoots : [], r)
      && insideSandboxRoots(Array.isArray(field) ? field : [], r)
      && (access !== "write" || !sandboxDeniesWrite(policy, r, ctx));
  }
  const { workspace, repoRoot, additionalReadRoots, additionalWriteRoots } = configured(ctx);
  const additionalRoots = access === "write"
    ? additionalWriteRoots
    : [...(additionalReadRoots ?? []), ...(additionalWriteRoots ?? [])];
  return insideLegacyRoots([workdir, workspace, repoRoot, process.cwd(), "/tmp"], r)
    || insideAdditionalRoots(Array.isArray(additionalRoots) ? additionalRoots : [], r);
}

function isPathLexicallyAllowedFor(path: any, workdir: any, access: any, options: any) {
  const ctx = options.ctx;
  const r = resolveToolPath(path, workdir, ctx);
  const policy = resolveSandboxPolicy(requireToolContext(ctx), options.sandboxPolicy);
  if (policy) {
    const field = access === "write" ? policy.writableRoots : policy.readableRoots;
    return !insideLexicalRoots(Array.isArray(policy.protectedRoots) ? policy.protectedRoots : [], r)
      && insideLexicalRoots(Array.isArray(field) ? field : [], r)
      && (access !== "write" || !sandboxLexicallyDeniesWrite(policy, r, ctx));
  }
  const { workspace, repoRoot, additionalReadRoots, additionalWriteRoots } = configured(ctx);
  const additionalRoots = access === "write"
    ? additionalWriteRoots
    : [...(additionalReadRoots ?? []), ...(additionalWriteRoots ?? [])];
  return insideLegacyRoots([workdir, workspace, repoRoot, process.cwd(), "/tmp"], r)
    || insideLexicalRoots(Array.isArray(additionalRoots) ? additionalRoots : [], r);
}

/**
 * @param {string|undefined} workdir
 * @param {PublicPathGuardOptions} options
 */
export function isWorkdirAllowed(workdir: string | undefined, options: PublicPathGuardOptions): boolean {
  if (!workdir) return true;
  const ctx = (options ?? {}).ctx;
  const r = resolve(workdir);
  const policy = resolveSandboxPolicy(requireToolContext(ctx), options.sandboxPolicy);
  if (policy) {
    return !insideProtectedRoots(Array.isArray(policy.protectedRoots) ? policy.protectedRoots : [], r)
      && insideSandboxRoots(Array.isArray(policy.readableRoots) ? policy.readableRoots : [], r);
  }
  // Without a sandbox policy, admit the same roots file tools can read: the
  // legacy workspace roots plus operator-configured additional roots. A
  // workdir outside all of them, or a symlink escaping an additional root,
  // stays denied.
  const { workspace, repoRoot, additionalReadRoots, additionalWriteRoots } = configured(ctx);
  const additionalRoots = [...(additionalReadRoots ?? []), ...(additionalWriteRoots ?? [])];
  return insideLegacyRoots([workspace, repoRoot, process.cwd(), "/tmp"], r)
    || insideAdditionalRoots(additionalRoots, r);
}

/**
 * Protected descendants of one search root, as normalized relative paths.
 * Search tools use these both as ripgrep exclusions and as a defensive output
 * filter; actual reads still cross the native sandbox boundary.
 */
export function protectedRelativePaths(directory: any, options?: {}): any[];
export function protectedRelativePaths(directory: any, options: Partial<PublicPathGuardOptions> = {}): any[] {
  const ctx = options.ctx;
  const policy = resolveSandboxPolicy(requireToolContext(ctx), options.sandboxPolicy);
  if (!policy || !Array.isArray(policy.protectedRoots)) return [];
  const root = resolve(directory);
  const out = new Set<string>();
  for (const protectedRoot of normalizeRoots(policy.protectedRoots)) {
    const rel = relative(root, protectedRoot);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) out.add(rel);
  }
  return [...out].sort();
}

// Sandbox roots also enforce realpath containment so a symlink inside an
// allowed root cannot escape to a target outside the policy.
function insideSandboxRoots(roots: any, target: any) {
  const allowedRoots = normalizeRoots(roots);
  const real = realTargetPath(target);
  return allowedRoots.some((root) => isInsidePath(root, target))
    && allowedRoots.some((root) => isInsidePath(root, real));
}

// Additional file-tool roots are an operator-authored capability boundary even
// when process sandboxing is off. Unlike the legacy workspace allowance, keep
// both lexical and real paths inside the configured set so an allowed symlink
// cannot expose an unrelated path.
function insideAdditionalRoots(roots: any, target: any) {
  const allowedRoots = normalizeRoots(roots);
  const real = realTargetPath(target);
  return allowedRoots.some((root) => isInsidePath(root, target))
    && allowedRoots.some((root) => isInsidePath(root, real));
}

// A protected root rejects either spelling: the lexical request and its
// existing/nearest-existing realpath. This closes symlink aliases in both
// directions without weakening ordinary readable/writable root checks.
function insideProtectedRoots(roots: any, target: any) {
  const protectedRoots = normalizeRoots(roots);
  const candidates = [...new Set([resolve(target), realTargetPath(target)])];
  return candidates.some((candidate) =>
    protectedRoots.some((root) => isInsidePath(root, candidate)));
}

// Without a sandbox policy, keep the historical literal containment check —
// symlinks out of the workspace (npm link et al.) stay usable by default.
function insideLegacyRoots(roots: any, target: any) {
  const allowedRoots = [...new Set(roots.filter(Boolean).map((p: string) => resolve(p)))];
  return allowedRoots.some((root) => isInsidePath(root, target));
}

function insideLexicalRoots(roots: any, target: any) {
  const lexicalRoots = [...new Set(roots.filter(Boolean).map((path: string) => resolve(path)))];
  return lexicalRoots.some((root) => isInsidePath(root, target));
}

function normalizeRoots(paths: any) {
  const out = new Set<string>();
  for (const path of paths.filter(Boolean)) {
    const resolved = resolve(path);
    out.add(resolved);
    out.add(realTargetPath(resolved));
  }
  return [...out];
}

export function isInsidePath(root: any, target: any): boolean {
  if (!root || !target) return false;
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realTargetPath(target: any) {
  const resolved = resolve(target);
  if (existsSync(resolved)) {
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  let current = dirname(resolved);
  while (current && current !== dirname(current)) {
    if (existsSync(current)) {
      try { return resolve(realpathSync(current), relative(current, resolved)); } catch { return resolved; }
    }
    current = dirname(current);
  }
  return resolved;
}

function sandboxDeniesWrite(policy: any, target: any, ctx: any) {
  const patterns = Array.isArray(policy.denyWrite) ? policy.denyWrite : [];
  if (patterns.length === 0) return false;
  const candidates = [...new Set([resolve(target), realTargetPath(target)])];
  return candidates.some((candidate) =>
    patterns.some((pattern: string) => denyWritePatternMatches(policy, pattern, candidate, ctx)));
}

function sandboxLexicallyDeniesWrite(policy: any, target: any, ctx: any) {
  const patterns = Array.isArray(policy.denyWrite) ? policy.denyWrite : [];
  return patterns.some((pattern: string) => denyWritePatternMatches(policy, pattern, resolve(target), ctx));
}

function denyWritePatternMatches(policy: any, pattern: any, target: any, ctx: any) {
  if (!pattern || typeof pattern !== "string") return false;
  const normalizedPattern = normalizeMatchPath(pattern);
  if (isAbsolute(pattern)) {
    return globPatternMatches(normalizedPattern, normalizeMatchPath(target));
  }
  const root = resolve(policy.root || workspaceRoot(undefined, ctx));
  const rel = relative(root, resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return globPatternMatches(stripDotSlash(normalizedPattern), normalizeMatchPath(rel));
}

function normalizeMatchPath(path: any) {
  return path.replaceAll("\\", "/");
}

function stripDotSlash(path: any) {
  let out = path;
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function globPatternMatches(pattern: any, target: any) {
  return globPatternToRegExp(pattern).test(target);
}

function globPatternToRegExp(pattern: any) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegExp(char: any) {
  return /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char;
}

export type ToolContext = import("./tool-context.js").ToolContext;

export type PublicPathGuardOptions = {
  ctx: ToolContext;
  sandboxPolicy?: import("../../agent/sandbox-seam.js").SandboxPolicy;
};
