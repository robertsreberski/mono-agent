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
 * @returns {{value: any, truncated: boolean}}
 */
export function sanitizeAcpHostValueWithStatus(value, rawSecrets = []) {
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
  let truncated = false;

  /** @param {unknown} item @param {WeakSet<object>} ancestors @param {number} depth @returns {any} */
  const visit = (item, ancestors, depth) => {
    nodes += 1;
    if (nodes > MAX_HOST_VALUE_NODES || depth > MAX_HOST_VALUE_DEPTH) {
      truncated = true;
      return null;
    }
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) {
      if (ancestors.has(item)) {
        truncated = true;
        return null;
      }
      ancestors.add(item);
      const result = [];
      for (const entry of item) {
        if (nodes >= MAX_HOST_VALUE_NODES) {
          truncated = true;
          break;
        }
        result.push(visit(entry, ancestors, depth + 1));
      }
      ancestors.delete(item);
      return result;
    }
    if (!item || typeof item !== "object") return item;
    if (ancestors.has(item)) {
      truncated = true;
      return null;
    }
    ancestors.add(item);
    /** @type {Record<string, unknown>} */
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(item)) {
      if (nodes >= MAX_HOST_VALUE_NODES) {
        truncated = true;
        break;
      }
      if (PRIVATE_PROTOCOL_KEYS.has(key)) continue;
      Object.defineProperty(result, redact(key), {
        value: visit(entry, ancestors, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    ancestors.delete(item);
    return result;
  };

  return { value: visit(value, new WeakSet(), 0), truncated };
}

/**
 * Compatibility wrapper for callback/list surfaces that intentionally accept
 * a bounded representation. Protocol normalization should use the status form
 * above so it can fail explicitly instead of consuming partial data.
 *
 * @param {unknown} value
 * @param {ReadonlyArray<unknown>} [rawSecrets]
 * @returns {any}
 */
export function sanitizeAcpHostValue(value, rawSecrets = []) {
  return sanitizeAcpHostValueWithStatus(value, rawSecrets).value;
}

/** @param {unknown} value @returns {string|null} */
export function ownAcpSessionUpdateKind(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Object.hasOwn(value, "sessionUpdate")) return null;
  const kind = /** @type {{sessionUpdate?: unknown}} */ (value).sessionUpdate;
  return typeof kind === "string" ? kind : null;
}
