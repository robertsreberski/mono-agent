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
  readonly parent: AttestedConversationStatePurgeParent;
}

export interface AttestedConversationStatePurgeParent {
  readonly path: string;
  readonly canonicalPath: string;
  readonly identity: FileSystemIdentity;
}

export interface ResolvedConversationStatePurgeRoot {
  readonly kind: ConversationStatePurgeRootKind;
  readonly path: string;
  readonly canonicalPath: string;
  /** Present whenever the immediate parent exists, including after a crashed rename. */
  readonly parent?: AttestedConversationStatePurgeParent;
  /** Undefined when the configured root does not exist yet. */
  readonly target?: AttestedConversationStatePurgeTarget;
}

export interface ConversationStatePurgePlan {
  readonly roots: ConversationStatePurgeRoots;
  readonly sessions?: ResolvedConversationStatePurgeRoot;
  readonly history: ResolvedConversationStatePurgeRoot;
  readonly acpSessions: ResolvedConversationStatePurgeRoot;
}

export interface ConversationStateConfigSnapshot {
  readonly json: Readonly<Record<string, unknown>>;
}

export const CLEAR_SESSIONS_REGISTRY_DIRECTORY = "clear-sessions-v1";
export const CLEAR_SESSIONS_CONTROL_DIRECTORY = ".mono-agent-clear-sessions-v1";

export function clearSessionsRegistryRoot(cwd: string): string {
  return resolve(cwd, ".mono-agent", CLEAR_SESSIONS_REGISTRY_DIRECTORY);
}

/**
 * Resolve reset roots once so startup validation and the destructive purge path
 * remain bound to the same config/env precedence and derived directories.
 */
export async function resolveConversationStatePurgeRoots(
  input: MonoAgentAppConfigInput,
  snapshot?: ConversationStateConfigSnapshot,
): Promise<ConversationStatePurgeRoots> {
  const [sessions, artifactDir] = snapshot === undefined
    ? await Promise.all([
      resolveAppSessionsRoot(input),
      resolveAppArtifactDir(input),
    ])
    : resolveSnapshotRoots(input, snapshot.json);
  return {
    ...(sessions === undefined ? {} : { sessions }),
    history: agentArtifactDerivedRoots(artifactDir).history,
    acpSessions: acpSessionAuthorizationsRoot(artifactDir),
  };
}

/** Resolve and identity-pin every destructive reset root before any traversal or removal. */
export async function resolveConversationStatePurgePlan(
  input: MonoAgentAppConfigInput,
  snapshot?: ConversationStateConfigSnapshot,
): Promise<ConversationStatePurgePlan> {
  const roots = await resolveConversationStatePurgeRoots(input, snapshot);
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
    if (!sameOptionalParent(current.parent, expected.parent)) {
      throw changed(expected, "ancestor identity or canonical path");
    }
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
    const parent = await resolveOptionalParent(dirname(lexicalPath), kind);
    try {
      await lstat(lexicalPath, { bigint: true });
    } catch (secondError) {
      if (isErrno(secondError, "ENOENT")) {
        return { kind, path: lexicalPath, canonicalPath, ...(parent === undefined ? {} : { parent }) };
      }
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
    parent: {
      path: parentPath,
      canonicalPath: canonicalParent,
      identity: identityOf(initialParent),
    },
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

async function resolveOptionalParent(
  path: string,
  kind: ConversationStatePurgeRootKind,
): Promise<AttestedConversationStatePurgeParent | undefined> {
  let initial: BigIntStats;
  try {
    initial = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  assertRealDirectory(initial, path, `${kind} parent`);
  const canonicalPath = await realpath(path);
  const current = await lstat(path, { bigint: true });
  assertRealDirectory(current, path, `${kind} parent`);
  if (!sameIdentity(initial, current)) {
    throw new Error(`restart --clear-sessions ${kind} parent changed during preflight: ${path}`);
  }
  return { path, canonicalPath, identity: identityOf(initial) };
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

function sameOptionalParent(
  value: AttestedConversationStatePurgeParent | undefined,
  expected: AttestedConversationStatePurgeParent | undefined,
): boolean {
  if (value === undefined || expected === undefined) return value === expected;
  return value.path === expected.path
    && value.canonicalPath === expected.canonicalPath
    && sameIdentity(value.identity, expected.identity);
}

function resolveSnapshotRoots(
  input: MonoAgentAppConfigInput,
  json: Readonly<Record<string, unknown>>,
): readonly [string | undefined, string] {
  const envSessions = input.env.MONO_AGENT_PI_SESSIONS_ROOT?.trim();
  const envArtifacts = input.env.MONO_AGENT_ARTIFACT_DIR?.trim();
  const providers = optionalObject(json.providers, "providers");
  const piNative = optionalObject(providers?.piNative, "providers.piNative");
  const artifacts = optionalObject(json.artifacts, "artifacts");
  const configuredSessions = optionalPath(piNative?.piSessionsRoot, "providers.piNative.piSessionsRoot");
  const configuredArtifacts = optionalPath(artifacts?.dir, "artifacts.dir");
  return [
    envSessions === undefined || envSessions.length === 0
      ? (configuredSessions === undefined ? undefined : resolve(input.cwd, configuredSessions))
      : resolve(input.cwd, envSessions),
    envArtifacts === undefined || envArtifacts.length === 0
      ? resolve(input.cwd, configuredArtifacts ?? ".mono-agent/artifacts")
      : resolve(input.cwd, envArtifacts),
  ];
}

function optionalObject(value: unknown, label: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`restart --clear-sessions ${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalPath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`restart --clear-sessions ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
