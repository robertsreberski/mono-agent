// Historical Pi AI 1.2.0 metadata for frozen synthetic accounting/sizing tests.
// Not an installed-catalog override: live paid registration/funding must continue
// to use loadE2Catalog(), including newer context windows and conservative tiers.
import { SOL, LUNA } from "../../lib/continuity-e2-protocol.mjs";
const SHA = "3cc35a7e122e5c77ee8ec30a9a3bd8bd59629997e85ba2cb3f9e0ed62e9a09c0";
const catalogs = [
  { model: SOL, api: "openai-codex-responses", fileSha256: SHA, contextWindow: 272000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] } },
  { model: LUNA, api: "openai-codex-responses", fileSha256: SHA, contextWindow: 272000, maxTokens: 128000, cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] } },
];
export const historicalPi12Catalog = () => structuredClone(catalogs);
