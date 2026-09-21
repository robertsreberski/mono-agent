// @ts-check
import { searchLocalWeb } from "../local/search.js";
import { localEndpointError } from "../local/config.js";
import { duckDuckGoRegion, unsupportedCountryFilter } from "../web-search-country.js";

/** Native composite: all actual targets AND admission are owned per request.
 * This is a source-level capability, never a config-selected exemption.
 */
export const localProvider = {
  name: "local", batchesQueries: false, ownsRequests: true,
  filterSupport: { language: "advisory", timeRange: "provider", country: "provider" },
  configure: (input) => {
    const error = localEndpointError(input?.hound);
    return error ? { error, code: "invalid_local_config" } : { value: {} };
  },
  eligibility: () => true,
  admission: () => ({ kind: "local", key: "local", processPolicy: "keyless" }),
  networkTargets: () => [],
  preflight: (options) => options.country && !duckDuckGoRegion(options.country, options.language)
    ? unsupportedCountryFilter("local") : null,
  search: searchLocalWeb,
};
