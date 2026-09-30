import type { WebPrincipal } from "./auth.js";
import type { WebEvent } from "./contracts.js";
import type { WebService } from "./service.js";

/** The same boundary serves initial ready and all subsequent live events. */
export function subscribeWebRecipient(service: WebService, session: WebPrincipal,
  write: (event: WebEvent) => boolean | void, onClose: () => void): { send(event: WebEvent): boolean; close(): void } {
  let closed = false;
  let sequence = 0;
  let unsubscribe = (): void => {};
  let unwatch = (): void => {};
  let expiry: ReturnType<typeof setInterval> | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe(); unwatch(); clearInterval(expiry);
    onClose();
  };
  const current = () => {
    const principal = service.store.auth.authenticateHash(session.sessionHash);
    if (principal === undefined || principal.id !== session.id || principal.version !== session.version) { close(); return undefined; }
    return principal;
  };
  const send = (event: WebEvent): boolean => {
    if (closed) return false;
    try {
      const principal = current();
      if (principal === undefined) return false;
      const projected = service.store.access.run(principal, () => service.projectEvent(event));
      // Global sequence gaps would reveal counts of hidden events.
      if (projected !== undefined && write({ ...projected, id: `${Date.now()}-${++sequence}` }) === false) close();
    } catch { close(); }
    return !closed;
  };
  unsubscribe = service.subscribe(send);
  unwatch = service.store.auth.subscribeInvalidation((userId, hash) => {
    if (userId === session.id || hash === session.sessionHash) close();
  });
  // No private event is needed to discover expiry on an otherwise idle stream.
  expiry = setInterval(() => {
    if (closed) return;
    try { current(); } catch { close(); }
  }, 1000);
  expiry.unref();
  return { send, close };
}
