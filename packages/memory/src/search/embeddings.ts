import type { EmbeddingProvider, EmbeddingProviderConfig, MemorySearchErrorCode } from "./types.js";

export class MemorySearchError extends Error {
  readonly code: MemorySearchErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: MemorySearchErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "MemorySearchError";
    this.code = code;
    this.details = { ...details, code };
  }
}

type FetchLike = typeof fetch;

const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";
const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OllamaEmbeddingOptions {
  readonly model: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

/** Local embeddings via Ollama's `/api/embed` endpoint (e.g. nomic-embed-text). */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OllamaEmbeddingOptions) {
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new MemorySearchError("invalid_embedding_options", "Ollama embedding model is required.");
    }
    this.model = options.model;
    this.endpoint = (options.endpoint ?? DEFAULT_OLLAMA_ENDPOINT).replace(/\/+$/u, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = `ollama:${this.model}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const body = JSON.stringify({ model: this.model, input: [...texts] });
    const response = await withTimeout(this.timeoutMs, (signal) =>
      this.fetchImpl(`${this.endpoint}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      }),
    );
    if (!response.ok) {
      throw new MemorySearchError("embedding_request_failed", `Ollama embeddings request failed (${response.status}).`, {
        status: response.status,
        endpoint: this.endpoint,
      });
    }
    const json = (await response.json()) as { embeddings?: unknown };
    return validateEmbeddings(json.embeddings, texts.length);
  }
}

export interface OpenAIEmbeddingOptions {
  readonly model: string;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

/** Remote embeddings via the OpenAI-compatible `/embeddings` endpoint. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAIEmbeddingOptions) {
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new MemorySearchError("invalid_embedding_options", "OpenAI embedding model is required.");
    }
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new MemorySearchError("invalid_embedding_options", "OpenAI embeddings require an API key.");
    }
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.endpoint = (options.endpoint ?? DEFAULT_OPENAI_ENDPOINT).replace(/\/+$/u, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = `openai:${this.model}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const response = await withTimeout(this.timeoutMs, (signal) =>
      this.fetchImpl(`${this.endpoint}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: [...texts] }),
        signal,
      }),
    );
    if (!response.ok) {
      throw new MemorySearchError("embedding_request_failed", `OpenAI embeddings request failed (${response.status}).`, {
        status: response.status,
      });
    }
    const json = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
    const embeddings = Array.isArray(json.data) ? json.data.map((entry) => entry.embedding) : undefined;
    return validateEmbeddings(embeddings, texts.length);
  }
}

export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  fetchImpl?: FetchLike,
): EmbeddingProvider {
  if (config.provider === "ollama") {
    return new OllamaEmbeddingProvider({
      model: config.model,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  if (config.provider === "openai") {
    if (config.apiKey === undefined) {
      throw new MemorySearchError("invalid_embedding_options", "OpenAI embeddings require an API key.");
    }
    return new OpenAIEmbeddingProvider({
      model: config.model,
      apiKey: config.apiKey,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  throw new MemorySearchError("invalid_embedding_options", `Unknown embedding provider "${String(config.provider)}".`);
}

function validateEmbeddings(value: unknown, expected: number): number[][] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new MemorySearchError("embedding_response_invalid", "Embedding response shape was unexpected.", {
      expected,
      received: Array.isArray(value) ? value.length : typeof value,
    });
  }
  return value.map((vector) => {
    if (!Array.isArray(vector) || vector.some((component) => typeof component !== "number")) {
      throw new MemorySearchError("embedding_response_invalid", "Embedding vector was not an array of numbers.");
    }
    return vector as number[];
  });
}

async function withTimeout(timeoutMs: number, run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
