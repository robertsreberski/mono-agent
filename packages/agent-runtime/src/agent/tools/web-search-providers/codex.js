// @ts-check
import { claimWebSearchRequest } from "../web-search-state.js";
export const codexProvider = {
  name: "codex", batchesQueries: false, primaryOnly: true,
  // domains: "unverified" — the query text (including site:) is passed through
  // verbatim, but the subscription search is model-mediated through the Codex
  // app-server's unpublished server-side search tool, so server-side operator
  // support cannot be claimed without a live probe; only the client-side
  // domain filter can be relied on.
  filterSupport: { language: "advisory", timeRange: "advisory", country: "unsupported", domains: "unverified" },
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
