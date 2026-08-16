import { createHash, randomUUID } from "node:crypto";
import { realpathSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import process from "node:process";

import {
  acquireOwnerPrivateLock,
  validateOwnerPrivateLockInputs,
  type OwnerPrivateLock,
} from "./owner-private-lock.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";
import { accountHomeDirectory } from "./account-home.js";

const AGENT_ROOT_LEASE_SCHEMA = "mono-agent.agent-root-lease.v1";
const AGENT_ROOT_LEASE_OWNERLESS_GRACE_MS = 5 * 60_000;
const AGENT_ROOT_LEASE_ACQUIRE_ATTEMPTS = 4;
export const PROCESS_JOBS_GENERATION_DRAIN_TIMEOUT_MS = 30_000;

export const AGENT_ROOT_OWNED_ELSEWHERE_ERROR =
  "Another mono-agent process is already using this agent root. Stop that local agent before trying again.";
export const AGENT_ROOT_REQUIRED_ERROR =
  "A configured local runtime requires an explicit agent-root cwd.";
export const PROCESS_JOBS_GENERATION_CHANGED_ERROR =
  "Process-job private-state protection changed before provider execution.";
export const PROCESS_JOBS_GENERATION_DRAIN_TIMEOUT_ERROR =
  "Process-job private-state protection could not safely finish the live configuration switch.";

export interface AgentRootProtectionGeneration {
  readonly id: string;
  readonly rootKeys: readonly string[];
}

export interface AgentRootRequestLease {
  readonly generation: AgentRootProtectionGeneration;
  releaseAfterSettlement(): void;
}

export interface AgentRootMutationGate {
  readonly generation: AgentRootProtectionGeneration;
  release(): void;
}

export interface AgentRootOwnership {
  readonly agentRoot: string;
  readonly coordinator: AgentRootCoordinator;
  /** Release this in-process reference; the OS lease remains until every request truly settles. */
  release(): void;
}

export interface AcquireAgentRootOwnershipOptions {
  readonly homeDir?: string;
  readonly pid?: number;
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly processIncarnation?: ProcessIncarnation;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
  readonly ownerlessGraceMs?: number;
  readonly hooks?: {
    readonly afterLeaseDirectoryCreated?: () => Promise<void>;
    readonly beforeStaleLeaseRename?: () => Promise<void>;
    /** Test-only fault seam for the final physical owner-lock release. */
    readonly beforeLeaseRelease?: () => Promise<void>;
  };
}

/** Stable owner-record path for an already-canonical agent root. */
export function agentRootLeasePath(
  canonicalRoot: string,
  homeDir: string = accountHomeDirectory(),
): string {
  const digest = rootDigest(canonicalRoot);
  return join(resolve(homeDir), ".mono-agent", "agent-root-leases", `${digest}.lease`);
}

interface ActiveGeneration {
  readonly roots: ReadonlySet<string>;
  count: number;
}

interface CoordinatorEntry {
  readonly agentRoot: string;
  readonly lease: OwnerPrivateLock;
  readonly leasePath: string;
  readonly beforeLeaseRelease?: () => Promise<void>;
  readonly active: Map<string, ActiveGeneration>;
  readonly waiters: Set<() => void>;
  ownerRefs: number;
  current?: AgentRootProtectionGeneration;
  mutationPending: boolean;
  closing: boolean;
  closeError?: Error;
  closed: Promise<void>;
  resolveClosed: () => void;
}

const entries = new Map<string, CoordinatorEntry>();
const acquisitions = new Map<string, Promise<CoordinatorEntry>>();
const ownershipEntries = new WeakMap<AgentRootOwnership, CoordinatorEntry>();
const releasedOwnerships = new WeakSet<AgentRootOwnership>();

/**
 * One process-global coordinator per canonical agent root. It combines the
 * cross-process lifetime lease with in-process registry-generation settlement.
 */
export class AgentRootCoordinator {
  readonly #entry: CoordinatorEntry;

  constructor(entry: CoordinatorEntry) {
    this.#entry = entry;
  }

  get agentRoot(): string {
    return this.#entry.agentRoot;
  }

  currentGeneration(): AgentRootProtectionGeneration | undefined {
    return this.#entry.current;
  }

  publishGeneration(generation: AgentRootProtectionGeneration): void {
    assertGeneration(generation);
    this.#entry.current = frozenGeneration(generation);
    notifyWaiters(this.#entry);
  }

  /** Adopt an already-durable generation without allowing a stale constructor to roll it back. */
  synchronizeGeneration(generation: AgentRootProtectionGeneration): void {
    assertGeneration(generation);
    if (this.#entry.current === undefined) {
      this.publishGeneration(generation);
      return;
    }
    if (!sameGeneration(this.#entry.current, generation)) {
      throw new Error(PROCESS_JOBS_GENERATION_CHANGED_ERROR);
    }
  }

  acquireRequestLease(generation: AgentRootProtectionGeneration): AgentRootRequestLease {
    if (this.#entry.closing) {
      throw this.#entry.closeError
        ?? new Error("Agent-root ownership is already being released.");
    }
    assertGeneration(generation);
    const current = this.#entry.current;
    if (current === undefined || !sameGeneration(current, generation)) {
      throw new Error(PROCESS_JOBS_GENERATION_CHANGED_ERROR);
    }
    let active = this.#entry.active.get(generation.id);
    if (active === undefined) {
      active = { roots: new Set(generation.rootKeys), count: 0 };
      this.#entry.active.set(generation.id, active);
    } else if (!sameRoots(active.roots, generation.rootKeys)) {
      throw new Error(PROCESS_JOBS_GENERATION_CHANGED_ERROR);
    }
    active.count += 1;
    let released = false;
    return {
      generation: frozenGeneration(generation),
      releaseAfterSettlement: () => {
        if (released) return;
        released = true;
        const held = this.#entry.active.get(generation.id);
        if (held === undefined || held.count < 1) return;
        held.count -= 1;
        if (held.count === 0) this.#entry.active.delete(generation.id);
        notifyWaiters(this.#entry);
        scheduleFinalRelease(this.#entry);
      },
    };
  }

  /**
   * Publish the durable generation, then wait only for older leases which did
   * not cover the root about to be opened. Timeout is fail-closed: callers must
   * not open or create the ProcessJobs store after rejection.
   */
  async publishAndAcquireMutationGate(
    generation: AgentRootProtectionGeneration,
    requiredRootKey: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<AgentRootMutationGate> {
    if (this.#entry.closing) {
      throw this.#entry.closeError
        ?? new Error("Agent-root ownership is already being released.");
    }
    if (this.#entry.mutationPending) {
      throw new Error(PROCESS_JOBS_GENERATION_CHANGED_ERROR);
    }
    this.publishGeneration(generation);
    this.#entry.mutationPending = true;
    const timeoutMs = options.timeoutMs ?? PROCESS_JOBS_GENERATION_DRAIN_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      this.#entry.mutationPending = false;
      throw new TypeError("Process-job generation drain timeout must be a positive finite number.");
    }
    try {
      await waitUntil(
        this.#entry,
        () => !hasIncompatibleLease(this.#entry, generation.id, requiredRootKey),
        timeoutMs,
      );
    } catch (error) {
      this.#entry.mutationPending = false;
      notifyWaiters(this.#entry);
      scheduleFinalRelease(this.#entry);
      if (error instanceof DrainTimeoutError) {
        throw new Error(PROCESS_JOBS_GENERATION_DRAIN_TIMEOUT_ERROR);
      }
      throw error;
    }
    let released = false;
    return {
      generation: frozenGeneration(generation),
      release: () => {
        if (released) return;
        released = true;
        this.#entry.mutationPending = false;
        notifyWaiters(this.#entry);
        scheduleFinalRelease(this.#entry);
      },
    };
  }

  /** Test/coordination seam: resolves only when no request lease remains. */
  async waitForSettlement(): Promise<void> {
    await waitUntil(this.#entry, () => this.#entry.active.size === 0, undefined);
  }
}

/** Acquire the reentrant process lifetime owner for one canonical agent root. */
export async function acquireAgentRootOwnership(
  agentRoot: string | undefined,
  options: AcquireAgentRootOwnershipOptions = {},
): Promise<AgentRootOwnership> {
  if (agentRoot === undefined || agentRoot.trim().length === 0) {
    throw new Error(AGENT_ROOT_REQUIRED_ERROR);
  }
  const canonicalRoot = await canonicalAgentRoot(agentRoot);
  for (;;) {
    const existing = entries.get(canonicalRoot);
    if (existing !== undefined) {
      if (existing.closing) {
        await existing.closed;
        if (existing.closeError !== undefined) throw existing.closeError;
        continue;
      }
      existing.ownerRefs += 1;
      return ownershipHandle(existing);
    }
    const pending = acquisitions.get(canonicalRoot);
    if (pending !== undefined) {
      const entry = await pending;
      if (entry.closing) {
        await entry.closed;
        if (entry.closeError !== undefined) throw entry.closeError;
        continue;
      }
      entry.ownerRefs += 1;
      return ownershipHandle(entry);
    }
    const acquiring = createEntry(canonicalRoot, options);
    acquisitions.set(canonicalRoot, acquiring);
    try {
      const entry = await acquiring;
      entries.set(canonicalRoot, entry);
      entry.ownerRefs = 1;
      return ownershipHandle(entry);
    } finally {
      if (acquisitions.get(canonicalRoot) === acquiring) acquisitions.delete(canonicalRoot);
    }
  }
}

/**
 * Release one logical owner and, only when it was the already-idle final
 * reference, wait for the physical cross-process lease to disappear.
 *
 * Active request or mutation leases deliberately make this return `false`
 * immediately. They retain the physical lock until true settlement so bounded
 * app/harness teardown cannot create split ownership.
 */
export async function releaseAgentRootOwnershipWhenIdle(
  ownership: AgentRootOwnership,
): Promise<boolean> {
  const entry = entryFor(ownership);
  if (releasedOwnerships.has(ownership)) {
    if (!entry.closing) return false;
    await entry.closed;
    if (entry.closeError !== undefined) throw entry.closeError;
    return true;
  }
  const shouldWait = releaseOwnershipReference(ownership, entry);
  if (!shouldWait) return false;
  await entry.closed;
  if (entry.closeError !== undefined) throw entry.closeError;
  return true;
}

/** Reject the exceptional case where the global coordination lease is model-workspace reachable. */
export function assertAgentRootLeaseOutsideWorkspace(
  ownership: AgentRootOwnership,
  workspace: string,
): void {
  const entry = entryFor(ownership);
  const resolvedWorkspace = resolve(workspace);
  const canonicalWorkspace = realpathSync(resolvedWorkspace);
  if (containsPath(resolvedWorkspace, entry.leasePath)
    || containsPath(canonicalWorkspace, entry.leasePath)) {
    throw new Error(
      "The configured model workspace contains mono-agent's private process-coordination data. Choose a narrower workspace.",
    );
  }
}

function ownershipHandle(entry: CoordinatorEntry): AgentRootOwnership {
  const coordinator = new AgentRootCoordinator(entry);
  const handle: AgentRootOwnership = {
    agentRoot: entry.agentRoot,
    coordinator,
    release: () => {
      releaseOwnershipReference(handle, entry);
    },
  };
  ownershipEntries.set(handle, entry);
  return handle;
}

function releaseOwnershipReference(
  ownership: AgentRootOwnership,
  entry: CoordinatorEntry,
): boolean {
  if (releasedOwnerships.has(ownership)) return false;
  releasedOwnerships.add(ownership);
  entry.ownerRefs = Math.max(0, entry.ownerRefs - 1);
  const shouldWait = entry.ownerRefs === 0
    && entry.active.size === 0
    && !entry.mutationPending
    && !entry.closing;
  scheduleFinalRelease(entry);
  return shouldWait;
}

function entryFor(ownership: AgentRootOwnership): CoordinatorEntry {
  const entry = ownershipEntries.get(ownership);
  if (entry === undefined) throw new Error("Agent-root ownership handle is invalid.");
  return entry;
}

async function createEntry(
  canonicalRoot: string,
  options: AcquireAgentRootOwnershipOptions,
): Promise<CoordinatorEntry> {
  try {
    const home = resolve(options.homeDir ?? accountHomeDirectory());
    const leaseRoot = await ensurePrivateLeaseRoot(home);
    const digest = rootDigest(canonicalRoot);
    const leasePath = agentRootLeasePath(canonicalRoot, home);
    const pid = options.pid ?? process.pid;
    const ownerlessGraceMs = options.ownerlessGraceMs ?? AGENT_ROOT_LEASE_OWNERLESS_GRACE_MS;
    validateOwnerPrivateLockInputs("Agent-root lease", pid, ownerlessGraceMs);
    const lease = await acquireOwnerPrivateLock({
      path: leasePath,
      label: "Agent-root lease",
      schemaTag: AGENT_ROOT_LEASE_SCHEMA,
      ownerlessGraceMs,
      maxAcquireAttempts: AGENT_ROOT_LEASE_ACQUIRE_ATTEMPTS,
      pid,
      ...(options.now === undefined ? {} : { now: options.now }),
      randomToken: options.randomToken ?? (() => randomUUID()),
      ...(options.processIncarnation === undefined ? {} : { processIncarnation: options.processIncarnation }),
      ...(options.isSameProcessIncarnation === undefined
        ? {}
        : { isSameProcessIncarnation: options.isSameProcessIncarnation }),
      ownerFields: () => ({ rootDigest: digest }),
      validateOwnerFields: (record) => record.rootDigest === digest,
      invalidOwner: "error",
      livenessError: () => "assume-live",
      ...(options.hooks?.afterLeaseDirectoryCreated === undefined
        ? {}
        : { afterDirectoryCreated: options.hooks.afterLeaseDirectoryCreated }),
      ...(options.hooks?.beforeStaleLeaseRename === undefined
        ? {}
        : { beforeStaleRename: options.hooks.beforeStaleLeaseRename }),
      staleRace: "return",
      stalePath: ({ now, pid: stalePid, token }) => join(leaseRoot, `.${digest}-${now}-${stalePid}-${token}.stale`),
      releasedPath: ({ pid: ownerPid, token }) => join(leaseRoot, `.${digest}-${ownerPid}-${token}.released`),
      abandonedPath: ({ pid: ownerPid, token }) => join(leaseRoot, `.${digest}-${ownerPid}-${token}.abandoned`),
    });
    if (lease === undefined) throw new Error(AGENT_ROOT_OWNED_ELSEWHERE_ERROR);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolveClosedPromise) => { resolveClosed = resolveClosedPromise; });
    return {
      agentRoot: canonicalRoot,
      lease,
      leasePath,
      ...(options.hooks?.beforeLeaseRelease === undefined
        ? {}
        : { beforeLeaseRelease: options.hooks.beforeLeaseRelease }),
      active: new Map(),
      waiters: new Set(),
      ownerRefs: 0,
      mutationPending: false,
      closing: false,
      closed,
      resolveClosed,
    };
  } catch (error) {
    if (error instanceof Error && error.message === AGENT_ROOT_OWNED_ELSEWHERE_ERROR) throw error;
    throw new Error(
      "Mono-agent could not establish private ownership of this agent root. Check the local owner and permissions, then retry.",
      { cause: error },
    );
  }
}

function scheduleFinalRelease(entry: CoordinatorEntry): void {
  if (entry.ownerRefs !== 0 || entry.active.size !== 0 || entry.mutationPending || entry.closing) return;
  entry.closing = true;
  void (async () => {
    try {
      await entry.lease.release(
        entry.beforeLeaseRelease === undefined
          ? undefined
          : { beforeRename: entry.beforeLeaseRelease },
      );
      if (entries.get(entry.agentRoot) === entry) entries.delete(entry.agentRoot);
    } catch (error) {
      // The physical lock may be in an indeterminate release state. Keep this
      // coordinator permanently closed so this process cannot loop or split
      // into a second logical owner. Process restart is the recovery boundary.
      entry.closeError = new Error(
        "Mono-agent could not safely release ownership of this agent root. Restart the local process before retrying.",
        { cause: error },
      );
    } finally {
      entry.resolveClosed();
    }
  })();
}

function notifyWaiters(entry: CoordinatorEntry): void {
  for (const notify of [...entry.waiters]) notify();
}

async function waitUntil(
  entry: CoordinatorEntry,
  predicate: () => boolean,
  timeoutMs: number | undefined,
): Promise<void> {
  if (predicate()) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (!predicate()) return;
      cleanup();
      resolvePromise();
    };
    const cleanup = (): void => {
      entry.waiters.delete(finish);
      if (timer !== undefined) clearTimeout(timer);
    };
    entry.waiters.add(finish);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        rejectPromise(new DrainTimeoutError());
      }, timeoutMs);
      timer.unref?.();
    }
    finish();
  });
}

class DrainTimeoutError extends Error {}

function hasIncompatibleLease(
  entry: CoordinatorEntry,
  currentGenerationId: string,
  requiredRootKey: string,
): boolean {
  for (const [generationId, active] of entry.active) {
    if (active.count < 1) continue;
    if (generationId === currentGenerationId && active.roots.has(requiredRootKey)) continue;
    if (!active.roots.has(requiredRootKey)) return true;
  }
  return false;
}

function assertGeneration(generation: AgentRootProtectionGeneration): void {
  if (generation.id.length === 0 || generation.rootKeys.some((root) => root.length === 0)) {
    throw new TypeError("Agent-root protection generation is malformed.");
  }
  const sorted = [...new Set(generation.rootKeys)].sort();
  if (!sameStringArrays(sorted, generation.rootKeys)) {
    throw new TypeError("Agent-root protection roots must be unique and sorted.");
  }
}

function frozenGeneration(generation: AgentRootProtectionGeneration): AgentRootProtectionGeneration {
  return Object.freeze({ id: generation.id, rootKeys: Object.freeze([...generation.rootKeys]) });
}

function sameGeneration(left: AgentRootProtectionGeneration, right: AgentRootProtectionGeneration): boolean {
  return left.id === right.id && sameStringArrays(left.rootKeys, right.rootKeys);
}

function sameRoots(left: ReadonlySet<string>, right: readonly string[]): boolean {
  return left.size === right.length && right.every((root) => left.has(root));
}

function sameStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function canonicalAgentRoot(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const details = await lstat(canonical);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("The agent root must be a real directory.");
  }
  assertOwned(details, "The agent root");
  return canonical;
}

async function ensurePrivateLeaseRoot(home: string): Promise<string> {
  const homeDetails = await lstat(home);
  if (!homeDetails.isDirectory() || homeDetails.isSymbolicLink()) {
    throw new Error("The effective-user home must be a real directory.");
  }
  assertOwned(homeDetails, "The effective-user home");
  const managedRoot = join(home, ".mono-agent");
  const leaseRoot = join(managedRoot, "agent-root-leases");
  for (const path of [managedRoot, leaseRoot]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("The agent-root lease parent must be a real directory.");
    }
    assertOwned(before, "The agent-root lease parent");
    await chmod(path, 0o700);
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || (after.mode & 0o077) !== 0) {
      throw new Error("The agent-root lease parent changed while it was secured.");
    }
    assertOwned(after, "The agent-root lease parent");
  }
  return leaseRoot;
}

function assertOwned(details: Pick<Stats, "uid">, label: string): void {
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user.`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolutePath(fromParent));
}

function rootDigest(canonicalRoot: string): string {
  return createHash("sha256").update(resolve(canonicalRoot)).digest("hex");
}

function isAbsolutePath(path: string): boolean {
  return resolve(path) === path;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
