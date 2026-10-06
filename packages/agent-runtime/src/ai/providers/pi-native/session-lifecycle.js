import { inspectCurrentEvidence, inspectCurrentLifecycle } from "@mono-agent/harness";
// @ts-check
// Session lifecycle for the pi-native bridge.
//
// Pure moves out of pi-native.js: the durable-repo resolve/reopen, the safe-id
// gate (R4), the resume / create-on-miss / claim flow (I1/I2/I3/I4/I5, R8/F4),
// the keep-alive commit + rollback + drop paths, and sessionUnavailableResult.
// The process-level session storage (the registry + repos) legitimately stays
// module-level here (it must persist across runs); per-RUN state lives on the
// caller-owned runState. Concurrency claims go through the synchronous
// createSessionLiveness primitives so the await-free spans are enforced by
// construction rather than by inline sequencing.

import { JsonlSessionRepo, MemorySessionRepo } from "@mono-agent/harness/session-store.js";
import { JournalStorageError, isJournalStorageError } from "@mono-agent/harness";
import { validRecoveryProjection } from "./terminal-recovery.js";
import { createHash } from "node:crypto";
import { access, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createSessionRegistry } from "../../runtime/sessions.js";
import { createSessionLiveness } from "../../runtime/session-liveness.js";
import { projectContext, createPiSessionAdapter, HARNESS_CONTEXT } from "./harness-adapter.js";

