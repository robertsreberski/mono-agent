import { AsyncLocalStorage } from "node:async_hooks";

import type { WebUser } from "./auth.js";
import { WebConsoleError } from "./errors.js";

export interface WebThreadAccess {
  readonly sourceId: string;
  readonly ownerUserId: string | null;
  readonly shared: boolean;
}

export function webAgentAllowed(principal: WebUser, sourceId: string): boolean {
  return !principal.disabled && (principal.role === "admin" || principal.grants.includes(sourceId));
}

/** Administrator authority does not override conversation privacy. */
export function webThreadVisible(principal: WebUser, thread: WebThreadAccess): boolean {
  return webAgentAllowed(principal, thread.sourceId)
    && (thread.ownerUserId === principal.id || thread.shared);
}

/**
 * Request/initiating-actor scope, not global mutable service state. Internal
 * reconciliation runs outside this scope. Every enabled browser entry must
 * authenticate before entering it; deferred dispatch must revalidate its actor.
 */
export class WebAccessContext {
  private readonly context = new AsyncLocalStorage<WebUser | undefined>();

  current(): WebUser | undefined { return this.context.getStore(); }
  run<T>(principal: WebUser, operation: () => T): T { return this.context.run(principal, operation); }
  internal<T>(operation: () => T): T { return this.context.run(undefined, operation); }
  requirePrincipal(): WebUser {
    const principal = this.current();
    if (principal === undefined || principal.disabled) throw new WebConsoleError("authentication_required", "Log in to continue.", 401);
    return principal;
  }
  requireAdmin(): WebUser {
    const principal = this.requirePrincipal();
    if (principal.role !== "admin") throw new WebConsoleError("forbidden", "Administrator access is required.", 403);
    return principal;
  }
  agentAllowed(sourceId: string): boolean {
    const principal = this.current();
    return principal === undefined || webAgentAllowed(principal, sourceId);
  }
  threadVisible(thread: WebThreadAccess): boolean {
    const principal = this.current();
    return principal === undefined || webThreadVisible(principal, thread);
  }
  /** Source-owned aliases only. Scalar functions read this request's scope. */
  agentSql(alias: string): string {
    return this.current() === undefined ? "" : ` AND web_agent_allowed(${alias}.source_id) = 1`;
  }
  threadSql(alias: string): string {
    return this.current() === undefined ? "" : ` AND web_thread_visible(${alias}.source_id, ${alias}.owner_user_id, ${alias}.shared) = 1`;
  }
}
