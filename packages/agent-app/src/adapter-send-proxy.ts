import { isIP } from "node:net";

import {
  Agent,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from "undici";

interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?: (type: "abort", listener: () => void, options?: { readonly once?: boolean }) => void;
  removeEventListener?: (type: "abort", listener: () => void) => void;
}

type FetchInitWithNodeOptions = RequestInit & {
  readonly agent?: unknown;
  readonly compress?: boolean;
  readonly body?: unknown;
  readonly duplex?: "half";
  readonly signal?: AbortSignalLike | null;
};

export interface AdapterSendProxy {
  readonly fetchImpl: typeof fetch;
  close(): Promise<void>;
  destroy(error?: Error): Promise<void>;
}

export interface AdapterSendProxyOptions {
  /** Explicit configured endpoints that may need SRT's coarse loopback capability. */
  readonly directLoopbackUrls?: readonly string[];
}

export function safeAdapterSendProxyErrorMessage(
  error: unknown,
  env: Record<string, string | undefined> = process.env,
): string {
  let message = error instanceof Error ? error.message : String(error);
  // Redact the exact environment values first. This also covers malformed
  // proxy strings that cannot be recognized as URLs.
  for (const name of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"] as const) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      message = message.split(value).join("[redacted-proxy]");
    }
  }
  return message
    // URL userinfo is the normal shape of SRT's authenticated proxy secret.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[redacted]@")
    // Defense in depth for diagnostics that spell the header rather than URL.
    .replace(/(proxy-authorization\s*[:=]\s*)(?:\S+\s+)?\S+/giu, "$1[redacted]");
}

/**
 * Build the adapter-send child's HTTP transport from its inherited proxy
 * environment. The parent MCP spec deliberately does not copy these values:
 * credentials stay in process environment state and never enter the serialized
 * runtime/tool configuration.
 */
export function createAdapterSendProxy(
  env: Record<string, string | undefined> = process.env,
  options: AdapterSendProxyOptions = {},
): AdapterSendProxy | undefined {
  const httpProxy = proxyEnvValue(env.http_proxy) ?? proxyEnvValue(env.HTTP_PROXY);
  const httpsProxy = proxyEnvValue(env.https_proxy) ?? proxyEnvValue(env.HTTPS_PROXY);
  if (httpProxy === undefined && httpsProxy === undefined) {
    return undefined;
  }

  const noProxy = normalizeNoProxyValue(env.no_proxy ?? env.NO_PROXY);
  const proxyDispatcher = new EnvHttpProxyAgent({
    // Empty values prevent EnvHttpProxyAgent from consulting ambient process.env
    // when a caller supplies an explicit environment snapshot (notably tests).
    httpProxy: httpProxy ?? "",
    httpsProxy: httpsProxy ?? "",
    noProxy,
  });
  const directLoopbackHosts = collectDirectLoopbackHosts(options.directLoopbackUrls ?? []);
  const directDispatcher = directLoopbackHosts.size === 0 ? undefined : new Agent();
  let closePromise: Promise<void> | undefined;
  let destroyPromise: Promise<void> | undefined;

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const { requestInit, detachAbortListener } = adaptFetchInit(init);
    try {
      return await undiciFetch(input as UndiciRequestInfo, {
        ...requestInit,
        dispatcher: shouldUseDirectLoopback(input, directLoopbackHosts)
          ? (directDispatcher ?? proxyDispatcher)
          : proxyDispatcher,
      }) as unknown as Response;
    } finally {
      detachAbortListener();
    }
  }) as typeof fetch;

  return {
    fetchImpl,
    close(): Promise<void> {
      return closePromise ??= Promise.all([
        proxyDispatcher.close(),
        ...(directDispatcher === undefined ? [] : [directDispatcher.close()]),
      ]).then(() => undefined);
    },
    destroy(error?: Error): Promise<void> {
      return destroyPromise ??= Promise.all([
        error === undefined ? proxyDispatcher.destroy() : proxyDispatcher.destroy(error),
        ...(directDispatcher === undefined
          ? []
          : [error === undefined ? directDispatcher.destroy() : directDispatcher.destroy(error)]),
      ]).then(() => undefined);
    },
  };
}

