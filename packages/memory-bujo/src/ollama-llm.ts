import type { LlmComplete } from "./llm.js";

export function createOllamaLlm(opts: { model: string; endpoint?: string; timeoutMs?: number }): LlmComplete {
  const endpoint = (opts.endpoint ?? "http://localhost:11434").replace(/\/$/u, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    id: `ollama:${opts.model}`,
    async complete(prompt: string): Promise<string> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
