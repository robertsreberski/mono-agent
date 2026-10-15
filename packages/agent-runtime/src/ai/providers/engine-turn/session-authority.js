// @ts-check
import { JsonlSessionRepo, projectInheritedContext } from "@mono-agent/engine";

import { normalizeDurableSessionsRoot } from "@mono-agent/engine/sessions.js";

const onlyKeys = (value, allowed) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.includes(key));
const coverageId = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
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
    || typeof access.assertCurrent !== "function" || !options.sessionsRoot
    || typeof access.sessionsRoot !== "string" || !normalizeDurableSessionsRoot(access.sessionsRoot) || normalizeDurableSessionsRoot(access.sessionsRoot) !== normalizeDurableSessionsRoot(options.sessionsRoot)
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
      const coverage = projection.inherited.coverage;
      if (!onlyKeys(projection.artifact, ["id", "hash"]) || !onlyKeys(coverage, ["version", "sources"])
        || coverage.sources.some((source) => !onlyKeys(source, ["journalId", "sourceTipId", "sourceSeq", "sourceDigest"])
          || !coverageId(source.journalId) || source.sourceTipId !== null && !coverageId(source.sourceTipId))) throw failure();
    }
  } catch { throw failure(); }
}
export { assertNativeSessionAccess } from "@mono-agent/engine/sessions.js";
