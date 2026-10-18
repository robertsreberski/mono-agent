// @ts-check
import { projectInheritedContext } from "./request-projection.js";
import { evidenceDigest } from "./evidence-view.js";
import { normalizeDurableSessionsRoot } from "./sessions-root.js";
const failure = () => Object.assign(new Error("Invalid protected native session authority"), { code: "ERR_NATIVE_SESSION_AUTHORITY" });
export async function assertNativeSessionAccess(access: any, action: string, sessionsRoot: any): Promise<void> {
  if (access === undefined) return;
  try {
    const root = normalizeDurableSessionsRoot(sessionsRoot);
    if (!root || root !== normalizeDurableSessionsRoot(access.sessionsRoot)) throw failure();
    await access.assertCurrent({ handleId: access.currentHandleId, action, sessionsRoot: root });
  }
  catch (cause) { throw Object.assign(failure(), { cause }); }
}
/**
 * Must precede an open that could repair bytes.
 */
export function assertNativeSessionHeader(access: any, metadata: any): void {
  if (access === undefined && metadata.hostAuthority === undefined) return;
  if (access === undefined) throw failure();
  if (metadata.hostAuthority === undefined || ["version", "rootId", "authorityId", "ownerKey", "historyBucket"]
    .some((key: string) => metadata.hostAuthority?.[key] !== access.hostAuthority[key])) throw failure();
}

/**
 * Pin the first accepted projection until a composed checkpoint subsumes it.
 * Header/claim validation happens first; this check precedes repair and new turns.
 */
export async function assertNativeProjectionBinding(raw: any, projection: any): Promise<void> {
  const binding = raw.validator.projectionBinding;
  if (!binding) return;
  try {
    const entries = await raw.getEntries();
    if (entries.some((entry: any) => entry.type === "compaction" && entry.checkpoint?.inheritedCoverage)) {
      if (projection) projectInheritedContext(entries, projection.inherited);
      return;
    }
    if (!projection || projection.artifact.id !== binding.artifact.id || projection.artifact.hash !== binding.artifact.hash
      || evidenceDigest(projection.inherited.coverage) !== evidenceDigest(binding.coverage)
      || evidenceDigest(projection.inherited.messages) !== binding.messageDigest) throw failure();
  } catch (cause) { throw Object.assign(failure(), { cause }); }
}
