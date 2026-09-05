import {
  fetch as undiciFetch,
  getGlobalDispatcher,
  type Dispatcher,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from "undici";

type ParserTimeoutOverrides = Readonly<Pick<
  Dispatcher.DispatchOptions,
  "bodyTimeout"
>>;

function fetchWithParserTimeoutOverrides(
  overrides: ParserTimeoutOverrides,
): typeof globalThis.fetch {
  return async (input, init) => {
    // Preserve the selected global dispatcher while removing only the body
    // inactivity deadline from the intentionally long-lived turn stream.
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
