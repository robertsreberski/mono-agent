// @ts-check
import { buildHarnessSessionContext } from "./session-context.js";

/**
 * Same-target projection seam. Current host instructions/tools are rebuilt by
 * the caller, never promoted from historical prose. P1a deliberately preserves
 * abort-on-reopen; repair and cross-target handoffs are later contracts.
 * @param {any[]} entries
 * @param {{includeFailed?: boolean}} [options]
 */
export function projectContext(entries, options = {}) {
  return { messages: buildHarnessSessionContext(entries, options),
    coverage: { source: "native", repair: "abort-on-reopen", entryCount: entries.length } };
}
