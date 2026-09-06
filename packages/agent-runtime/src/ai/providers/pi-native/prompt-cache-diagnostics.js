import { createHash } from "node:crypto";

const MAX_MESSAGE_FINGERPRINTS = 128;
const safeString = (value) => typeof value === "string" ? value.slice(0, 160) : undefined;
const serialized = (value) => JSON.stringify(value) ?? "null";
const fingerprint = (value) => createHash("sha256").update(serialized(value)).digest("hex").slice(0, 16);
const bytes = (value) => value == null ? 0 : Buffer.byteLength(typeof value === "string" ? value : serialized(value));
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const list = (value) => Array.isArray(value) ? value : [];

function normalizedPayload(event) {
  const payload = record(event?.payload);
  if (!payload) return { family: "unsupported", reason: "payload_not_object" };
  const api = safeString(event?.model?.api) ?? "unknown";
  if (api === "google-generative-ai" || api === "google-vertex") {
    const config = record(payload.config) ?? {};
    const tools = list(config.tools).flatMap((tool) => list(record(tool)?.functionDeclarations).length > 0
      ? list(record(tool)?.functionDeclarations) : [tool]);
    return { family: "google", system: config.systemInstruction ?? null, tools, messages: list(payload.contents), payload };
  }
  if (api === "pi-messages") {
    const context = record(payload.context);
    if (context && ("messages" in context || "systemPrompt" in context || "tools" in context)) {
      return { family: "pi-messages", system: context.systemPrompt ?? null, tools: list(context.tools), messages: list(context.messages), payload };
    }
  }
  if (api === "bedrock-converse-stream") {
    return { family: "bedrock", system: payload.system ?? null, tools: list(record(payload.toolConfig)?.tools), messages: list(payload.messages), payload };
  }
  if (api === "anthropic-messages") {
    return { family: "anthropic", system: payload.system ?? null, tools: list(payload.tools), messages: list(payload.messages), payload };
  }
  if (["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(api)) {
    return { family: api === "openai-codex-responses" ? "openai-codex" : "openai-responses", system: payload.instructions ?? null, tools: list(payload.tools), messages: list(payload.input), payload };
  }
  return { family: "unsupported", reason: `unrecognized_api:${api}` };
}

function cacheMetadata(payload, family) {
  const disabled = payload.prompt_cache_retention === "none" || record(payload.options)?.cacheRetention === "none";
  const key = payload.prompt_cache_key ?? payload.cache_key ?? payload.cachedContent
    ?? (family === "pi-messages" ? record(payload.options)?.sessionId : undefined);
  let explicit = false;
  const pending = [{ value: payload, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 10_000) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (depth > 12 || value === null || typeof value !== "object") continue;
    for (const [name, child] of Object.entries(value)) {
      if (["cache_control", "cachePoint", "cache_point", "prompt_cache_retention", "prompt_cache_options"].includes(name) && child != null) explicit = true;
      if (typeof child === "object" && child !== null) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return {
    cacheMode: disabled ? "disabled" : [key === undefined ? "" : "keyed", explicit ? "explicit" : ""].filter(Boolean).join("+") || "provider-default",
    ...(disabled || key === undefined ? {} : { cacheKeyFingerprint: fingerprint(key) }),
  };
}

/** Install a metadata-only, request-lifecycle-bounded Pi payload diagnostic. */
export function installPromptCacheDiagnostics(harness, options) {
  if (options.promptCacheDiagnostics !== true || typeof options.onEvent !== "function") return () => {};
  let ordinal = 0;
  return harness.hooks.on("before_payload", (event) => {
    const normalized = normalizedPayload(event);
    const model = event?.model ?? options.model ?? {};
    const base = {
      type: "prompt_cache_diagnostic",
      requestOrdinal: ++ordinal,
      model: [safeString(model.provider), safeString(model.id)].filter(Boolean).join(":") || "unknown",
      api: safeString(model.api) ?? "unknown",
      payloadFamily: normalized.family,
    };
    if (normalized.family === "unsupported") {
      options.onEvent({ ...base, supported: false, unsupportedReason: normalized.reason });
      return;
    }
    const messages = normalized.messages;
    const logicalInputInterpretation = normalized.payload.previous_response_id === undefined ? "full" : "delta";
    const codexWireUnknown = normalized.family === "openai-codex" && logicalInputInterpretation === "full";
    options.onEvent({
      ...base,
      supported: true,
      systemBytes: bytes(normalized.system), systemFingerprint: fingerprint(normalized.system),
      toolDefinitionCount: normalized.tools.length, toolDefinitionsFingerprint: fingerprint(normalized.tools),
      messageCount: messages.length,
      messageFingerprints: messages.slice(0, MAX_MESSAGE_FINGERPRINTS).map(fingerprint),
      messageFingerprintsTruncated: messages.length > MAX_MESSAGE_FINGERPRINTS,
      ...cacheMetadata(normalized.payload, normalized.family),
      logicalInputInterpretation,
      inputInterpretation: codexWireUnknown ? "unavailable" : logicalInputInterpretation,
      inputInterpretationSource: codexWireUnknown ? "pre_transport_payload" : "provider_payload",
    });
  }, { id: "mono-agent-prompt-cache-diagnostics" });
}
