// @ts-check
import { parallelProvider } from "./parallel.js";
import { houndProvider } from "./hound.js";
import { searxngProvider } from "./searxng.js";
import { ollamaProvider } from "./ollama.js";
import { codexProvider } from "./codex.js";
import { duckduckgoProvider } from "./duckduckgo.js";
import { startpageProvider } from "./startpage.js";

/**
 * Source-level provider contract. The chain owns relevance, fusion, deadlines,
 * deferrals and refund settlement. Adapters own request shaping and parsing.
 * configure returns a normalized config patch or a deterministic error; selected
 * identifies an explicit selection (requirements must not silently skip it).
 * networkTargets are sandbox-gated before admission; transports must also gate
 * computed destinations and reject unsafe redirects. Admission keys and outcome
 * metadata must never contain queries, bodies or credentials.
 * search claims immediately before dispatch, via web-search-state; setup and
 * failed responses are refunded by the chain. batchesQueries providers receive
 * options.queries in primary-first order; others receive sequential queries.
 * An optional preflight may refuse the attempt before admission is constructed
 * or the coordinator is touched (no quota claimed, no dispatch); it returns a
 * failure object or nullish to proceed.
 *
 * @typedef {Object} SearchProvider
 * @property {string} name
 * @property {(raw: any, selected: boolean) => {value?: any, error?: string, code?: string}} configure
 * @property {(config: any) => boolean} eligibility
 * @property {(config: any) => {kind: string, key: string, processPolicy: string}} admission
 * @property {(config: any) => string[]} networkTargets
 * @property {{language: string, timeRange: string}} filterSupport
 * @property {boolean} batchesQueries
 * @property {boolean} [primaryOnly]
 * @property {number} [chainDeadlineMs]
 * @property {((options: any) => {code: string, message: string, retryable: boolean} | null | undefined)} [preflight]
 * @property {(query: string, options: any) => any} search
 */

/** @type {Map<string, SearchProvider>} */
export const webSearchProviders = new Map();

/** Source-level registration only; never load config-supplied module paths.
 * @param {SearchProvider} provider
 */
export function registerSearchProvider(provider) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(provider.name) || ["auto", "keyless"].includes(provider.name)) {
    throw new Error("Invalid web search provider name.");
  }
  if (webSearchProviders.has(provider.name)) throw new Error("Duplicate web search provider.");
  webSearchProviders.set(provider.name, provider);
  return () => { webSearchProviders.delete(provider.name); };
}

for (const provider of [searxngProvider, ollamaProvider, codexProvider, duckduckgoProvider, startpageProvider, parallelProvider, houndProvider]) {
  registerSearchProvider(provider);
}

export function expandSearchProvider(name) {
  return name === "keyless" ? ["duckduckgo", "startpage"] : [name];
}
