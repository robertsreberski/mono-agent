// @ts-check
export const HOUND_ENDPOINT_REMOVED = "Hound is built in; remove the retired Hound endpoint setting. No external Hound service is contacted.";

export function houndEndpointError(input) {
  return input != null && typeof input === "object" && Object.hasOwn(input, "endpoint") ? HOUND_ENDPOINT_REMOVED : undefined;
}

/** Source-compatible readiness name; local availability only, no engine probe.
 * Old endpoint callers receive an explicit migration error without connecting.
 */
export async function inspectHoundWeb(options = {}) {
  if (houndEndpointError(options)) return { ok: false, reason: "invalid_hound_config" };
  return { ok: true, reason: "local_available" };
}
