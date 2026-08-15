import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import { resolveAppArtifactDir, resolveAppSessionsRoot } from "./app-config.js";
import { acpSessionAuthorizationsRoot } from "./acp-session-store.js";
import { agentArtifactDerivedRoots } from "./agent-artifact-paths.js";

/** Every filesystem root removed by `restart --clear-sessions`. */
export interface ConversationStatePurgeRoots {
  readonly sessions?: string;
  readonly history: string;
  readonly acpSessions: string;
}

export type ConversationStatePurgeRootKind =
  | "Pi provider sessions"
  | "durable session/tool history"
  | "ACP sessions";

export interface FileSystemIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface AttestedConversationStatePurgeTarget {
  readonly identity: FileSystemIdentity;
  readonly parent: {
    readonly path: string;
    readonly canonicalPath: string;
    readonly identity: FileSystemIdentity;
  };
}

export interface ResolvedConversationStatePurgeRoot {
  readonly kind: ConversationStatePurgeRootKind;
  readonly path: string;
  readonly canonicalPath: string;
  /** Undefined when the configured root does not exist yet. */
  readonly target?: AttestedConversationStatePurgeTarget;
}

export interface ConversationStatePurgePlan {
  readonly roots: ConversationStatePurgeRoots;
  readonly sessions?: ResolvedConversationStatePurgeRoot;
  readonly history: ResolvedConversationStatePurgeRoot;
  readonly acpSessions: ResolvedConversationStatePurgeRoot;
}

/**
 * Resolve reset roots once so startup validation and the destructive purge path
 * remain bound to the same config/env precedence and derived directories.
 */
export async function resolveConversationStatePurgeRoots(
  input: MonoAgentAppConfigInput,
): Promise<ConversationStatePurgeRoots> {
  const [sessions, artifactDir] = await Promise.all([
    resolveAppSessionsRoot(input),
    resolveAppArtifactDir(input),
  ]);
  return {
    ...(sessions === undefined ? {} : { sessions }),
    history: agentArtifactDerivedRoots(artifactDir).history,
    acpSessions: acpSessionAuthorizationsRoot(artifactDir),
  };
}

/** Resolve and identity-pin every destructive reset root before any traversal or removal. */
export async function resolveConversationStatePurgePlan(
  input: MonoAgentAppConfigInput,
): Promise<ConversationStatePurgePlan> {
  const roots = await resolveConversationStatePurgeRoots(input);
  const [sessions, history, acpSessions] = await Promise.all([
    roots.sessions === undefined
      ? undefined
      : resolveAndAttestConversationStatePurgeRoot("Pi provider sessions", roots.sessions),
    resolveAndAttestConversationStatePurgeRoot("durable session/tool history", roots.history),
    resolveAndAttestConversationStatePurgeRoot("ACP sessions", roots.acpSessions),
  ]);
  return {
    roots,
    ...(sessions === undefined ? {} : { sessions }),
    history,
    acpSessions,
  };
}

/** Fail closed if any resolved reset target or its exact parent changed after preflight. */
export async function assertConversationStatePurgePlanUnchanged(
  plan: ConversationStatePurgePlan,
): Promise<void> {
  await Promise.all(conversationStatePurgePlanEntries(plan).map(assertConversationStatePurgeRootUnchanged));
}

export async function assertConversationStatePurgeRootUnchanged(
  expected: ResolvedConversationStatePurgeRoot,
): Promise<void> {
  let current: ResolvedConversationStatePurgeRoot;
  try {
    current = await resolveAndAttestConversationStatePurgeRoot(expected.kind, expected.path);
  } catch (error) {
    throw new Error(
      `restart --clear-sessions ${expected.kind} purge root identity, canonical path, or ancestor changed after validation; no conversation state was deleted.`,
      { cause: error },
    );
  }
  if (current.canonicalPath !== expected.canonicalPath) {
    throw changed(expected, "canonical path");
  }
  if (expected.target === undefined) {
    if (current.target !== undefined) throw changed(expected, "previously missing target");
    return;
  }
  if (current.target === undefined) throw changed(expected, "target");
  if (!sameIdentity(current.target.identity, expected.target.identity)) {
    throw changed(expected, "target identity");
  }
  if (current.target.parent.path !== expected.target.parent.path
    || current.target.parent.canonicalPath !== expected.target.parent.canonicalPath
    || !sameIdentity(current.target.parent.identity, expected.target.parent.identity)) {
    throw changed(expected, "ancestor identity or canonical path");
  }
}

