/**
 * Fail-closed host-binding helpers shared by HTTP-serving adapters and
 * operator surfaces. Single-sourcing
 * {@link isLoopbackHost} and {@link assertSafeBind} closes the drift where the
 * loopback predicate had been re-implemented (weaker) in several places and the
 * safe-bind guard was missing entirely in others.
 */
import type { Server } from "node:http";
import { isIP, type AddressInfo } from "node:net";

/**
 * True only when the host is an exact loopback literal (or the exact conventional
 * `localhost` name). Hostname prefixes such as `127.attacker.example` are never
 * treated as loopback. Bracketed IPv6 and IPv4-mapped IPv6 literals are
 * normalized before classification.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostForBind(host).toLowerCase();
  if (normalized === "localhost") {
    return true;
  }
  const family = isIP(normalized);
  if (family === 4) {
    return normalized.split(".")[0] === "127";
  }
  if (family !== 6) {
    return false;
  }
  const canonical = canonicalIpv6(normalized);
  if (canonical === "::1") {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  if (mapped === null) {
    return false;
  }
  const highWord = Number.parseInt(mapped[1] ?? "", 16);
  return Number.isInteger(highWord) && (highWord >>> 8) === 127;
}

/** Remove URL-only brackets from an IPv6 bind host. Mismatched brackets remain invalid. */
export function normalizeHostForBind(host: string): string {
  if (host.startsWith("[") && host.endsWith("]") && host.length > 2) {
    const inner = host.slice(1, -1);
    return isIP(inner) === 6 ? inner : host;
  }
  return host;
}

/** True for the IPv4 and IPv6 unspecified addresses used to bind all interfaces. */
export function isWildcardHost(host: string): boolean {
  const normalized = normalizeHostForBind(host).toLowerCase();
  if (normalized === "0.0.0.0") {
    return true;
  }
  if (isIP(normalized) !== 6) {
    return false;
  }
  const canonical = canonicalIpv6(normalized);
  if (canonical === "::") {
    return true;
  }
  // Node normalizes the IPv4-mapped unspecified address to an IPv6 wildcard
  // bind on supported dual-stack hosts. Treat it as wildcard before building
  // client URLs so an unspecified address is never advertised as a target.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  return mapped !== null
    && Number.parseInt(mapped[1] ?? "", 16) === 0
    && Number.parseInt(mapped[2] ?? "", 16) === 0;
}

/** Wrap a bare IPv6 host in brackets so it is safe to embed in a URL. */
export function hostForUrl(host: string): string {
  const normalized = normalizeHostForBind(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function canonicalIpv6(host: string): string {
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    return host;
  }
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
