import { assertNativeSessionAccess, assertNativeSessionHeader, assertNativeProjectionBinding } from "./session-authority.js";
import { inspectCurrentEvidence, inspectCurrentLifecycle, projectContext } from "./request-projection.js";
// @ts-check
// Native session ownership, liveness and persistence; no runtime presentation.
import { JsonlSessionRepo, MemorySessionRepo } from "./session-store.js";
import { JournalStorageError, isJournalStorageError } from "./storage-error.js";
import { validRecoveryProjection } from "./terminal-recovery.js";
import { createHash } from "node:crypto";
import { access, open } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeDurableSessionsRoot } from "./sessions-root.js";
import { createSessionRegistry } from "./session-registry.js";
import { createSessionLiveness } from "./session-liveness.js";
import { createPiSessionAdapter } from "./session-adapter.js";
import { ENGINE_CONTEXT } from "./context.js";
import { validateSessionTurn } from "./journal-schema.js";
import { readTurnEvidence, matchTurnEvidence } from "./turn-evidence.js";
import { repairInterruptedSession } from "./interruption.js";

async function syncPath(path: any): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDurableTranscript(entry: any): Promise<void> {
  if (entry.recoveryPending) throw new Error("Pi terminal recovery is pending");
  if (!entry.durable) return;
  const path = entry.metadata?.path;
  if (typeof path !== "string" || !path) {
    throw new Error("Durable session metadata is missing its JSONL path");
  }
  // The harness owns a pinned descriptor and writer lock across this barrier.
  // Fsync both the journal and its complete publication-directory chain.
  await entry.repo.sync(entry.metadata);
}

async function invalidateNativeSession(entry: any): Promise<void> {
  if (entry.durable) {
    const path = entry.metadata?.path;
    if (typeof path !== "string" || !path) {
      throw new Error("Durable session metadata is missing its JSONL path");
    }
    // Explicit invalidation is idempotent. A preceding failed sync may have
    // observed that the transcript was already removed outside this process.
    try {
      await access(path);
    } catch (error) {
      if ((error as { code?: string; message?: string; sessionId?: string })?.code === "ENOENT") return;
      throw error;
    }
  }
  await entry.repo.delete(entry.metadata, ENGINE_CONTEXT);
  if (entry.durable) {
    const path = entry.metadata.path;
    // Make the unlink durable before the registry forgets the busy marker.
    await syncPath(dirname(path));
  }
}

/**
 * Release a session handle and remove its repository record as independent
 * best-effort operations. A close failure must not prevent deletion of a fresh
 * or otherwise poisoned transcript.
 */
async function closeAndDeleteSession(session: any, repo: any, knownMetadata?: any): Promise<void> {
  let metadata = knownMetadata;
  if (!metadata) {
    try { metadata = await session.getMetadata(); } catch { /* best-effort */ }
  }
  try { await session.close(); } catch { /* best-effort */ }
  if (metadata) {
    try { await repo.delete(metadata, ENGINE_CONTEXT); } catch { /* best-effort */ }
  }
}

const nativeSessionRepo = new MemorySessionRepo();
const nativeSessions = createSessionRegistry({
  isBusy: (entry: any) => entry.busy === true || entry.recoveryPending === true,
  onSync: syncDurableTranscript,
  onEvict: async (entry: any, reason: string) => {
    if (reason === "invalidated") {
      await invalidateNativeSession(entry);
      return;
    }
    if (entry.durable) return;
    await entry.repo.delete(entry.metadata, ENGINE_CONTEXT);
  },
});
const liveness = createSessionLiveness(nativeSessions);

const durableNativeSessionRepos = new Map();
// Cold catalogue lookup happens before registry adoption/reservation. Track the
// whole await window so preserving detach cannot claim that handle is idle.
const coldOpenCounts = new Map();

export function resolveDurableNativeSessionRepo(sessionsRoot: any): any {
  const root = normalizeDurableSessionsRoot(sessionsRoot);
  if (!root) return null;
  let repo = durableNativeSessionRepos.get(root);
  if (!repo) {
    repo = new JsonlSessionRepo({
      sessionsRoot: root,
      onRootPermissionsTightened: () => { repo.rootPermissionWarningPending = true; },
    });
    durableNativeSessionRepos.set(root, repo);
  }
  return repo;
}

