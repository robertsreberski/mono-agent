/**
 * Native-fetch OTLP/HTTP+JSON POST. Zero runtime dependencies: uses the
 * `fetch` + `AbortController` + `setTimeout`/`clearTimeout` idiom already used
 * elsewhere in the repo (memory-bujo/ollama-llm.ts). The caller (the composite
 * recorder's best-effort wrapper) is responsible for swallowing failures; this
 * function either resolves with `{ ok, status }` or throws.
 */

export interface PostOtlpJsonInput {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface PostOtlpJsonResult {
  readonly ok: boolean;
  readonly status: number;
}

export async function postOtlpJson(input: PostOtlpJsonInput): Promise<PostOtlpJsonResult> {
  const { endpoint, headers, body, timeoutMs } = input;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is not available; supply fetchImpl");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OTLP export failed: ${endpoint} responded ${response.status}`);
    }
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}
