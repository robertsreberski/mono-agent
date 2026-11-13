import type { ContinuityKind, ContinuityRelevanceContinuation } from "./continuity-contracts.js";
import { relevanceMatch, relevanceQuery } from "./relevance.js";
import { evidenceMatch, evidenceQuery } from "./relevance-v2.js";
import { contentFirstMatch, contentFirstQuery } from "./relevance-v3.js";

type Anchor = ContinuityRelevanceContinuation["anchor"];
const ids = (a: Anchor, b: Anchor) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
// Frozen v1 parser/matcher/comparator: no v2 eligibility, expansion or bonuses.
const compareV1 = (a: Anchor, b: Anchor) => b.score - a.score || b.ordinal - a.ordinal || ids(a, b);
const compareEvidence = (historical: boolean) => (a: Anchor, b: Anchor) => b.score - a.score
  || (historical ? a.ordinal - b.ordinal : b.ordinal - a.ordinal) || ids(a, b);

/** A ranking version selects parsing, expansion, eligibility, score and all
 * comparisons (including cursor anchors). Cursor envelope version is separate. */
export function relevancePipeline(version: 1 | 2 | 3, text: string) {
  switch (version) {
    case 1: {
      const query = relevanceQuery(text);
      return { query, match: (body: string, _kind: ContinuityKind) => relevanceMatch(body, query), compare: compareV1 };
    }
    case 2: {
      const query = evidenceQuery(text);
      return { query, match: (body: string, kind: ContinuityKind) => evidenceMatch(body, query, kind), compare: compareEvidence(query.historical) };
    }
    case 3: {
      const query = contentFirstQuery(text);
      return { query, match: (body: string, kind: ContinuityKind) => contentFirstMatch(body, query, kind), compare: compareEvidence(query.historical) };
    }
    default: {
      const unsupported: never = version;
      throw new Error(`Unsupported ranking version: ${unsupported}`);
    }
  }
}
