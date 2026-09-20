// @ts-check
import { searchLocalHound } from "../hound-local/search.js";
import { houndEndpointError } from "../hound-local/config.js";

/** Native composite: all actual targets AND admission are owned per request.
 * This is a source-level capability, never a config-selected exemption.
 */
export const houndProvider = {
  name: "hound", batchesQueries: false, ownsRequests: true,
  filterSupport: { language: "advisory", timeRange: "provider" },
  configure: (input) => {
    const error = houndEndpointError(input?.hound);
    return error ? { error, code: "invalid_hound_config" } : { value: {} };
  },
  eligibility: () => true,
  admission: () => ({ kind: "hound", key: "local", processPolicy: "keyless" }),
  networkTargets: () => [],
  search: searchLocalHound,
};
