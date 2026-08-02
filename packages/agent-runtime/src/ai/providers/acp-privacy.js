// @ts-check

const PRIVATE_PROTOCOL_KEYS = new Set(["_meta", "sessionId", "session_id"]);
const REDACTED = "[redacted]";
const MAX_HOST_VALUE_DEPTH = 32;
const MAX_HOST_VALUE_NODES = 4_096;

/**
 * ACP protocol session ids are connection state, not host-facing metadata.
 * Remove their canonical keys, discard extension metadata, and redact copies
 * embedded by an agent in otherwise public strings.
 *
 * @param {unknown} value
 * @param {ReadonlyArray<unknown>} [rawSecrets]
 * @returns {any}
 */
export function sanitizeAcpHostValue(value, rawSecrets = []) {
  const secrets = rawSecrets
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => /** @type {string} */ (right).length - /** @type {string} */ (left).length);

  /** @param {string} text */
  const redact = (text) => {
    let result = text;
    for (const secret of secrets) {
      result = result.replaceAll(/** @type {string} */ (secret), REDACTED);
    }
    return result;
  };

  let nodes = 0;

  /** @param {unknown} item @param {WeakSet<object>} ancestors @param {number} depth @returns {any} */
  const visit = (item, ancestors, depth) => {
    nodes += 1;
    if (nodes > MAX_HOST_VALUE_NODES || depth > MAX_HOST_VALUE_DEPTH) return null;
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) {
      if (ancestors.has(item)) return null;
      ancestors.add(item);
      const result = [];
      for (const entry of item) {
        if (nodes >= MAX_HOST_VALUE_NODES) break;
        result.push(visit(entry, ancestors, depth + 1));
      }
      ancestors.delete(item);
      return result;
    }
    if (!item || typeof item !== "object") return item;
    if (ancestors.has(item)) return null;
    ancestors.add(item);
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [key, entry] of Object.entries(item)) {
      if (nodes >= MAX_HOST_VALUE_NODES) break;
      if (PRIVATE_PROTOCOL_KEYS.has(key)) continue;
      result[redact(key)] = visit(entry, ancestors, depth + 1);
    }
    ancestors.delete(item);
    return result;
  };

  return visit(value, new WeakSet(), 0);
}