function normalizeNoProxyValue(value: string | undefined): string {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // SRT 0.0.64 emits bare ::1, while Undici 8 expects the bracketed URL-host
  // spelling. Preserve SRT's list and add the compatible equivalent.
  if (entries.includes("::1") && !entries.includes("[::1]")) entries.push("[::1]");
  return entries.join(",");
}

function collectDirectLoopbackHosts(urls: readonly string[]): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const value of urls) {
    try {
      const host = stripIpv6Brackets(new URL(value).hostname.toLowerCase());
      if (isLoopbackHost(host)) hosts.add(host);
    } catch {
      // The config loader owns URL diagnostics; an invalid endpoint must not
      // accidentally become a direct-routing exception here.
    }
  }
  return hosts;
}

function shouldUseDirectLoopback(
  input: Parameters<typeof fetch>[0],
  directLoopbackHosts: ReadonlySet<string>,
): boolean {
  if (directLoopbackHosts.size === 0) return false;
  try {
    const value = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    const host = stripIpv6Brackets(new URL(value).hostname.toLowerCase());
    return directLoopbackHosts.has(host);
  } catch {
    return false;
  }
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.split(".")[0] === "127");
}

function adaptFetchInit(init: RequestInit | undefined): {
  readonly requestInit: UndiciRequestInit;
  readonly detachAbortListener: () => void;
} {
  const {
    // grammY's Node fetch configuration includes these node-fetch-only fields.
    // undici owns proxying through `dispatcher`, so forwarding `agent` would be
    // both incompatible and ambiguous.
    agent: _agent,
    compress: _compress,
    signal,
    ...rest
  } = (init ?? {}) as FetchInitWithNodeOptions;
  const normalized = normalizeAbortSignal(signal);
  const body = rest.body;
  const requestInit = {
    ...rest,
    ...(normalized.signal === undefined ? {} : { signal: normalized.signal }),
    ...(isStreamingBody(body) && rest.duplex === undefined ? { duplex: "half" as const } : {}),
  } as unknown as UndiciRequestInit;
  return { requestInit, detachAbortListener: normalized.detach };
}

function normalizeAbortSignal(signal: AbortSignalLike | null | undefined): {
  readonly signal?: AbortSignal;
  readonly detach: () => void;
} {
  if (signal === null || signal === undefined) {
    return { detach: () => {} };
  }
  if (signal instanceof AbortSignal) {
    return { signal, detach: () => {} };
  }

  // grammY uses an abort-controller shim whose signal is EventTarget-like but
  // fails undici's native AbortSignal Web IDL conversion on Node 22. Mirror it
  // into a native controller for the lifetime of this request.
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(signal.reason);
  };
  if (signal.aborted) {
    abort();
    return { signal: controller.signal, detach: () => {} };
  }
  signal.addEventListener?.("abort", abort, { once: true });
  return {
    signal: controller.signal,
    detach: () => {
      signal.removeEventListener?.("abort", abort);
    },
  };
}

function isStreamingBody(body: unknown): boolean {
  if (body === null || body === undefined || typeof body !== "object") {
    return false;
  }
  const candidate = body as {
    readonly pipe?: unknown;
    readonly getReader?: unknown;
    readonly [Symbol.asyncIterator]?: unknown;
  };
  return typeof candidate[Symbol.asyncIterator] === "function"
    || typeof candidate.pipe === "function"
    || typeof candidate.getReader === "function";
}

function proxyEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) return undefined;
  try {
    const url = new URL(normalized);
    // Managed SRT advertises its authenticated policy proxy on localhost, but
    // an external-only sandbox need not make hostname resolution available.
    // The proxy itself is IPv4 loopback; use its numeric spelling without
    // changing credentials, port, path, or any destination/NO_PROXY policy.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    return url.href;
  } catch {
    // Preserve Undici's authoritative invalid-proxy diagnostic.
    return normalized;
  }
}
