// @ts-check
import { searchLocalWeb } from "../local/search.js";
import { localEndpointError } from "../local/config.js";
import { duckDuckGoRegion, unsupportedCountryFilter } from "../web-search-country.js";

/** Native composite: all actual targets AND admission are owned per request.
 * This is a source-level capability, never a config-selected exemption.
 */
export const localProvider: { name: string; batchesQueries: boolean; ownsRequests: boolean; filterSupport: { language: string; timeRange: string; country: string; domains: string }; configure: (input: any) => { error: string; code: string; value?: undefined } | { value: {}; error?: undefined; code?: undefined }; eligibility: () => boolean; admission: () => { kind: string; key: string; processPolicy: string }; networkTargets: () => any[]; preflight: (options: any) => { code: string; message: string; retryable: boolean; preflightSkipped: boolean } | null; search: typeof searchLocalWeb } = {
  name: "local", batchesQueries: false, ownsRequests: true,
  // domains: "operator" — the single DuckDuckGo engine honours site: as
  // documented query syntax; the operator text is forwarded verbatim.
  filterSupport: { language: "advisory", timeRange: "provider", country: "provider", domains: "operator" },
  configure: (input: any) => {
    const error = localEndpointError(input?.hound);
    return error ? { error, code: "invalid_local_config" } : { value: {} };
  },
  eligibility: () => true,
  admission: () => ({ kind: "local", key: "local", processPolicy: "keyless" }),
  networkTargets: () => [],
  preflight: (options: any) => options.country && !duckDuckGoRegion(options.country, options.language)
    ? unsupportedCountryFilter("local") : null,
  search: searchLocalWeb,
};