/**
 * Retire every currently materialized durable session transcript with this exact
 * logical id. This is intentionally stronger than live-session invalidation:
 * history rotation and retention can retire an epoch after its registry entry
 * was already evicted or after a process restart. Active writers reject late
 * append admission and retain kernel ownership until close. The
 * canonical epoch has already rotated, so that old id is never resumable in the
 * interim. Absence is success; cleanup or verification uncertainty rejects.
 */
export async function retireDurableNativeSession(providerSessionId: any, sessionsRoot: any, deletionOptions: any = undefined): Promise<void> {
  if (!isSafeSessionId(providerSessionId)) {
    throw new TypeError("providerSessionId must be a safe, non-empty session id");
  }
  if (typeof sessionsRoot !== "string" || !sessionsRoot.trim()) {
    throw new TypeError("sessionsRoot must be a non-empty path");
  }

  await nativeSessions.refresh(providerSessionId);
  const repo = resolveDurableNativeSessionRepo(sessionsRoot);
  if (!repo) throw new Error("Durable session repository is unavailable");
  if (deletionOptions === undefined) await repo.retireByHandle(providerSessionId);
  else await repo.retireByHandle(providerSessionId, deletionOptions);
}

/** Preserving detach, separate from destructive retirement. Reject a busy or
 * unresolved handle; the host must settle it first. Durable bytes are untouched.
 * This does not establish cross-process canonical retirement authority.
 */
