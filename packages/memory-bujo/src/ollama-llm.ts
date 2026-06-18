import type { LlmComplete } from "./llm.js";

// A capture runs several sequential LLM calls (distil → reconcile → extract entities); local Ollama
// chat models routinely take tens of seconds per call, so the per-call timeout is generous by
// default (and overridable). Too short a timeout aborts mid-capture, and because distil/reconcile/
// entities swallow LLM errors (never-throw), that surfaces as a memory that silently stores nothing.
const DEFAULT_TIMEOUT_MS = 120_000;

export function createOllamaLlm(opts: { model: string; endpoint?: string; timeoutMs?: number }): LlmComplete {
  const endpoint = (opts.endpoint ?? "http://localhost:11434").replace(/\/$/u, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: `ollama:${opts.model}`,
    async complete(prompt: string): Promise<string> {
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      try {
        const res = await fetch(`${endpoint}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: opts.model, prompt, stream: false }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`ollama /api/generate ${res.status}`);
        const data = (await res.json()) as { response?: unknown };
        return typeof data.response === "string" ? data.response : "";
      } catch (err) {
        // Translate our own abort into an explicit, diagnosable timeout (a generic AbortError that
        // callers swallow would make a slow-model capture look like "nothing to remember").
        if (timedOut) throw new Error(`ollama /api/generate timed out after ${timeoutMs}ms`);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
