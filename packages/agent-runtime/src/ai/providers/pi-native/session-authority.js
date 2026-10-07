// @ts-check
import { JsonlSessionRepo, projectInheritedContext } from "@mono-agent/harness";

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
    || typeof access.assertCurrent !== "function" || !options.piSessionsRoot || options.sessionKeepAlive !== true
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
export async function assertNativeSessionAccess(access, action) {
  if (access === undefined) return;
  try { await access.assertCurrent({ handleId: access.currentHandleId, action }); }
  catch (cause) { throw Object.assign(failure(), { cause }); }
}
/** Must precede an open that could repair bytes. @param {any} access @param {any} metadata */
export function assertNativeSessionHeader(access, metadata) {
  if (access === undefined && metadata.ownershipSchemaVersion !== 2) return;
  if (access === undefined) throw failure();
  if (metadata.ownershipSchemaVersion !== 2 || ["version", "canonicalVersion", "rootId", "authorityId", "ownerKey", "historyBucket"]
    .some((key) => metadata.hostAuthority?.[key] !== access.hostAuthority[key])) throw failure();
}