async function syncPath(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDurableTranscript(entry) {
  if (entry.recoveryPending) throw new Error("Pi terminal recovery is pending");
  if (!entry.durable) return;
  const path = entry.metadata?.path;
  if (typeof path !== "string" || !path) {
    throw new Error("Durable Pi session metadata is missing its JSONL path");
  }
  // The harness owns a pinned descriptor and writer lock across this barrier.
  // Fsync both the journal and its complete publication-directory chain.
  await entry.repo.sync(entry.metadata);
}

async function invalidateNativeSession(entry) {
  if (entry.durable) {
    const path = entry.metadata?.path;
    if (typeof path !== "string" || !path) {
      throw new Error("Durable Pi session metadata is missing its JSONL path");
    }
    // Explicit invalidation is idempotent. A preceding failed sync may have
    // observed that the transcript was already removed outside this process.
    try {
      await access(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
  await entry.repo.delete(entry.metadata, HARNESS_CONTEXT);
  if (entry.durable) {
    const path = entry.metadata.path;
    // Make the unlink durable before the registry forgets the busy marker.
    await syncPath(dirname(path));
  }
}

/**
 * Release a Pi session handle and remove its repository record as independent
 * best-effort operations. A close failure must not prevent deletion of a fresh
 * or otherwise poisoned transcript.
 * @param {any} session
 * @param {any} repo
 * @param {any} [knownMetadata]
 */
async function closeAndDeleteSession(session, repo, knownMetadata) {
  let metadata = knownMetadata;
  if (!metadata) {
    try { metadata = await session.getMetadata(); } catch { /* best-effort */ }
  }
  try { await session.close(); } catch { /* best-effort */ }
  if (metadata) {
    try { await repo.delete(metadata, HARNESS_CONTEXT); } catch { /* best-effort */ }
  }
}

// Live pi-native sessions, keyed by provider session id. Entries are
// { metadata, repo, durable, busy }. Pi 0.85 sessions are closed after every
// turn so their repository record can be reopened safely; the registry owns
// only liveness and metadata. In-memory transcripts are freed when the registry
// evicts them; durable (jsonl) transcripts survive eviction. Registering here gives
// runtime.disposeSession / disposeProviderSession + idle-TTL eviction the same
// reach over native pi sessions that the legacy bridge had.
const nativeSessionRepo = new MemorySessionRepo();
const nativeSessions = createSessionRegistry({
  isBusy: (entry) => entry.busy === true || entry.recoveryPending === true,
  onSync: syncDurableTranscript,
  onEvict: async (entry, reason) => {
    // Ordinary disposal/TTL only drops registry metadata so durable sessions
    // can reopen later. Explicit invalidation means the host rejected the
    // turn before canonical history commit; that poisoned transcript must be
    // deleted too or it could silently reappear on the next stable-id resume.
    if (reason === "invalidated") {
      // Destructive invalidation is an honest API: deletion (and, for JSONL,
      // parent-directory fsync) must finish before registry removal, and any
      // failure must reach the caller so it cannot assume cleanup succeeded.
      await invalidateNativeSession(entry);
      return;
    }
    if (entry.durable) return;
    await entry.repo.delete(entry.metadata, HARNESS_CONTEXT);
  },
});
const liveness = createSessionLiveness(nativeSessions);

const durableNativeSessionRepos = new Map();
// Cold catalogue lookup happens before registry adoption/reservation. Track the
// whole await window so preserving detach cannot claim that handle is idle.
const coldOpenCounts = new Map();

export function resolveDurableNativeSessionRepo(piSessionsRoot) {
  if (typeof piSessionsRoot !== "string" || !piSessionsRoot.trim()) return null;
  const root = piSessionsRoot.trim();
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
 * Retire every currently materialized durable Pi transcript with this exact
 * logical id. This is intentionally stronger than live-session invalidation:
 * history rotation and retention can retire an epoch after its registry entry
 * was already evicted or after a process restart. Active writers reject late
 * append admission and retain kernel ownership until close. The
 * canonical epoch has already rotated, so that old id is never resumable in the
 * interim. Absence is success; cleanup or verification uncertainty rejects.
 */
export async function retireDurableNativeSession(providerSessionId, piSessionsRoot, deletionOptions = undefined) {
  if (!isSafeSessionId(providerSessionId)) {
    throw new TypeError("providerSessionId must be a safe, non-empty session id");
  }
  if (typeof piSessionsRoot !== "string" || !piSessionsRoot.trim()) {
    throw new TypeError("piSessionsRoot must be a non-empty path");
  }

  // First guarantee this process cannot resume through a stale registry entry.
  // A cancellation can rotate canonical history while a provider unwinds. The
  // repository marks a local writer retired, drains storage I/O and removes
  // evidence under its already-held lock; late append admission fails closed.
  await nativeSessions.refresh(providerSessionId);
  const repo = resolveDurableNativeSessionRepo(piSessionsRoot);
  if (!repo) throw new Error("Durable Pi session repository is unavailable");
  if (deletionOptions === undefined) await repo.retireByHandle(providerSessionId);
  else await repo.retireByHandle(providerSessionId, deletionOptions);
}

/** Preserving detach, separate from destructive retirement. Reject a busy or
 * unresolved handle; the host must settle it first. Durable bytes are untouched.
 * This does not establish cross-process canonical retirement authority.
 */
export async function detachDurableNativeSession(providerSessionId, piSessionsRoot) {
  if (!isSafeSessionId(providerSessionId) || typeof piSessionsRoot !== "string" || !piSessionsRoot.trim()) throw new TypeError("Invalid durable detach identity");
  const entry = nativeSessions.get(providerSessionId);
  if (coldOpenCounts.has(providerSessionId) || entry?.busy || entry?.recoveryPending) throw Object.assign(new Error("Native turn must be settled before detach"), { code: "ERR_HARNESS_WRITER_BUSY" });
  if (entry && (!entry.durable || entry.repo !== resolveDurableNativeSessionRepo(piSessionsRoot))) throw new TypeError("Native detach owner mismatch");
  // Sessions are closed after each idle turn. Removal deliberately bypasses
  // onEvict: invalidation deletes, while ordinary disposal syncs unnecessarily.
  if (entry && !nativeSessions.delete(providerSessionId)) throw new Error("Native detach unavailable");
  return { status: "detached", evidence: "preserved" };
}

// Defense in depth (R4): create-on-miss passes the caller-controlled session id
// straight to durableRepo.create({ id }), and JsonlSessionRepo writes
// `<journalId>.jsonl` — so an id like "../../../../tmp/pwn" would escape
// piSessionsRoot and name a file anywhere on disk. The harness-derived id is a
// sha256 hex (always safe), but the public runtime API is caller-controlled.
// Only an id that is a single safe filename component may CREATE a session;
// anything else falls through to the existing session_not_found fast-fail, so a
// malicious id can never name a file. (A genuinely on-disk session reopened by
// reopenDurableNativeSession is matched by `.id`, never used to build a path, so
// this gate is confined to the create path.)
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeSessionId(id) {
  return typeof id === "string"
    && SAFE_SESSION_ID.test(id)
    && !id.includes("..")
    && !id.includes("/")
    && !id.includes("\\");
}

async function reopenDurableNativeSession(repo, sessionId) {
  try {
    const metadata = (await repo.list(undefined, HARNESS_CONTEXT)).find((entry) => entry?.id === sessionId);
    if (!metadata) return null;
    return { metadata, repo, durable: true, busy: false };
  } catch {
    return null;
  }
}

function sessionUnavailableResult({
  resolved,
  options,
  events,
  runtimeWarnings,
  start,
  sessionId,
  errorMessage,
  failureKind,
  piErrorCode,
  piTransport,
}) {
  return {
    text: null,
    events,
    usage: {},
    durationMs: Date.now() - start,
    numTurns: 0,
    model: resolved?.reference || (resolved?.provider && resolved?.model ? `${resolved.provider}:${resolved.model}` : null),
    effort: options.effort || null,
    sdk: "pi",
    cancelled: false,
    error: errorMessage,
    failureKind,
    providerSessionId: sessionId,
    runtimeWarnings,
    diagnostics: {
      provider_session_id: sessionId,
      pi_error_code: piErrorCode,
      pi_engine: "native",
      pi_transport_requested: piTransport,
    },
  };
}

/**
 * Resolve the session for this run: warm registry hit, durable cold reopen,
 * create-on-miss (durable resume only), or fresh create. Mutates runState
 * (session / sessionEntry / createdOnMiss / reservation). Returns
 * `{ done: true, result }` for a fast-fail early return (session_not_found /
 * session_busy), else `{ done: false }` to proceed.
 * @param {any} runState
 * @param {any} params
 * @returns {Promise<{done: true, result: any} | {done: false}>}
 */
export async function resolveSession(runState, {
  requestedSessionId,
  providerSessionId,
  durableRepo,
  sessionTtlMs,
  cwd,
  resolved,
  options,
  events,
  runtimeWarnings,
  start,
  piTransport,
}) {
  // Resume check first: a session miss must stay cheap (no tool/MCP/harness
  // init). This mirrors the legacy bridge's fail-fast contract.
  if (requestedSessionId) {
    let entry = liveness.adoptIfPresent(requestedSessionId);
    if (!entry && durableRepo) {
      coldOpenCounts.set(requestedSessionId, (coldOpenCounts.get(requestedSessionId) ?? 0) + 1);
      try {
        entry = await reopenDurableNativeSession(durableRepo, requestedSessionId);
        if (entry) {
          // TOCTOU guard: the reopen above is an AWAIT, so a second concurrent
          // cold resume could have reopened+inserted its own entry in this
          // window. Re-read the registry and adopt any entry already present so
          // the busy-claim below collapses back to the warm path's synchronous
          // semantics (the loser sees the winner's shared entry with busy===true
          // and returns session_busy). The discarded reopen is just an in-memory
          // jsonl handle (no subprocess/socket), so dropping it is safe.
          const concurrent = liveness.adoptIfPresent(requestedSessionId);
          if (concurrent) {
            entry = concurrent;
          } else {
            nativeSessions.set(requestedSessionId, entry, { idleTimeoutMs: sessionTtlMs });
          }
        }
      } finally {
        const remaining = coldOpenCounts.get(requestedSessionId) - 1;
        if (remaining) coldOpenCounts.set(requestedSessionId, remaining); else coldOpenCounts.delete(requestedSessionId);
      }
    }
    if (!entry) {
      if (durableRepo && options.sessionTurn?.reconciliation && options.sessionTurn.baseRevision > 0) {
        // P2 canonical revision proves an earlier native turn existed. Missing
        // bytes cannot become an empty warm transcript. Fail before dispatch;
        // the host must establish a cold boundary, never silently lose context.
        return { done: true, result: sessionUnavailableResult({ resolved, options, events, runtimeWarnings, start,
          sessionId: requestedSessionId, errorMessage: `Pi session ${requestedSessionId} is not live`,
          failureKind: "session_not_found", piErrorCode: "pi_session_not_found", piTransport }) };
      }
      if (durableRepo && isSafeSessionId(providerSessionId)) {
        // Create-on-miss (durable resume only): the requested id has no live
        // registry entry AND no JSONL on disk under piSessionsRoot. This is
        // the cross-restart resume case — the harness derives a stable id from
        // the conversationId and passes it before any session exists on a
        // fresh process. Rather than fail with session_not_found (which would
        // make the harness re-send full history into yet another fresh,
        // randomly-named session and orphan future resumes), create a durable
        // session UNDER the requested id so this and every later turn for the
        // conversation resolve to the same on-disk transcript. sessionEntry
        // stays null so this proceeds exactly like a fresh run (prior messages
        // are seeded, the keep-alive success path registers + persists it).
        // The IN-MEMORY resume miss (no durableRepo) — and a create-on-miss
        // with an UNSAFE id (R4) — keep fast-failing below, preserving the
        // existing per-process session_not_found contract.
        //
        // Concurrent-first-turn race (R8): two concurrent first turns for the
        // same durable id would BOTH miss here and BOTH create, producing two
        // transcripts for one logical id (JsonlSessionRepo names files by
        // `${createdAt}_${id}`, so there is no fs-level dedup). Mirror the
        // cold-reopen-race defense: synchronously (NO await) re-check the
        // registry, then reserve the id with a BUSY placeholder before the
        // create await. The get→check→set span MUST stay await-free, so the
        // loser observes the busy placeholder and returns session_busy via the
        // same busy-claim path below — exactly one create per durable id.
        const reservation = liveness.reserve(requestedSessionId, {
          session: null,
          metadata: null,
          repo: durableRepo,
          durable: true,
          busy: true,
        }, sessionTtlMs);
        if (!reservation.ok) {
          // A concurrent caller already reserved/created this id in the window
          // since the miss above. Adopt its entry and fall into the busy-claim
          // logic (session_busy if its turn is in flight, else resume). Cast:
          // @ts-check does not narrow the ReserveResult typedef union on
          // `!reservation.ok`, though the loser branch always carries `entry`.
          entry = /** @type {{entry: any}} */ (reservation).entry;
        } else {
          // Reserved the id with a busy placeholder BEFORE the create await so a
          // second concurrent first turn observes busy and returns session_busy.
          // The keep-alive success path overwrites this placeholder with an
          // entry that remains busy until its harness closes; drop/abort/catch
          // paths release it. Keyed by requestedSessionId === providerSessionId.
          runState.reservation = reservation;
          runState.session = createPiSessionAdapter(await durableRepo.create(
            { id: providerSessionId, cwd: cwd || process.cwd() },
            HARNESS_CONTEXT,
          ));
          runState.createdOnMiss = true;
        }
      } else {
        return {
          done: true,
          result: sessionUnavailableResult({
            resolved,
            options,
            events,
            runtimeWarnings,
            start,
            sessionId: requestedSessionId,
            errorMessage: `Pi session ${requestedSessionId} is not live`,
            failureKind: "session_not_found",
            piErrorCode: "pi_session_not_found",
            piTransport,
          }),
        };
      }
    }
    if (entry && !runState.createdOnMiss) {
      // The busy claim MUST stay await-free between the registry adoption
      // above and `entry.busy = true` inside claim(): adopt/reserve/set + this
      // claim are all synchronous, which is what makes the cold-resume race
      // (F4) safe. Do not introduce any await in this span or the TOCTOU window
      // reopens. `claim` re-reads the same registry entry and sets busy in one
      // await-free step; a busy entry loses and returns session_busy.
      const claimed = entry.recoveryPending ? { ok: /** @type {const} */ (false), reason: "busy" } : liveness.claim(requestedSessionId);
      if (!claimed.ok) {
        // claim() can lose two ways: "busy" (the entry adopted above is
        // mid-turn) or "missing" (no live entry). "missing" is UNREACHABLE on
        // this path today — the entry was adopted/reserved synchronously in the
        // await-free span just above, so it is always present here — but branch
        // on it anyway so a future refactor that could drop the entry in this
        // window self-defends with session_not_found instead of a misleading
        // "busy" message. The busy branch is byte-identical to before. Cast:
        // @ts-check does not narrow the ClaimResult union on `!claimed.ok`,
        // though the loser branch always carries `reason`.
        const missing = /** @type {{reason: string}} */ (claimed).reason === "missing";
        return {
          done: true,
          result: sessionUnavailableResult({
            resolved,
            options,
            events,
            runtimeWarnings,
            start,
            sessionId: requestedSessionId,
            errorMessage: missing
              ? `Pi session ${requestedSessionId} is not live`
              : `Pi session ${requestedSessionId} is busy with another turn`,
            failureKind: missing ? "session_not_found" : "session_busy",
            piErrorCode: missing ? "pi_session_not_found" : "pi_session_busy",
            piTransport,
          }),
        };
      }
      runState.sessionEntry = claimed.entry;
      delete claimed.entry.recovery;
      try {
        const raw = await claimed.entry.repo.open(claimed.entry.metadata, HARNESS_CONTEXT);
        runState.session = createPiSessionAdapter(raw);
        // Import publishes a new versioned pathname; the registry must sync and
        // retire that file, never the archived legacy pathname.
        claimed.entry.metadata = raw.metadata;
        if (raw.continuity === "clean_break") runState.createdOnMiss = true;
      } catch (error) {
        // The claim made this registry entry busy. An open failure means the
        // entry cannot be driven, so remove its liveness record before
        // propagating; otherwise every later resume retries the same broken
        // entry forever. Preserve the durable transcript for a later cold
        // reopen/recovery attempt.
        liveness.release(requestedSessionId);
        runState.sessionEntry = null;
        throw error;
      }
    }
  } else {
    // Attribution may equal a live primary's id on a stateless retry/backup.
    // A private ephemeral repo prevents both create collisions and cleanup of
    // that primary's transcript. Only keep-alive calls use a shared repository.
    if (options.sessionKeepAlive !== true) runState.ephemeralSessionRepo = new MemorySessionRepo();
    runState.session = createPiSessionAdapter(await (runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo)
      .create({ id: providerSessionId, cwd: cwd || process.cwd() }, HARNESS_CONTEXT));
  }
  return { done: false };
}

/**
 * Drop an uncommitted fresh session (and any create-on-miss reservation) on the
 * pre-request abort path. A resumed (user-owned) session is NEVER deleted
 * (guarded `session && !sessionEntry`).
 * @param {any} runState
 * @param {{durableRepo: any}} params
 */
/** Detach opted-in state without rewind/deletion, even after poison or cancellation. */
export async function preserveNativeTurnEvidence(runState) {
  try { await runState.session?.close(); }
  catch (error) { throw isJournalStorageError(error) ? error : new JournalStorageError(error); }
  finally {
    runState.reservation?.release();
    const id = runState.session?.metadata?.id;
    if (id) nativeSessions.delete(id);
  }
}

export async function discardUncommittedSession(runState, { durableRepo }) {
  if (runState.preserveTurnEvidence) { await preserveNativeTurnEvidence(runState); return; }
  // Drop a freshly-created non-keep-alive session so an aborted-before-run turn
  // does not leave an orphan jsonl on disk. Guarded `session && !sessionEntry`
  // so a resumed (user-owned) session is NEVER deleted. For a resume no
  // transcript was appended yet (prompt never ran), so the live session is
  // already at its pre-turn leaf and needs no rollback.
  if (runState.session && !runState.sessionEntry) {
    await closeAndDeleteSession(
      runState.session,
      runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo,
    );
  }
  // Drop the create-on-miss BUSY reservation too, else the busy placeholder
  // leaks and every future resume of this conversation's stable id returns
  // session_busy forever (busy entries are never idle-evicted).
  if (runState.reservation) runState.reservation.release();
}

/**
 * Session lifecycle commit: keep-alive registration, resumed-turn rollback, or
 * fresh/non-keep-alive drop. The harness already durably persisted the
 * transcript; this tracks LIVENESS so disposeProviderSession / idle-TTL
 * eviction can reach native sessions, and rolls a failed/aborted resumed turn
 * back to its pre-turn leaf.
 * @param {any} runState
 * @param {any} params
 */
export async function commitSession(runState, {
  options,
  requestedSessionId,
  providerSessionId,
  durableRepo,
  sessionTtlMs,
  externalAbort,
  errorMessage,
  onEvent,
}) {
  const { session, sessionEntry, baselineLeafId, reservation } = runState;
  if (runState.preserveTurnEvidence) { await preserveNativeTurnEvidence(runState); return; }
  if (options.sessionKeepAlive === true && ((!externalAbort && !errorMessage) || runState.retainRecoveryTail)) {
    try {
      if (sessionEntry) {
        // Resumed run: the harness appended this run's turns onto the live
        // session; just re-arm the idle window.
        nativeSessions.touch(requestedSessionId, { idleTimeoutMs: sessionTtlMs });
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
        else nativeSessions.set(providerSessionId, entry, { idleTimeoutMs: sessionTtlMs });
        runState.registeredSessionEntry = entry;
      }
      const retained = runState.sessionEntry || runState.registeredSessionEntry;
      if (runState.retainRecoveryTail && retained) retained.recoveryPending = !!externalAbort || !!errorMessage;
    } catch (err) {
      // Session persistence must never fail the run; drop the (now
      // inconsistent) session instead of resuming from a broken transcript.
      onEvent({
        type: "runtime_warning",
        warning_kind: "pi_session_persist_failed",
        message: err?.message || String(err),
      });
      nativeSessions.delete(providerSessionId);
      if (requestedSessionId) nativeSessions.delete(requestedSessionId);
      const broken = sessionEntry;
      if (broken) {
        await closeAndDeleteSession(session, broken.repo, broken.metadata);
      }
    }
  } else if (sessionEntry) {
    // Resumed run that errored (or was aborted): roll the live session back to
    // the leaf captured before this turn so the failed turn never leaks into a
    // later resume. The next resume then sees the last good transcript. The
    // entry stays live (busy is cleared in finally) and its idle TTL re-arms.
    if ((runState.hasBaselineLeaf || baselineLeafId) && (errorMessage || externalAbort)) {
      try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
    }
    nativeSessions.touch(requestedSessionId, { idleTimeoutMs: sessionTtlMs });
  } else {
    // Fresh, non-keep-alive (or failed first) run: never leave a live session
    // behind. A durable jsonl transcript on disk is dropped too, matching the
    // legacy default contract that a non-keep-alive run is not resumable.
    // A create-on-miss BUSY reservation (R8) is released here too so a
    // non-keep-alive / errored / aborted first turn never leaks a busy entry
    // (the success keep-alive path overwrites it with the finalized entry, so
    // it is only this drop branch that must clean it up).
    if (reservation) reservation.release();
    await closeAndDeleteSession(session, runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo);
  }
}

/**
 * Final abort guard (durable cancel TOCTOU) rollback actions: a resumed session
 * moves to its baseline leaf and drops its live entry; a fresh durable session
 * deletes its jsonl. The orchestrator keeps the abort re-check + return inline
 * so no await sits between the re-check and the return (I10); this only runs the
 * rollback body when the guard fires.
 * @param {any} runState
 * @param {{requestedSessionId: string|null, providerSessionId: string, durableRepo: any}} params
 */
export async function rollbackAbortedTurn(runState, { requestedSessionId, providerSessionId, durableRepo }) {
  if (runState.preserveTurnEvidence) { await preserveNativeTurnEvidence(runState); return; }
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
}

/**
 * Outer-catch session cleanup: drop a just-created fresh durable session, drop a
 * create-on-miss reservation placeholder, and roll a resumed session back to its
 * pre-turn leaf for host/runtime-side throws that landed after the harness
 * already mutated the live session. Resumed handles are always closed here so
 * setup failures before a harness is returned cannot leave the repo wedged.
 * @param {any} runState
 * @param {{durableRepo: any}} params
 */
export async function cleanupSessionOnThrow(runState, { durableRepo }) {
  if (runState.preserveTurnEvidence) { await preserveNativeTurnEvidence(runState); return; }
  const { session, sessionEntry, reservation, baselineLeafId } = runState;
  // Drop a just-created FRESH durable session so a setup/run failure does not
  // leave a resumable orphan jsonl on disk (the success path drops it via the
  // fresh-run branch; the catch must mirror that). Guarded: `session &&
  // !sessionEntry` fires only for fresh runs that actually created a session —
  // NEVER for resumes (sessionEntry is non-null only on resume; deleting a
  // resumed user session here would be data loss) and never when the throw
  // preceded session create.
  if (session && !sessionEntry) {
    await closeAndDeleteSession(session, runState.ephemeralSessionRepo || durableRepo || nativeSessionRepo);
  }
  // Drop a create-on-miss BUSY placeholder (R8) left in the registry by a throw
  // during/after the reservation — including a throw inside the create await
  // itself, where `session` is still null so the jsonl-delete above is skipped.
  // Never set on a resume (sessionEntry would be non-null), so this never
  // deletes a live user session.
  if (reservation && !sessionEntry) reservation.release();
  // Resumed-session rollback for host/runtime-side throws (e.g. a throwing
  // custom pricing resolver / bridge event callback) that land here AFTER the
  // harness already mutated the live session. Mirrors the success-path
  // rollback: move the live session back to the pre-turn leaf so the failed
  // turn never leaks into a later resume. Gated on `sessionEntry &&
  // baselineLeafId` so rollback only fires for resumes that captured a baseline.
  // Closing is independently gated on the resumed session existing: a failure
  // may land before the baseline was readable, but that handle must still be
  // released without deleting the user-owned transcript.
  if (sessionEntry && session) {
    if (runState.hasBaselineLeaf || baselineLeafId) {
      try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
    }
    try { await session.close(); } catch { /* best-effort */ }
  }
}

/** Capture only after close; pending entries cannot be driven by another turn. */
export async function captureSessionRecovery(runState, { options, providerSessionId, modelKey, model, pending }) {
  const entry = runState.sessionEntry || runState.registeredSessionEntry;
  if (!entry?.durable) return undefined;
  try {
    if (!Array.isArray(runState.recoveryInputIds)) throw new Error("Pi session recovery input identities are unavailable");
    const tipId = await runState.session.getLeafId();
    if (typeof tipId !== "string" || !tipId) throw new Error("Pi session recovery tip is unavailable");
    const ancestry = createHash("sha256").update(JSON.stringify(await runState.session.getEntries())).digest("hex");
    await runState.session.close();
    const receipt = { runId: options.sessionRecovery.runId, revision: options.sessionRecovery.revision, providerSessionId, modelKey, tipId };
    entry.recovery = { receipt: { ...receipt }, model: { ...model, input: [...model.input] }, ancestry, operationId: runState.recoveryOperationId, baselineTipId: runState.recoveryBaselineTipId, inputIds: runState.recoveryInputIds };
    entry.recoveryPending = pending || !!options.abortSignal?.aborted;
    return receipt;
  } catch (error) {
    // The run's outer catch performs legacy rollback/close or fresh deletion.
    // Release provisional recovery state first so failed capture cannot strand
    // an entry as busy without a receipt that could settle it.
    entry.recoveryPending = false;
    delete entry.recovery;
    throw error;
  }
}

/** Read-only settlement: never drive an operation or append host-authored prose. */
export async function recoverDurableNativeSession(receipt, context) {
  const entry = nativeSessions.get(receipt?.providerSessionId);
  const proof = entry?.recovery;
  if (!entry?.durable || entry.busy || !proof
    || !["runId", "revision", "providerSessionId", "modelKey", "tipId"].every((key) => receipt[key] === proof.receipt[key])
    || !Array.isArray(context?.appliedInputIds)
    || proof.inputIds.some((id) => typeof id !== "string")
    || JSON.stringify([...proof.inputIds].sort()) !== JSON.stringify([...context.appliedInputIds].sort())) return false;
  entry.busy = true;
  let raw;
  try {
    const matches = (await entry.repo.list(undefined, HARNESS_CONTEXT)).filter((record) => record.id === receipt.providerSessionId);
    if (matches.length !== 1 || matches[0].path !== entry.metadata.path) return false;
    raw = await entry.repo.open(matches[0], HARNESS_CONTEXT);
    if (await raw.getLeafId() !== receipt.tipId) return false;
    const terminal = await raw.getTerminal(proof.operationId);
    if ([...raw.validator.inputs.values()].some((input) => input.state === "queued")) return false;
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
    const baseline = proof.baselineTipId === null ? -1 : entries.findIndex((item) => item.id === proof.baselineTipId);
    if (proof.baselineTipId !== null && baseline < 0) return false;
    const tail = entries.slice(baseline + 1);
    if (tail[0]?.type !== "message" || tail[0].message.role !== "user"
      || tail.filter((item) => item.type === "message" && item.message.role === "user").length !== 1 + proof.inputIds.length) return false;
    if (!validRecoveryProjection(projectContext(entries).messages, proof.model)) return false;
    await raw.sync();
    await raw.close(HARNESS_CONTEXT);
    raw = undefined;
    // Pending is cleared only after persistence is certain. Bypass the ordinary
    // sync guard while keeping the public busy reservation throughout the fsync.
    entry.recoveryPending = false;
    delete entry.recovery;
    return true;
  } catch {
    return false;
  } finally {
    try { await raw?.close(HARNESS_CONTEXT); } catch { /* already failed closed */ }
    entry.busy = false;
  }
}

/** Storage-only P2 seam: match while holding nonblocking native ownership, then repair. */
export async function reconcileNativeSessionTurn(request) {
  const { validateSessionTurn, readTurnEvidence, matchTurnEvidence, repairInterruptedSession } = await import("@mono-agent/harness");
  validateSessionTurn(request?.descriptor, request?.descriptor?.handleId);
  if (!request.descriptor.reconciliation || typeof request.sessionsRoot !== "string" || !request.sessionsRoot.trim()
    || request.purpose !== request.descriptor.reconciliation.purpose) throw new TypeError("Invalid native turn reconciliation request");
  const id = request.descriptor.handleId;
  if (nativeSessions.get(id)?.busy || nativeSessions.get(id)?.recoveryPending) throw Object.assign(new Error("Native turn ownership is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
  await nativeSessions.refresh(id);
  const repo = resolveDurableNativeSessionRepo(request.sessionsRoot);
  let raw;
  try {
    const records = await repo.listOwned({ wait: false });
    const metadata = records.find((record) => record.id === id);
    if (!metadata) return { status: "absent" };
    raw = await repo.open(metadata, { repair: false, wait: false });
    const initial = await readTurnEvidence(raw, request.descriptor.turnId);
    const match = matchTurnEvidence(initial, request);
    if (match.status !== "matched") return match;
    if (raw.validator.openTurns.size && !raw.validator.openTurns.has(request.descriptor.turnId)) return { status: "mismatch", reason: "active_turn" };
    if (inspectCurrentLifecycle(raw).turns.some((turn) => turn.start.seq > raw.validator.turns.get(request.descriptor.turnId).start.seq
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
    else if (!error.code) error.code = "ERR_HARNESS_RECONCILIATION_UNCERTAIN";
    throw error;
  } finally { if (raw) await raw.close(); }
}
