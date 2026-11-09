// Lookup-only route, options and payload policy; no authority or transport.
export function lookupGuardedModelPolicy(codes, LookupGuardError) {
  const refuse = (code, classification) => { throw new LookupGuardError(code, "refused_pre_send", classification); };
  function assertLookupAuxiliaryCallersOff({ plan, memory, subagents, upkeep, compaction, outputSchema }) {
    if (plan?.judge !== null || memory !== false || subagents !== false || upkeep !== false || compaction !== false || outputSchema != null)
      refuse(codes.auxiliary_callers_forbidden);
  }
  function assertLookupChildSafety(settings) { assertLookupAuxiliaryCallersOff(settings); }
  const REQUEST_OPTION_KEYS = new Set([
    "temperature", "samplingParams", "maxTokens", "signal", "telemetryContext", "apiKey",
    "transport", "cacheRetention", "sessionId", "headers", "onPayload", "onResponse",
    "onProviderStreamEvent", "timeoutMs", "websocketConnectTimeoutMs", "maxRetries",
    "maxRetryDelayMs", "metadata", "env", "reasoning", "model", "piMaxRetries",
    "convertToLlm", "toolExecution", "getSteeringMessages", "getFollowUpMessages",
    "prepareRequest", "beforeToolCall", "getApiKey",
  ]);
  function assertIdentity(model, contract) {
    if (model?.provider !== contract.provider || (model?.id ?? model?.model) !== contract.model
      || (model.api !== undefined && model.api !== contract.api) || (model.baseUrl !== undefined && model.baseUrl !== contract.baseUrl)
      || (model.contextWindow !== undefined && model.contextWindow !== 272000)
      || (model.maxTokens !== undefined && model.maxTokens > 128000)) refuse(codes.route_mismatch);
  }
  function assertRoute(model, options, contract) {
    if (Object.hasOwn(options, "fetch")) refuse(codes.external_fetch_forbidden);
    for (const key of Object.keys(options)) if (!REQUEST_OPTION_KEYS.has(key)) refuse(codes.option_forbidden);
    if (options.headers != null) {
      let count;
      try { count = [...new Headers(options.headers)].length; } catch { refuse(codes.headers_forbidden); }
      if (count) refuse(codes.headers_forbidden);
    }
    if (options.env != null && (typeof options.env !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options.env)) || Object.keys(options.env).length)) refuse(codes.env_forbidden);
    assertIdentity(model, contract);
    if (model?.api !== contract.api || model?.baseUrl !== contract.baseUrl
      || options.reasoning !== contract.effort || options.transport !== "sse" || options.maxRetries !== 0
      || (options.piMaxRetries !== undefined && options.piMaxRetries !== 0)) refuse(codes.route_mismatch);
    if (options.model !== undefined) assertIdentity(options.model, contract);
  }
  function keysOnly(value, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) refuse(codes.payload_forbidden);
  }
  function textParts(parts, reasoning = false) {
    if (!Array.isArray(parts)) refuse(codes.payload_forbidden);
    for (const part of parts) {
      keysOnly(part, reasoning ? ["type", "text"] : ["type", "text", "annotations"]);
      if (!(reasoning ? ["summary_text"] : ["input_text", "output_text"]).includes(part.type) || typeof part.text !== "string") refuse(codes.payload_forbidden);
      if (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length)) refuse(codes.payload_forbidden);
    }
  }
  function assertPayload(payload, round, contract) {
    keysOnly(payload, ["model", "store", "stream", "instructions", "input", "text", "include", "prompt_cache_key", "tool_choice", "parallel_tool_calls", "temperature", "service_tier", "tools", "reasoning"]);
    if (payload.model !== contract.model || payload.reasoning?.effort !== contract.effort || payload.store !== false || payload.stream !== true
      || payload.service_tier !== undefined || !Array.isArray(payload.input)) refuse(codes.payload_forbidden);
    if ((contract.promptCacheKey !== undefined || Object.hasOwn(payload, "prompt_cache_key")) && payload.prompt_cache_key !== contract.promptCacheKey) refuse(codes.prompt_cache_key_forbidden);
    keysOnly(payload.reasoning, ["effort", "summary"]);
    if (payload.text !== undefined) keysOnly(payload.text, ["verbosity"]);
    if (payload.include !== undefined && (!Array.isArray(payload.include) || payload.include.some(x => x !== "reasoning.encrypted_content"))) refuse(codes.payload_forbidden);
    if (payload.instructions !== undefined && typeof payload.instructions !== "string") refuse(codes.payload_forbidden);
    if (payload.tools !== undefined && !Array.isArray(payload.tools)) refuse(codes.payload_forbidden);
    for (const tool of payload.tools ?? []) {
      keysOnly(tool, ["type", "name", "description", "parameters", "strict"]);
      if (tool.type !== "function") refuse(codes.payload_forbidden);
    }
    for (const item of payload.input) {
      if (item?.type === "reasoning") {
        keysOnly(item, ["type", "id", "summary", "encrypted_content", "status", "content"]);
        if (round === 1) refuse(codes.initial_reasoning_forbidden);
        if (item.summary !== undefined) textParts(item.summary, true);
        if (item.content != null) {
          if (!Array.isArray(item.content) || item.content.length > 1) refuse(codes.payload_forbidden);
          for (const part of item.content) {
            keysOnly(part, ["type", "text"]);
            if (part.type !== "reasoning_text" || typeof part.text !== "string") refuse(codes.payload_forbidden);
          }
        }
      } else if (item?.type === "function_call") {
        keysOnly(item, ["type", "id", "call_id", "name", "arguments", "namespace", "status"]);
        if (typeof item.arguments !== "string") refuse(codes.payload_forbidden);
      } else if (item?.type === "function_call_output") {
        keysOnly(item, ["type", "call_id", "output", "id", "status"]);
        if (typeof item.output !== "string") refuse(codes.payload_forbidden);
      } else {
        keysOnly(item, ["type", "role", "content", "id", "status", "phase"]);
        if (![undefined, "message"].includes(item.type) || !["system", "developer", "user", "assistant"].includes(item.role)) refuse(codes.payload_forbidden);
        if (typeof item.content !== "string") textParts(item.content);
      }
    }
  }
  return Object.freeze({ assertLookupAuxiliaryCallersOff, assertLookupChildSafety, assertRoute, assertPayload });
}
