/**
 * Fail-closed host-binding helpers shared by HTTP-serving adapters and
 * operator surfaces. Single-sourcing
 * {@link isLoopbackHost} and {@link assertSafeBind} closes the drift where the
 * loopback predicate had been re-implemented (weaker) in several places and the
 * safe-bind guard was missing entirely in others.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * True when the host is a loopback address. Matches `localhost`, `127.0.0.1`,
 * `::1`, the full `127.0.0.0/8` range, and bracketed IPv6 forms.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

/** Wrap a bare IPv6 host in brackets so it is safe to embed in a URL. */
export function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Refuse to bind a non-loopback host unless explicitly allowed. The caller
 * supplies the typed error so each adapter keeps its own error code/message.
 */
export function assertSafeBind(
  host: string,
  allowNonLoopback: boolean,
  onUnsafe: (host: string) => Error,
): void {
  if (allowNonLoopback || isLoopbackHost(host)) {
    return;
  }
  throw onUnsafe(host);
}

export interface ListenErrorFactories {
  /** Build the error raised when the underlying server emits a listen error. */
  readonly listenFailed: (reason: string) => Error;
  /** Build the error raised when no TCP address is available after listen. */
  readonly noAddress: () => Error;
}

/** Promisified `server.listen` that resolves with the bound TCP address. */
export function listen(
  server: Server,
  port: number,
  host: string,
  errors: ListenErrorFactories,
): Promise<AddressInfo> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      rejectPromise(errors.listenFailed(error.message));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        rejectPromise(errors.noAddress());
        return;
      }
      resolvePromise(address);
    });
  });
}

/** Promisified `server.close`. */
export function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
        return;
      }
      rejectPromise(error);
    });
  });
}
