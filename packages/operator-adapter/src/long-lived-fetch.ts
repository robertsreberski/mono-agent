import {
  fetch as undiciFetch,
  getGlobalDispatcher,
  type Dispatcher,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from "undici";

type ParserTimeoutOverrides = Readonly<Pick<
  Dispatcher.DispatchOptions,
  "bodyTimeout" | "headersTimeout"
>>;

function fetchWithParserTimeoutOverrides(
  overrides: ParserTimeoutOverrides,
): typeof globalThis.fetch {
  return async (input, init) => {
    // Preserve the process-wide dispatcher (including any operator-owned proxy
    // or routing policy) and override only the parser timers for this request.
    const dispatcher = getGlobalDispatcher().compose(
      (dispatch) => (options, handler) => dispatch({ ...options, ...overrides }, handler),
    );
    return await undiciFetch(
      input as UndiciRequestInfo,
      {
        ...(init as UndiciRequestInit | undefined),
        dispatcher,
      },
    ) as unknown as globalThis.Response;
  };
}

/** A streamed turn may remain silent while a no-expiry interaction is pending. */
export const fetchLongLivedTurn = fetchWithParserTimeoutOverrides({
  bodyTimeout: 0,
});

/** Host-wake delivery is bounded by its explicit AbortSignal, not parser defaults. */
export const fetchLongLivedHostWake = fetchWithParserTimeoutOverrides({
  bodyTimeout: 0,
  headersTimeout: 0,
});
