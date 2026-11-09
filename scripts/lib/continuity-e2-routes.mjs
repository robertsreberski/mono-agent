// Source-owned capability inventory, bound as code. Never infer support from an option name.
import { SOL, LUNA } from "./continuity-e2-protocol.mjs";
export const E2_ROUTE_CAPABILITIES = Object.freeze({
  "openai-codex-responses": Object.freeze({ enforcedOutputCap: false }),
});
export const E2_MODEL_APIS = Object.freeze({ [SOL]: "openai-codex-responses", [LUNA]: "openai-codex-responses" });
export function assertE2OutputLimit(catalog, maxOutputTokens) {
  const capability = E2_ROUTE_CAPABILITIES[catalog?.api];
  if (!capability || E2_MODEL_APIS[catalog?.model] !== catalog.api)
    throw Object.assign(Error("E2_ROUTE_CAPABILITY_UNKNOWN"), { code: "E2_ROUTE_CAPABILITY_UNKNOWN" });
  if (!capability.enforcedOutputCap && maxOutputTokens !== catalog.maxTokens)
    throw Object.assign(Error("E2_OUTPUT_LIMIT_UNENFORCED"), { code: "E2_OUTPUT_LIMIT_UNENFORCED" });
}