export async function detachDurableNativeSession(providerSessionId: any, sessionsRoot: any): Promise<{
    status: string;
    evidence: string;
}> {
  if (!isSafeSessionId(providerSessionId) || typeof sessionsRoot !== "string" || !sessionsRoot.trim()) throw new TypeError("Invalid durable detach identity");
  const entry = nativeSessions.get(providerSessionId);
  if (coldOpenCounts.has(providerSessionId) || entry?.busy || entry?.recoveryPending) throw Object.assign(new Error("Native turn must be settled before detach"), { code: "ERR_HARNESS_WRITER_BUSY" });
  if (entry && (!entry.durable || entry.repo !== resolveDurableNativeSessionRepo(sessionsRoot))) throw new TypeError("Native detach owner mismatch");
  // Sessions are closed after each idle turn. Removal deliberately bypasses
  // onEvict: invalidation deletes, while ordinary disposal syncs unnecessarily.
  if (entry && !nativeSessions.delete(providerSessionId)) throw new Error("Native detach unavailable");
  return { status: "detached", evidence: "preserved" };
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeSessionId(id: any): boolean {
  return typeof id === "string"
    && SAFE_SESSION_ID.test(id)
    && !id.includes("..")
    && !id.includes("/")
    && !id.includes("\\");
}

/** Reopen by handle. Unrelated or unattributed journal-named entries never
 * block another handle's valid journal. `uncertain` reports that no journal was
 * found while an unreadable entry could be this handle's own damaged journal;
 * `owned` that a damaged entry is attributed to exactly this handle. */
async function reopenDurableNativeSession(repo: any, sessionId: any, context: typeof ENGINE_CONTEXT = ENGINE_CONTEXT): Promise<{entry: any; uncertain: boolean; owned?: boolean; busy?: boolean}> {
  if (!isSafeSessionId(sessionId)) return { entry: null, uncertain: false };
  try {
    const metadata = await repo.find(sessionId, context);
    return { entry: metadata ? { metadata, repo, durable: true, busy: false } : null, uncertain: false };
  } catch (error) {
    // A failed lookup cannot authorize cold replay, but only attributed damage
    // can prohibit a new conversation. A live creator is busy, not damaged.
    return { entry: null, uncertain: true,
      owned: (error as { code?: string; message?: string; sessionId?: string })?.code === "ERR_HARNESS_JOURNAL_UNREADABLE" && (error as { code?: string; message?: string; sessionId?: string }).sessionId === sessionId,
      busy: (error as { code?: string; message?: string; sessionId?: string })?.code === "ERR_HARNESS_WRITER_BUSY" };
  }
}

const isJournalCorruption = (error: any) => error instanceof SyntaxError || (error as { code?: string; message?: string; sessionId?: string })?.code === "ERR_HARNESS_JOURNAL_CORRUPT";

const unavailable = (sessionId: string, message: string, failureKind: string, code: string) => ({ status: (("unavailable") as const), unavailable: { failureKind, code, sessionId, message } });

/**
 * Resolve the session for this run: warm registry hit, durable cold reopen,
 * create-on-miss (durable resume only), or fresh create. Mutates runState
 * (session / sessionEntry / createdOnMiss / reservation). Returns
 * Return a storage-only unavailable outcome or readiness to proceed.
 */
export async function resolveSession(runState: NativeSessionState, {
  requestedSessionId,
  providerSessionId,
  durableRepo,
  sessionTtlMs,
  cwd,
  access,
  projection,
  waitSignal,
  keepAlive,
  requireExisting,
}: { requestedSessionId: string | null; providerSessionId: string; durableRepo: any; sessionTtlMs?: number; cwd?: string; access?: any; projection?: any; waitSignal?: AbortSignal; keepAlive?: boolean; requireExisting?: boolean; }): Promise<{
    status: "ready";
} | {
    status: "unavailable";
    unavailable: {
        failureKind: string;
        code: string;
        sessionId: string;
        message: string;
    };
}> {
  const waitContext = waitSignal ? { abortSignal: waitSignal } : ENGINE_CONTEXT;
  if (access) await assertNativeSessionAccess(access, "open", durableRepo.root);
  // Resume check first: a session miss must stay cheap (no tool/MCP/harness
  // init). This mirrors the legacy bridge's fail-fast contract.
  if (requestedSessionId) {
    let entry = liveness.adoptIfPresent(requestedSessionId), uncertain = false, owned = false, busy = false;
    if (!entry && durableRepo) {
      coldOpenCounts.set(requestedSessionId, (coldOpenCounts.get(requestedSessionId) ?? 0) + 1);
      try {
        ({ entry, uncertain, owned = false, busy = false } = await reopenDurableNativeSession(durableRepo, requestedSessionId, waitContext));
        waitSignal?.throwIfAborted(); // a cancelled catalogue wait is not a miss
        if (entry) {
          const concurrent = liveness.adoptIfPresent(requestedSessionId);
          if (concurrent) {
            entry = concurrent;
          } else {
            nativeSessions.set(requestedSessionId, entry, { idleTimeoutMs: sessionTtlMs! });
          }
        }
      } finally {
        const remaining = coldOpenCounts.get(requestedSessionId) - 1;
        if (remaining) coldOpenCounts.set(requestedSessionId, remaining); else coldOpenCounts.delete(requestedSessionId);
      }
    }
    const unreadable = () => unavailable(requestedSessionId, `Session ${requestedSessionId} catalogue could not be read; native evidence was preserved`, "native_journal_unreadable", "pi_session_unreadable");
    if (!entry) {
      if (busy) return unavailable(requestedSessionId, `Session ${requestedSessionId} is busy`, "session_busy", "pi_session_busy");
      if (durableRepo && requireExisting) {
        if (uncertain) return unreadable();
        return unavailable(requestedSessionId, `Session ${requestedSessionId} is not live`, "session_not_found", "pi_session_not_found");
      }
      if (owned) return unreadable();
      if (durableRepo && isSafeSessionId(providerSessionId)) {
        const reservation = liveness.reserve(requestedSessionId, {
          session: null,
          metadata: null,
          repo: durableRepo,
          durable: true,
          busy: true,
        }, sessionTtlMs);
        if (!reservation.ok) {
          entry = ((reservation) as {entry: any}).entry;
        } else {
          runState.reservation = reservation;
          runState.session = createPiSessionAdapter(await durableRepo.create(
            { id: providerSessionId, cwd: cwd || process.cwd(), ...(access ? {
              hostAuthority: access.hostAuthority, assertOwned: () => assertNativeSessionAccess(access, "create", durableRepo.root),
            } : {}) },
            waitContext,
          ));
          runState.createdOnMiss = true;
        }
      } else {
        return unavailable(requestedSessionId, `Session ${requestedSessionId} is not live`, "session_not_found", "pi_session_not_found");
      }
    }
    if (entry && !runState.createdOnMiss) {
      const claimed = entry.recoveryPending ? { ok: ((false) as const), reason: "busy" } : liveness.claim(requestedSessionId);
      if (!claimed.ok) {
        const missing = ((claimed) as {reason: string}).reason === "missing";
        return unavailable(requestedSessionId, missing ? `Session ${requestedSessionId} is not live` : `Session ${requestedSessionId} is busy with another turn`,
          missing ? "session_not_found" : "session_busy", missing ? "pi_session_not_found" : "pi_session_busy");
      }
      runState.sessionEntry = claimed.entry;
      delete claimed.entry.recovery;
      try {
        if (access) {
          if (claimed.entry.repo !== durableRepo || !claimed.entry.durable) throw Object.assign(new Error("Invalid protected native session authority"), { code: "ERR_NATIVE_SESSION_AUTHORITY" });
          await assertNativeSessionAccess(access, "open", durableRepo.root);
        }
        const raw = await claimed.entry.repo.open(claimed.entry.metadata, {
          ...(access ? { repair: false, wait: false } : {}), signal: waitSignal,
          validateHeader: (header: any) => assertNativeSessionHeader(access, header),
        });
        try {
          assertNativeSessionHeader(access, raw.metadata);
          if (access) await assertNativeProjectionBinding(raw, projection);
        } catch (error) { await raw.close(); throw error; }
        runState.session = createPiSessionAdapter(raw);
        // Import publishes a new versioned pathname; the registry must sync and
        // retire that file, never the archived legacy pathname.
        claimed.entry.metadata = raw.metadata;
        if (raw.continuity === "clean_break") runState.createdOnMiss = true;
      } catch (error) {
        liveness.release(requestedSessionId);
        runState.sessionEntry = null;
        // Journal damage found by the validating open (the presence probe reads
        // only the header) is the same typed, evidence-preserving refusal.
        if (claimed.entry.durable && isJournalCorruption(error)) return unreadable();
        throw error;
      }
    }
  } else {
    if (keepAlive !== true) runState.ephemeralSessionRepo = new MemorySessionRepo();
    runState.session = createPiSessionAdapter(await (runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo)
      .create({ id: providerSessionId, cwd: cwd || process.cwd() }, waitContext));
  }
  return { status: (("ready") as const) };
}

/**
 * Drop an uncommitted fresh session (and any create-on-miss reservation) on the
 * pre-request abort path. A resumed (user-owned) session is NEVER deleted
 * (guarded `session && !sessionEntry`).
 */
/** Detach opted-in state without rewind/deletion, even after poison or cancellation. */
async function preserveNativeTurnEvidence(runState: any): Promise<void> {
  try { await runState.session?.close(); }
  catch (error) { throw isJournalStorageError(error) ? error : new JournalStorageError(error); }
  finally {
    runState.reservation?.release();
    const id = runState.session?.metadata?.id;
    if (id) nativeSessions.delete(id);
  }
}

export async function discardUncommittedSession(runState: any, { durableRepo }: { durableRepo: any; }): Promise<{
    status: "settled";
}> {
  if (runState.preserveTurnEvidence) { await preserveNativeTurnEvidence(runState); return { status: "settled" }; }
  if (runState.session && !runState.sessionEntry) {
    await closeAndDeleteSession(
      runState.session,
      runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo,
    );
  }
  if (runState.reservation) runState.reservation.release();
  return { status: "settled" };
}

/**
 * Session lifecycle commit: keep-alive registration, resumed-turn rollback, or
 * fresh/non-keep-alive drop. The harness already durably persisted the
 * transcript; this tracks LIVENESS so disposeProviderSession / idle-TTL
 * eviction can reach native sessions, and rolls a failed/aborted resumed turn
 * back to its pre-turn leaf.
 */
export async function commitSession(runState: NativeSessionState, {
  keepAlive,
  requestedSessionId,
  providerSessionId,
  durableRepo,
  sessionTtlMs,
  externalAbort,
  failed,
}: { requestedSessionId: string | null; providerSessionId: string; durableRepo: any; sessionTtlMs?: number; keepAlive?: boolean; externalAbort?: boolean; failed?: boolean; }): Promise<{
    status: "settled";
    persistFailure: null | {
        code: string | null;
        message: string;
    };
}> {
  let persistFailure: any = null;
  const { session, sessionEntry, baselineLeafId, reservation } = runState;
  if (runState.preserveTurnEvidence) { await preserveNativeTurnEvidence(runState); return { status: "settled", persistFailure }; }
  if (keepAlive === true && ((!externalAbort && !failed) || runState.retainRecoveryTail)) {
    try {
      if (sessionEntry) {
        // Resumed run: the harness appended this run's turns onto the live
        // session; just re-arm the idle window.
        nativeSessions.touch(requestedSessionId, { idleTimeoutMs: sessionTtlMs! });
        // Surface a write failure the harness swallowed: a session that can
        // no longer persist must not pretend to be resumable.
        await session.buildContext();
      } else {
        const metadata = await session.getMetadata();
        const entry = {
          metadata,
          repo: durableRepo || nativeSessionRepo,
          durable: !!durableRepo,
          busy: true,
        };
        // A create-on-miss reservation is overwritten by its commit (same id);
        // a plain fresh keep-alive run registers directly.
        if (reservation) reservation.commit(entry);
        else nativeSessions.set(providerSessionId, entry, { idleTimeoutMs: sessionTtlMs! });
        runState.registeredSessionEntry = entry;
      }
      const retained = runState.sessionEntry || runState.registeredSessionEntry;
      if (runState.retainRecoveryTail && retained) retained.recoveryPending = !!externalAbort || !!failed;
    } catch (err) {
      // Session persistence must never fail the run; drop the (now
      // inconsistent) session instead of resuming from a broken transcript.
      persistFailure = { code: typeof (err as { code?: string; message?: string; sessionId?: string })?.code === "string" ? (err as { code?: string; message?: string; sessionId?: string }).code : null, message: (err as { code?: string; message?: string; sessionId?: string })?.message || String(err) };
      nativeSessions.delete(providerSessionId);
      if (requestedSessionId) nativeSessions.delete(requestedSessionId);
      const broken = sessionEntry;
      if (broken) {
        await closeAndDeleteSession(session, broken.repo, broken.metadata);
      }
    }
  } else if (sessionEntry) {
    if ((runState.hasBaselineLeaf || baselineLeafId) && (failed || externalAbort)) {
      try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
    }
    nativeSessions.touch(requestedSessionId, { idleTimeoutMs: sessionTtlMs! });
  } else {
    if (reservation) reservation.release();
    await closeAndDeleteSession(session, runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo);
  }
  return { status: "settled", persistFailure };
}

/**
 * Final abort guard (durable cancel TOCTOU) rollback actions: a resumed session
 * moves to its baseline leaf and drops its live entry; a fresh durable session
 * deletes its jsonl. The orchestrator keeps the abort re-check + return inline
 * so no await sits between the re-check and the return (I10); this only runs the
 * rollback body when the guard fires.
 */
export async function rollbackAbortedTurn(runState: any, { requestedSessionId, providerSessionId, durableRepo }: { requestedSessionId: any; providerSessionId: any; durableRepo: any; }): Promise<{
    status: "settled";
}> {
  if (runState.preserveTurnEvidence) { await preserveNativeTurnEvidence(runState); return { status: "settled" }; }
  const { session, sessionEntry, baselineLeafId } = runState;
  if (sessionEntry) {
    if (runState.hasBaselineLeaf || baselineLeafId) {
      try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
    }
    nativeSessions.delete(requestedSessionId);
  } else {
    // A stateless call never registered this id; it may belong to the primary.
    if (!runState.ephemeralSessionRepo) nativeSessions.delete(providerSessionId);
    await closeAndDeleteSession(session, runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo);
  }
  return { status: "settled" };
}

/**
 * Outer-catch session cleanup: drop a just-created fresh durable session, drop a
 * create-on-miss reservation placeholder, and roll a resumed session back to its
 * pre-turn leaf for host/runtime-side throws that landed after the harness
 * already mutated the live session. Resumed handles are always closed here so
 * setup failures before a harness is returned cannot leave the repo wedged.
 */
export async function cleanupSessionOnThrow(runState: any, { durableRepo }: { durableRepo: any; }): Promise<{
    status: "settled";
}> {
  if (runState.preserveTurnEvidence) { await preserveNativeTurnEvidence(runState); return { status: "settled" }; }
  const { session, sessionEntry, reservation, baselineLeafId } = runState;
  if (session && !sessionEntry) {
    await closeAndDeleteSession(session, runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo);
  }
  if (reservation && !sessionEntry) reservation.release();
  if (sessionEntry && session) {
    if (runState.hasBaselineLeaf || baselineLeafId) {
      try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
    }
    try { await session.close(); } catch { /* best-effort */ }
  }
  return { status: "settled" };
}

/**
 * Capture only after close; pending entries cannot be driven by another turn.
 */
export async function captureSessionRecovery(runState: NativeSessionState, { identity, model, pending, abortSignal }: { identity: { runId: string; revision: number; providerSessionId: string; modelKey: string; }; model: any; pending: boolean; abortSignal?: AbortSignal; }): Promise<{
    status: "not_durable";
} | {
    status: "captured";
    receipt: {
        runId: string;
        revision: number;
        providerSessionId: string;
        modelKey: string;
        tipId: string;
    };
}> {
  const entry = runState.sessionEntry || runState.registeredSessionEntry;
  if (!entry?.durable) return { status: "not_durable" };
  try {
    if (!Array.isArray(runState.recoveryInputIds)) throw new Error("Session recovery input identities are unavailable");
    const tipId = await runState.session.getLeafId();
    if (typeof tipId !== "string" || !tipId) throw new Error("Session recovery tip is unavailable");
    const ancestry = createHash("sha256").update(JSON.stringify(await runState.session.getEntries())).digest("hex");
    await runState.session.close();
    const receipt = { ...identity, tipId };
    entry.recovery = { receipt: { ...receipt }, model: { ...model, input: [...model.input] }, ancestry, operationId: runState.recoveryOperationId, baselineTipId: runState.recoveryBaselineTipId, inputIds: runState.recoveryInputIds };
    entry.recoveryPending = pending || !!abortSignal?.aborted;
    return { status: "captured", receipt };
  } catch (error) {
    entry.recoveryPending = false;
    delete entry.recovery;
    throw error;
  }
}

/** Read-only settlement: never drive an operation or append host-authored prose. */
export async function recoverDurableNativeSession(receipt: any, context: any): Promise<boolean> {
  const entry = nativeSessions.get(receipt?.providerSessionId);
  const proof = entry?.recovery;
  if (!entry?.durable || entry.busy || !proof
    || !["runId", "revision", "providerSessionId", "modelKey", "tipId"].every((key: string) => receipt[key] === proof.receipt[key])
    || !Array.isArray(context?.appliedInputIds)
    || proof.inputIds.some((id: any) => typeof id !== "string")
    || JSON.stringify([...proof.inputIds].sort()) !== JSON.stringify([...context.appliedInputIds].sort())) return false;
  entry.busy = true;
  let raw: any;
  try {
    const metadata = await entry.repo.find(receipt.providerSessionId, ENGINE_CONTEXT);
    if (!metadata || metadata.path !== entry.metadata.path) return false;
    raw = await entry.repo.open(metadata, { validateHeader: (header: any) => assertNativeSessionHeader(undefined, header) });
    if (await raw.getLeafId() !== receipt.tipId) return false;
    const terminal = await raw.getTerminal(proof.operationId);
    if ([...raw.validator.inputs.values()].some((input: any) => input.state === "queued")) return false;
    if ((await raw.getOpenTurns()).length !== 0
      || terminal?.kind !== "operation_end"
      || terminal.config?.model.provider !== proof.model.provider || terminal.config?.model.id !== proof.model.id
      || !["completed", "failed", "aborted"].includes(terminal.status) || terminal.tipId !== receipt.tipId
      || terminal.fromTipId !== proof.baselineTipId) return false;
    const turn = await raw.getTurn(terminal.turnId);
    if (turn?.turnId !== receipt.runId || turn.payload.finalOperationId !== proof.operationId
      || !["completed", "failed", "aborted"].includes(turn.payload.status)) return false;
    const { entries } = await inspectCurrentEvidence(raw);
    if (createHash("sha256").update(JSON.stringify(entries)).digest("hex") !== proof.ancestry) return false;
    const baseline = proof.baselineTipId === null ? -1 : entries.findIndex((item: any) => item.id === proof.baselineTipId);
    if (proof.baselineTipId !== null && baseline < 0) return false;
    const tail = entries.slice(baseline + 1);
    if (tail[0]?.type !== "message" || tail[0].message.role !== "user"
      || tail.filter((item: any) => item.type === "message" && item.message.role === "user").length !== 1 + proof.inputIds.length) return false;
    if (!validRecoveryProjection(projectContext(entries).messages, proof.model)) return false;
    await raw.sync();
    await raw.close(ENGINE_CONTEXT);
    raw = undefined;
    // Pending is cleared only after persistence is certain. Bypass the ordinary
    // sync guard while keeping the public busy reservation throughout the fsync.
    entry.recoveryPending = false;
    delete entry.recovery;
    return true;
  } catch {
    return false;
  } finally {
    try { await raw?.close(ENGINE_CONTEXT); } catch { /* already failed closed */ }
    entry.busy = false;
  }
}

/** Storage-only P2 seam: match while holding nonblocking native ownership, then repair.
 * Intentional guarded-open exception: the held canonical host owns this exact
 * reconciliation descriptor/fence. Match before repair; never dispatch or create.
 * Runtime current-handle/projection authority is not required to inspect a prior
 * interrupted epoch for P2 settlement. */
export async function reconcileNativeSessionTurn(request: any): Promise<any> {
  validateSessionTurn(request?.descriptor, request?.descriptor?.handleId);
  if (!request.descriptor.reconciliation || typeof request.sessionsRoot !== "string" || !request.sessionsRoot.trim()
    || request.purpose !== request.descriptor.reconciliation.purpose) throw new TypeError("Invalid native turn reconciliation request");
  const id = request.descriptor.handleId;
  if (nativeSessions.get(id)?.busy || nativeSessions.get(id)?.recoveryPending) throw Object.assign(new Error("Native turn ownership is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
  await nativeSessions.refresh(id);
  const repo = resolveDurableNativeSessionRepo(request.sessionsRoot);
  let raw: any;
  try {
    const metadata = await repo.find(id);
    // A legacy source predates turn evidence; it is imported only when the runtime opens it.
    if (!metadata || metadata.legacy) return { status: "absent" };
    raw = await repo.open(metadata, { repair: false, wait: false });
    const initial = await readTurnEvidence(raw, request.descriptor.turnId);
    const match = matchTurnEvidence(initial, request);
    if (match.status !== "matched") return match;
    if (raw.validator.openTurns.size && !raw.validator.openTurns.has(request.descriptor.turnId)) return { status: "mismatch", reason: "active_turn" };
    if (inspectCurrentLifecycle(raw).turns.some((turn: any) => turn.start.seq > raw.validator.turns.get(request.descriptor.turnId).start.seq
      && (turn.start.payload.binding || turn.operations.length))) return { status: "mismatch", reason: "turn_advanced" };
    if (initial.tipId !== initial.currentTipId) return { status: "mismatch", reason: "tip" };
    await raw.prepareReconciliation();
    await repairInterruptedSession(raw);
    const evidence = await readTurnEvidence(raw, request.descriptor.turnId);
    const outcome = evidence.seal?.outcome ?? "interrupted";
    return { ...evidence, status: "matched", outcome,
      ...(outcome === "completed" && request.purpose === "execution" && evidence.seal?.result ? { commitCandidate: evidence.seal.result } : {}) };
  } catch (error) {
    if (error instanceof SyntaxError) Object.assign(error, { code: "ERR_HARNESS_JOURNAL_CORRUPT" });
    else if (!(error as { code?: string; message?: string; sessionId?: string }).code) (error as { code?: string; message?: string; sessionId?: string }).code = "ERR_HARNESS_RECONCILIATION_UNCERTAIN";
    throw error;
  } finally { if (raw) await raw.close(); }
}

export { nativeSessions as nativeSessionRegistry };

export type NativeSessionState = {
    session?: any;
    sessionEntry?: any;
    registeredSessionEntry?: any;
    reservation?: any;
    ephemeralSessionRepo?: any;
    createdOnMiss?: boolean;
    baselineLeafId?: string | null;
    hasBaselineLeaf?: boolean;
    preserveTurnEvidence?: boolean;
    retainRecoveryTail?: boolean;
    recoveryInputIds?: string[];
    recoveryOperationId?: string;
    recoveryBaselineTipId?: string | null;
};
