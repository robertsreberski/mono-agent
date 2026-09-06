import { describe, expect, it, vi } from "vitest";
import { installPromptCacheDiagnostics } from "../../ai/providers/pi-native/prompt-cache-diagnostics.js";

describe("prompt cache diagnostics", () => {
  it("is opt-in and emits fingerprints without content", () => {
    let hook;
    const remove = vi.fn();
    const onEvent = vi.fn();
    installPromptCacheDiagnostics({ hooks: { on: (_name, handler) => { hook = handler; return remove; } } }, { promptCacheDiagnostics: true, onEvent, model: { provider: "x", id: "m", api: "responses" } });
    hook({ payload: { system: "SECRET PROMPT", tools: [{ name: "Read", secret: "NO" }], messages: [{ role: "user", content: "PRIVATE" }], prompt_cache_key: "KEY" } });
    const encoded = JSON.stringify(onEvent.mock.calls[0][0]);
    expect(encoded).not.toContain("SECRET"); expect(encoded).not.toContain("PRIVATE"); expect(encoded).not.toContain("KEY");
    expect(onEvent.mock.calls[0][0]).toMatchObject({ requestOrdinal: 1, messageCount: 1, cacheMode: "keyed", inputInterpretation: "full" });
  });
});
