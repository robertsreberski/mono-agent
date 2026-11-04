import { expect } from 'vitest';
const keys = new Set(`status codes skipped piAiVersion assumptions modeled tokenHeuristic imageTokens pinBudgetBytes protectedTurns protectedToolUses minimumBatchTokens
minimumRunsBetweenBatches retrievalRate retrievalEvidence summaryToolCharacterLimit costModel quotaUnit priceUnit warmClearing exclusionUnit requestCount fallbackRequests fallbackShare
counts journals boundaries observedCompactions observed summaryTokens drainTokens preCompactionTokens categories builtin-read builtin-search builtin-web app-declared ambiguous
results originalBytes eligibleBytes escapedBytes structuredScanLosses redacted truncated escapedToOriginalRatio exclusions lifecycle error blocks retention integrity protected nonpositive identity pin_budget tool_scope
routes verdict api triggerTokens drainTokens summaryInputTokens summaryOutputTokens cacheMarginMs quotaBudget cacheLifetimeMs prices quota input cacheRead cacheWrite output
pressured conversations cold coldConversations opportunities estimates usage heuristic gaps underMinute underHour longer unknown upperBoundBoundaryTokens savingsHistogram none under50k larger
summaryFitsWithinTrigger growthTokens savedTokens offPressure onPressure pressureReduction costs listOff listOn listRatio quotaShareOff quotaShareOn quotaRatio
warmUnknownWorstListOn warmUnknownWorstQuotaShareOn payload wire modeledUpperBoundBoundaryTokens
SNAPSHOT_CHANGED SIDECAR_NOT_OFFLINE INPUT_INVALID NO_JOURNALS LEGACY_JOURNAL IMPORTED_JOURNAL INHERITED_PROJECTION INTERRUPTION DUPLICATE_JOURNAL OPEN_TURN JOURNAL_INVALID
UNSUPPORTED_API ROUTE_MISSING OWNER_MISSING DUPLICATE_BOUNDARY TIME_ORDER`.split(/\s+/));
const enums = new Set(`complete incomplete BUILD DEFER STOP 1.2.0 unknown supplied payload-preserving fails unqualified
SNAPSHOT_CHANGED SIDECAR_NOT_OFFLINE INPUT_INVALID NO_JOURNALS IDENTITY_UNPROVEN PAYLOAD_UNQUALIFIED COLD_EVIDENCE_INSUFFICIENT`.split(/\s+/));
for (const value of ['anthropic-messages', 'openai-responses', 'openai-codex-responses', 'openai-completions', 'utf16-ceil/4',
  'result-boundary-occurrences', 'pending lookup-pilot evidence', 'observed-requests-plus-modeled-delta',
  'share-of-supplied-quota-budget', 'per-million-tokens', 'wire-unproven (transport)']) enums.add(value);
export function assertContentFree(report, fixtures = []) {
  const visit = value => {
    if (typeof value === 'string') expect(enums.has(value), `unexpected output string`).toBe(true);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      expect(keys.has(key), `unexpected output key`).toBe(true); visit(child);
    } else expect(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)).toBe(true);
  };
  visit(report);
  const serialized = JSON.stringify(report);
  expect(serialized).not.toMatch(/chr1_|[a-f0-9]{64}/);
  for (const f of fixtures) for (const secret of [f.root, ...Object.values(f.paths), ...f.secrets]) expect(serialized).not.toContain(secret);
}
