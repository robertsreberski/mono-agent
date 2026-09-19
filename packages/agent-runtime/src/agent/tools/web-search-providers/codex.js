// @ts-check
import { claimWebSearchRequest } from "../web-search-state.js";
export const codexProvider = {
  name: "codex", batchesQueries: false, primaryOnly: true,
  filterSupport: { language: "advisory", timeRange: "advisory" },
  configure(input) {
    const model = typeof input?.codex?.model === "string" && input.codex.model.trim()
      ? input.codex.model.trim() : "gpt-5.6-luna";
    if (model.length > 160 || /[\u0000-\u001f\u007f]/u.test(model)) {
      return { error: "Codex web search model must be a valid model id." };
    }
    return { value: { codex: { model } } };
  },
  eligibility: () => true,
  admission: () => ({ kind: "codex", key: "codex", processPolicy: "provider-owned" }),
  networkTargets: () => ["https://chatgpt.com"],
  search: (query, options) => options.codexSearch(query, {
    model: options.config.codex.model, signal: options.signal, coordinator: options.coordinator,
    language: options.language, timeRange: options.timeRange,
    claimRequest: () => claimWebSearchRequest(options.searchState, "codex", options.callClaims),
  }),
};
