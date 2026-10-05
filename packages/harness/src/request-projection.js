// @ts-check
import { buildHarnessSessionContext } from "./session-context.js";

/**
 * Same-target projection seam. Current host instructions/tools are rebuilt by
 * the caller, never promoted from historical prose. Storage-only repair is prompt evidence,
 * never host adoption or permission to repeat an effect. Handoffs remain later work.
 * @param {any[]} entries
 * @param {{includeFailed?: boolean, repairs?: any[]}} [options]
 */
export function projectContext(entries, options = {}) {
  return { messages: buildHarnessSessionContext(entries, options),
    coverage: { source: "native", repair: options.repairs?.length ? "prompt-only" : "none", entryCount: entries.length } };
}
