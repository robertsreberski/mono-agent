import { retryProviderRequest } from "@earendil-works/pi-ai/utils/provider-retry";

// Only these bounded transport identifiers may enter persistent diagnostics.
const CAUSE_CODE = /^(?:EPIPE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]{1,40})$/;
export function attributedCauseCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string" && CAUSE_CODE.test(value.code)) return value.code;
    current = value.cause;
  }
  return null;
}

export const TERMINAL_PROVIDER_ERROR = /usage[_ ]limit|insufficient[_ ]quota|quota[_ ]exceeded|quota exceeded|billing|out of budget|available balance|context[_ ](?:length|window)|context limit|input (?:is too long|exceeds)|invalid[_ ](?:request|api[_ ]key)|unauthori[sz]ed|forbidden|authentication|validation|safety|content[_ ](?:filter|policy)|max(?:imum)?(?:[_ ]output)?[_ ]tokens?|max turns/i;

type AttemptObservation = {
  httpPhase: "unknown" | "pre-response" | "post-response";
  status: number | undefined;
  veto: boolean;
  shortPolicy: boolean;
  terminal: boolean;
  transportFailure: boolean;
  bodyFailure: boolean;
  cause: string | null;
  delayLimit: boolean;
  serverDelayMs: number | undefined;
};

/** Read only a bounded error preview; never read a successful response here. */
async function terminalResponse(response: Response): Promise<boolean> {
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 4096) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value.subarray(0, 4096 - text.length), { stream: true });
    }
    return TERMINAL_PROVIDER_ERROR.test(text);
  } finally {
    // A tee's cancellation can wait for the original branch: do not await it.
    void reader.cancel().catch(() => {});
  }
}

// The long schedule is not an HTTP-policy retry layer, but still must not send
// earlier than the provider requests. Match the native helper's header grammar.
function serverRetryDelay(headers: Headers): number | undefined {
  const milliseconds = Number.parseFloat(headers.get("retry-after-ms") ?? "");
  if (Number.isFinite(milliseconds)) return Math.max(0, milliseconds);
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number.parseFloat(value);
  const delay = Number.isNaN(seconds) ? Date.parse(value) - Date.now() : seconds * 1000;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

function replay(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): (() => Parameters<typeof globalThis.fetch>[0]) | null {
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) return null;
  if (input instanceof Request) {
    if (input.bodyUsed || input.body?.locked) return null;
    const template = input.clone();
    return () => template.clone();
  }
  return () => input;
}

/** One assistant request's observation, never a process-wide transport probe. */
export function createRequestObserver({ maxRetries, maxRetryDelayMs, fetch: send = globalThis.fetch }: {
  maxRetries: number; maxRetryDelayMs: number; fetch?: typeof globalThis.fetch;
}) {
  let observation: AttemptObservation;
  let sends = 0;
  const reset = () => {
    observation = { status: undefined, httpPhase: "unknown", veto: false, shortPolicy: false, terminal: false,
      transportFailure: false, bodyFailure: false, cause: null, delayLimit: false, serverDelayMs: undefined };
  };
  reset();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const nextInput = replay(input, init);
    let shortResponse: Response | undefined, shortError: Error | undefined;
    class TransportFailure extends Error { constructor(readonly original: unknown) { super("Request transport failed"); } }
    const request = async () => {
      signal?.throwIfAborted();
      if (shortResponse) {
        void shortResponse.body?.cancel().catch(() => {});
        shortResponse = undefined; shortError = undefined;
      }
      observation.httpPhase = "pre-response";
      observation.status = undefined;
      observation.cause = null;
      observation.shortPolicy = false;
      sends++;
      let response: Response;
      try {
        const requestInit = init?.body instanceof Uint8Array ? { ...init, body: new Uint8Array(init.body) } : init;
        response = await send(nextInput ? nextInput() : input, requestInit);
      }
      catch (error) {
        observation.cause = attributedCauseCode(error);
        const text = error instanceof Error ? error.message : "";
        observation.transportFailure = !signal?.aborted && (observation.cause !== null
          || /fetch failed|connection error|network (?:error|request failed)|socket hang up|terminated|connection (?:lost|reset|refused)|timed? ?out/i.test(text));
        throw new TransportFailure(error);
      }
      observation.httpPhase = "post-response";
      observation.status = response.status;
      observation.veto = response.headers.get("x-should-retry") === "false";
      observation.serverDelayMs = serverRetryDelay(response.headers);
      observation.delayLimit = observation.serverDelayMs !== undefined && observation.serverDelayMs > maxRetryDelayMs;
      observation.terminal = !response.ok && await terminalResponse(response);
      if ([408, 409, 429].includes(response.status)) {
        observation.shortPolicy = true;
        if (nextInput && !observation.veto && !observation.terminal) {
          shortResponse = response;
          shortError = Object.assign(new Error("Provider requested a short HTTP retry"), { status: response.status, headers: response.headers });
          throw shortError;
        }
      }
      if (!response.ok || !response.body) return response;
      // Lazy pull, zero read-ahead: do not buffer or consume successful streams.
      const body = response.body;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const observed = new ReadableStream<Uint8Array>({
        async pull(controller) {
          reader ??= body.getReader();
          try {
            const result = await reader.read();
            if (result.done) { controller.close(); reader.releaseLock(); }
            else controller.enqueue(result.value);
          } catch (error) {
            observation.bodyFailure = !signal?.aborted;
            observation.cause = attributedCauseCode(error);
            controller.error(error);
            reader.releaseLock();
          }
        },
        cancel(reason) { return reader ? reader.cancel(reason) : body.cancel(reason); },
      }, { highWaterMark: 0 });
      const wrapped = new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
      return wrapped;
    };
    try {
      return await retryProviderRequest(request, { maxRetries, maxRetryDelayMs, ...(signal ? { signal } : {}) });
    } catch (error) {
      // Preserve the adapter's ordinary HTTP error formatting after short-policy
      // exhaustion. The driver must never re-run this short-policy failure.
      if (shortResponse && !signal?.aborted) {
        if (error !== shortError) observation.delayLimit = true;
        return shortResponse;
      }
      if (error instanceof TransportFailure) throw error.original;
      throw error;
    }
  };
  return { fetch, reset, snapshot: () => ({ ...observation }), sends: () => sends };
}
