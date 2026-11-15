import { runtimeProvenanceDetail } from "./runtime-provenance.js";

/** Produces the informational runtime-provenance detail for one validation. */
export type RuntimeProvenanceSource = () => Promise<string>;

/**
 * Single-flight, process-lifetime memo of the runtime-provenance detail.
 *
 * The code a process runs cannot change underneath it, yet verifying a managed
 * runtime closure re-hashes every installed file (seconds on a real install).
 * Long-lived in-process callers — the console's capability, action and
 * credential validations — therefore verify at most once per process;
 * concurrent first callers share the same in-flight verification. A rejected
 * computation is not retained, so a later call retries. One-shot CLI paths
 * (`mono-agent validate`) keep calling `runtimeProvenanceDetail()` directly
 * and verify freshly every time.
 */
export function memoizeRuntimeProvenanceDetail(
  compute: RuntimeProvenanceSource = () => runtimeProvenanceDetail(),
): RuntimeProvenanceSource {
  let memo: Promise<string> | undefined;
  return () => {
    memo ??= compute().catch((error: unknown) => {
      memo = undefined;
      throw error;
    });
    return memo;
  };
}

/** The one memo shared by every console-originated validation in this process. */
export const processRuntimeProvenanceDetail: RuntimeProvenanceSource = memoizeRuntimeProvenanceDetail();

/**
 * Console validation source: the launch verifier's already-bound detail when
 * this process was started as a verified managed worker, otherwise the lazy
 * process memo.
 */
export function consoleRuntimeProvenanceSource(verifiedDetail: string | undefined): RuntimeProvenanceSource {
  return verifiedDetail === undefined ? processRuntimeProvenanceDetail : async () => verifiedDetail;
}
