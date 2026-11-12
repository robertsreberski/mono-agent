import type { ContinuityKind, ContinuityRelevanceContinuation } from "./continuity-contracts.js";
import { relevanceMatch, relevanceQuery } from "./relevance.js";
import { evidenceMatch, evidenceQuery } from "./relevance-v2.js";

type Anchor = ContinuityRelevanceContinuation["anchor"];
const ids = (a: Anchor, b: Anchor) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
// Frozen v1 parser/matcher/comparator: no v2 eligibility, expansion or bonuses.
const compareV1 = (a: Anchor, b: Anchor) => b.score - a.score || b.ordinal - a.ordinal || ids(a, b);

/** A ranking version selects parsing, expansion, eligibility, score and all
 * comparisons (including cursor anchors). Cursor envelope version is separate. */
export function relevancePipeline(version: 1 | 2, text: string) {
  if (version === 1) {
    const query = relevanceQuery(text);
    return { query, match: (body: string, _kind: ContinuityKind) => relevanceMatch(body, query), compare: compareV1 };
  }
  const query = evidenceQuery(text);
  return { query, match: (body: string, kind: ContinuityKind) => evidenceMatch(body, query, kind),
    // Ordinals order captures, not event dates. Historical discovery neutralizes
    // newest-first ties; current-state and literal queries keep newest first.
    compare: (a: Anchor, b: Anchor) => b.score - a.score || (query.historical ? a.ordinal - b.ordinal : b.ordinal - a.ordinal) || ids(a, b) };
}
