// @ts-check
export const LOCAL_ENDPOINT_REMOVED = "Local search is built in; remove the retired Hound endpoint setting. No external service is contacted.";

export function localEndpointError(input) {
  return input != null && typeof input === "object" && Object.hasOwn(input, "endpoint") ? LOCAL_ENDPOINT_REMOVED : undefined;
}

/** Source-compatible readiness name; local availability only, no engine probe.
 * Old endpoint callers receive an explicit migration error without connecting.
 */
export async function inspectLocalWeb(options = {}) {
  if (localEndpointError(options)) return { ok: false, reason: "invalid_local_config" };
  return { ok: true, reason: "local_available" };
}
