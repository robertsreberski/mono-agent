import { createHash } from "node:crypto";

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "");

/** Install a metadata-only, request-lifecycle-bounded Pi payload diagnostic. */
export function installPromptCacheDiagnostics(harness, options) {
  if (options.promptCacheDiagnostics !== true || typeof options.onEvent !== "function") return () => {};
  let ordinal = 0;
  return harness.hooks.on("before_payload", (event) => {
    const payload = event?.payload ?? event;
    const system = payload?.system ?? payload?.instructions ?? null;
    const tools = Array.isArray(payload?.tools) ? payload.tools : [];
    const messages = Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload?.input) ? payload.input : [];
    const cacheKey = payload?.prompt_cache_key ?? payload?.cache_key;
    options.onEvent({
      type: "prompt_cache_diagnostic", requestOrdinal: ++ordinal,
      model: `${options.model.provider}:${options.model.id}`, api: options.model.api,
      systemBytes: bytes(system), systemFingerprint: fingerprint(system),
      toolDefinitionCount: tools.length, toolDefinitionsFingerprint: fingerprint(tools),
      messageCount: messages.length, messageFingerprints: messages.slice(0, 256).map(fingerprint),
      messageFingerprintsTruncated: messages.length > 256,
      cacheMode: cacheKey === undefined ? "provider-default" : "keyed",
      ...(cacheKey === undefined ? {} : { cacheKeyFingerprint: fingerprint(cacheKey) }),
      inputInterpretation: payload?.previous_response_id === undefined ? "full" : "delta",
    });
  }, { id: "mono-agent-prompt-cache-diagnostics" });
}