export function conversationStatePurgePlanEntries(
  plan: ConversationStatePurgePlan,
): readonly ResolvedConversationStatePurgeRoot[] {
  return [
    ...(plan.sessions === undefined ? [] : [plan.sessions]),
    plan.history,
    plan.acpSessions,
  ];
}

export async function resolveAndAttestConversationStatePurgeRoot(
  kind: ConversationStatePurgeRootKind,
  path: string,
): Promise<ResolvedConversationStatePurgeRoot> {
  const lexicalPath = resolve(path);
  let initial: BigIntStats;
  try {
    initial = await lstat(lexicalPath, { bigint: true });
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    const canonicalPath = await canonicalMissingPath(lexicalPath, kind);
    try {
      await lstat(lexicalPath, { bigint: true });
    } catch (secondError) {
      if (isErrno(secondError, "ENOENT")) return { kind, path: lexicalPath, canonicalPath };
      throw secondError;
    }
    throw new Error(`restart --clear-sessions ${kind} purge root appeared during preflight: ${lexicalPath}`);
  }
  assertRealDirectory(initial, lexicalPath, kind);
  const parentPath = dirname(lexicalPath);
  if (parentPath === lexicalPath) {
    throw new Error(`restart --clear-sessions ${kind} purge root cannot be a filesystem root: ${lexicalPath}`);
  }
  const initialParent = await lstat(parentPath, { bigint: true });
  assertRealDirectory(initialParent, parentPath, `${kind} parent`);
  const [canonicalPath, canonicalParent] = await Promise.all([
    realpath(lexicalPath),
    realpath(parentPath),
  ]);
  if (dirname(canonicalPath) !== canonicalParent) {
    throw new Error(`restart --clear-sessions ${kind} purge root escaped its canonical parent: ${lexicalPath}`);
  }
  const [current, currentParent] = await Promise.all([
    lstat(lexicalPath, { bigint: true }),
    lstat(parentPath, { bigint: true }),
  ]);
  assertRealDirectory(current, lexicalPath, kind);
  assertRealDirectory(currentParent, parentPath, `${kind} parent`);
  if (!sameIdentity(initial, current) || !sameIdentity(initialParent, currentParent)) {
    throw new Error(`restart --clear-sessions ${kind} purge root or ancestor changed during preflight: ${lexicalPath}`);
  }
  return {
    kind,
    path: lexicalPath,
    canonicalPath,
    target: {
      identity: identityOf(initial),
      parent: {
        path: parentPath,
        canonicalPath: canonicalParent,
        identity: identityOf(initialParent),
      },
    },
  };
}

async function canonicalMissingPath(path: string, kind: ConversationStatePurgeRootKind): Promise<string> {
  let cursor = path;
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`restart --clear-sessions ${kind} purge root has no canonical ancestor: ${path}`);
    }
    missing.unshift(basename(cursor));
    cursor = parent;
  }
}

function assertRealDirectory(details: BigIntStats, path: string, label: string): void {
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`restart --clear-sessions ${label} must be a real directory: ${path}`);
  }
}

function identityOf(value: { readonly dev: bigint; readonly ino: bigint }): FileSystemIdentity {
  return { dev: value.dev, ino: value.ino };
}

export function sameFileSystemIdentity(
  value: { readonly dev: bigint; readonly ino: bigint },
  expected: FileSystemIdentity,
): boolean {
  return sameIdentity(value, expected);
}

function sameIdentity(
  value: { readonly dev: bigint; readonly ino: bigint },
  expected: FileSystemIdentity,
): boolean {
  return value.dev === expected.dev && value.ino === expected.ino;
}

function changed(root: ResolvedConversationStatePurgeRoot, detail: string): Error {
  return new Error(`restart --clear-sessions ${root.kind} purge root ${detail} changed after validation; no conversation state was deleted.`);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
