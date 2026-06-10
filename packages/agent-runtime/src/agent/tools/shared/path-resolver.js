import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readToolRuntime } from "./runtime-context.js";

function configured() {
  const { workspace, repoRoot } = readToolRuntime();
  return { workspace, repoRoot };
}

export function workspaceRoot(workdir) {
  const { workspace, repoRoot } = configured();
  return resolve(workdir || workspace || repoRoot || process.cwd());
}

export function resolveToolPath(path, workdir) {
  if (!path || typeof path !== "string") return path;
  return resolve(isAbsolute(path) ? path : resolve(workspaceRoot(workdir), path));
}

function roots(workdir, access = "read", options = {}) {
  const { workspace, repoRoot } = configured();
  const sandboxRoots = sandboxPathRoots(access, options.sandboxPolicy);
  if (sandboxRoots.length) return sandboxRoots;
  return normalizeRoots([
    workdir,
    workspace,
    repoRoot,
    process.cwd(),
    "/tmp",
  ]);
}

export function isPathAllowed(path, workdir, options = {}) {
  return isPathAllowedFor(path, workdir, "read", options);
}

export function isWritablePathAllowed(path, workdir, options = {}) {
  return isPathAllowedFor(path, workdir, "write", options);
}

export function isPathReadable(path, workdir, options = {}) {
  return isPathAllowedFor(path, workdir, "read", options);
}

function isPathAllowedFor(path, workdir, access, options) {
  const r = resolveToolPath(path, workdir);
  const real = realTargetPath(r);
  const allowedRoots = roots(workdir, access, options);
  return allowedRoots.some((root) => pathInside(root, r))
    && allowedRoots.some((root) => pathInside(root, real));
}

function envRoots(options = {}) {
  const { workspace, repoRoot } = configured();
  const sandboxRoots = sandboxPathRoots("read", options.sandboxPolicy);
  if (sandboxRoots.length) return sandboxRoots;
  return normalizeRoots([
    workspace,
    repoRoot,
    process.cwd(),
    "/tmp",
  ]);
}

export function isWorkdirAllowed(workdir, options = {}) {
  if (!workdir) return true;
  const r = resolve(workdir);
  const real = realTargetPath(r);
  const allowedRoots = envRoots(options);
  return allowedRoots.some((root) => pathInside(root, r))
    && allowedRoots.some((root) => pathInside(root, real));
}

function sandboxPathRoots(access = "read", sandboxPolicy = undefined) {
  const policy = sandboxPolicy ?? readToolRuntime().sandboxPolicy;
  if (!policy || policy.mode === "off") return [];
  const field = access === "write" ? policy.writableRoots : policy.readableRoots;
  return normalizeRoots(Array.isArray(field) ? field : []);
}

function normalizeRoots(paths) {
  const out = new Set();
  for (const path of paths.filter(Boolean)) {
    const resolved = resolve(path);
    out.add(resolved);
    out.add(realTargetPath(resolved));
  }
  return [...out];
}

function pathInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realTargetPath(target) {
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
