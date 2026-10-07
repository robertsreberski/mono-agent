// @ts-check
import { JsonlSessionRepo, projectInheritedContext, evidenceDigest } from "@mono-agent/harness";

import { normalizeDurableSessionsRoot } from "./sessions-root.js";

const failure = () => Object.assign(new Error("Invalid protected native session authority"), { code: "ERR_NATIVE_SESSION_AUTHORITY" });
/** Host-only opt-in. The callback proves current canonical handle, ready artifact
 * and held conversation ownership; catalogue presence is never that proof.
 * @param {any} options @param {string} handleId @param {string|null} requestedId
 */
export function validateNativeSessionAuthority(options, handleId, requestedId) {
  const access = options.nativeSessionAuthority;
  if (access === undefined) {
    if (options.nativeSessionProjection !== undefined) throw failure();
    return;
  }
  if (access.version !== 1 || access.currentHandleId !== handleId || requestedId !== handleId
    || typeof access.assertCurrent !== "function" || !options.piSessionsRoot
    || typeof access.sessionsRoot !== "string" || !normalizeDurableSessionsRoot(access.sessionsRoot) || normalizeDurableSessionsRoot(access.sessionsRoot) !== normalizeDurableSessionsRoot(options.piSessionsRoot)
    || options.sessionKeepAlive !== true
    || options.sessionTurn?.kind !== "host" || !options.sessionTurn.reconciliation || options.sessionTurn.handleId !== handleId
    || options.sessionTurn.ownerKey !== access.hostAuthority?.ownerKey
    || options.sessionTurn.historyBucket !== access.hostAuthority?.historyBucket) throw failure();
  try {
    JsonlSessionRepo.guardedEpochPlan({ id: handleId, timestamp: 0, hostAuthority: access.hostAuthority });
    const projection = options.nativeSessionProjection;
    if (projection !== undefined) {
      if ((options.manualCompaction && projection.dispatchBudget) || projection.version !== 1 || !/^[a-f0-9]{64}$/.test(projection.artifact?.id)
        || !/^[a-f0-9]{64}$/.test(projection.artifact?.hash)) throw failure();
      projectInheritedContext([], projection.inherited);
    }
  } catch { throw failure(); }
}
/** @param {any} access @param {string} action */
export async function assertNativeSessionAccess(access, action, sessionsRoot) {
  if (access === undefined) return;
  try {
    const root = normalizeDurableSessionsRoot(sessionsRoot);
    if (!root || root !== normalizeDurableSessionsRoot(access.sessionsRoot)) throw failure();
    await access.assertCurrent({ handleId: access.currentHandleId, action, sessionsRoot: root });
  }
  catch (cause) { throw Object.assign(failure(), { cause }); }
}
/** Must precede an open that could repair bytes. @param {any} access @param {any} metadata */
export function assertNativeSessionHeader(access, metadata) {
  if (access === undefined && metadata.ownershipSchemaVersion !== 2) return;
  if (access === undefined) throw failure();
  if (metadata.ownershipSchemaVersion !== 2 || ["version", "canonicalVersion", "rootId", "authorityId", "ownerKey", "historyBucket"]
    .some((key) => metadata.hostAuthority?.[key] !== access.hostAuthority[key])) throw failure();
}

/** Pin the first accepted projection until a composed checkpoint subsumes it.
 * Header/claim validation happens first; this check precedes repair and new turns.
 * @param {any} raw @param {any} projection
 */
export async function assertNativeProjectionBinding(raw, projection) {
  const binding = raw.validator.projectionBinding;
  if (!binding) return;
  try {
    const entries = await raw.getEntries();
    const checkpoint = entries.filter((entry) => entry.type === "compaction").at(-1)?.checkpoint;
    if (checkpoint?.inheritedCoverage) {
      if (projection) projectInheritedContext(entries, projection.inherited);
      return;
    }
    if (!projection || projection.artifact.id !== binding.artifact.id || projection.artifact.hash !== binding.artifact.hash
      || evidenceDigest(projection.inherited.coverage) !== evidenceDigest(binding.coverage)
      || evidenceDigest(projection.inherited.messages) !== binding.messageDigest) throw failure();
  } catch (cause) { throw Object.assign(failure(), { cause }); }
}
