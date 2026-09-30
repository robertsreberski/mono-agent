import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WebConsoleError } from "./errors.js";
import { acquireWebStateLease, prepareWebStatePaths, type WebStatePathOptions } from "./state-paths.js";
import type { WebStore } from "./store.js";

export type WebUserRole = "admin" | "user";
export interface WebUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: WebUserRole;
  readonly disabled: boolean;
  readonly version: number;
  readonly grants: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface WebPrincipal extends WebUser {
  readonly sessionHash: string;
  readonly expiresAt: string;
}
export interface CreateWebUserInput {
  readonly username: string;
  readonly displayName?: string;
  readonly password: string;
  readonly role: WebUserRole;
  readonly grants?: readonly string[];
}
export interface PatchWebUserInput {
  readonly displayName?: string;
  readonly role?: WebUserRole;
  readonly disabled?: boolean;
  readonly grants?: readonly string[];
}
interface UserRow {
  id: string; username: string; display_name: string; role: WebUserRole; disabled: number;
  version: number; password_record: string; created_at: string; updated_at: string;
}

export const WEB_SESSION_COOKIE = "mono_web_session";
export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
// Unknown users still perform the same expensive comparison. This is not a credential.
const DUMMY_PASSWORD_RECORD = `scrypt:1:${Buffer.alloc(16).toString("base64url")}:${Buffer.alloc(32).toString("base64url")}`;
const THROTTLE_WINDOW_MS = 60_000;
const MAX_THROTTLE_KEYS = 256;

function invalid(message: string): never { throw new WebConsoleError("invalid_auth_input", message, 400); }
export function normalizeWebUsername(value: string): string {
  if (typeof value !== "string") invalid("Invalid username.");
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(username)) invalid("Username must be 1–64 ASCII letters, digits, dots, underscores or hyphens.");
  return username;
}
function displayName(value: string): string {
  if (typeof value !== "string") invalid("Invalid display name.");
  const name = value.trim();
  if ([...name].length < 1 || [...name].length > 64 || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e]/u.test(name)) invalid("Display name must be 1–64 characters on one line.");
  return name;
}
function role(value: WebUserRole): WebUserRole {
  if (value !== "admin" && value !== "user") invalid("Invalid role.");
  return value;
}
function grants(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 1024 || value.some((id) => typeof id !== "string" || id.length < 1 || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id))) invalid("Invalid agent grants.");
  return [...new Set(value)].sort();
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashWebPassword(password: string): Promise<string> {
  if (typeof password !== "string" || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024) invalid("Password must be 12–1024 UTF-8 bytes.");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt:1:${salt.toString("base64url")}:${key.toString("base64url")}`;
}
export async function verifyWebPassword(password: string, record: string): Promise<boolean> {
  if (typeof password !== "string" || Buffer.byteLength(password) > 1024) return false;
  const pieces = /^scrypt:1:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/u.exec(record);
  if (pieces === null) throw new WebConsoleError("storage_corrupt", "Invalid web password record.", 500);
  const expected = Buffer.from(pieces[2]!, "base64url");
  return timingSafeEqual(await derive(password, Buffer.from(pieces[1]!, "base64url")), expected);
}
export function webSessionHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

/** Uses the WebStore's connection, clock and transaction boundary; never opens a second auth database. */
export class WebAuthStore {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private inFlightLogins = 0;
  constructor(private readonly database: DatabaseSync, private readonly clock: () => Date,
    private readonly transaction: <T>(operation: () => T) => T) {}

  private row(id: string): UserRow {
    const row = this.database.prepare("SELECT * FROM web_users WHERE id = ?").get(id) as unknown as UserRow | undefined;
    if (row === undefined) throw new WebConsoleError("user_not_found", "User not found.", 404);
    return row;
  }
  private project(row: UserRow): WebUser {
    const assigned = this.database.prepare("SELECT source_id FROM web_user_agent_grants WHERE user_id = ? ORDER BY source_id").all(row.id) as Array<{ source_id: string }>;
    return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, disabled: row.disabled === 1,
      version: row.version, grants: assigned.map((item) => item.source_id), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  getUser(id: string): WebUser { return this.project(this.row(id)); }
  listUsers(): WebUser[] { return (this.database.prepare("SELECT * FROM web_users ORDER BY username").all() as unknown as UserRow[]).map((row) => this.project(row)); }
  hasActiveAdmin(): boolean { return this.database.prepare("SELECT 1 FROM web_users WHERE role = 'admin' AND disabled = 0 LIMIT 1").get() !== undefined; }
  bootstrapAdminId(): string | undefined {
    return (this.database.prepare("SELECT bootstrap_admin_id FROM web_auth_state WHERE id = 1").get() as { bootstrap_admin_id: string | null }).bootstrap_admin_id ?? undefined;
  }
  /** First enable only: recovery and later enablement never steal existing ownership. */
  initializeOwnership(): void {
    this.transaction(() => {
      if (!this.hasActiveAdmin()) throw new WebConsoleError("web_admin_required", "Bootstrap an active web administrator before enabling multi-user mode.", 409);
      const state = this.database.prepare("SELECT * FROM web_auth_state WHERE id = 1").get() as { bootstrap_admin_id: string | null; initialized_at: string | null };
      if (state.bootstrap_admin_id === null) throw new WebConsoleError("web_admin_required", "Run web users bootstrap before enabling multi-user mode.", 409);
      const designated = this.getUser(state.bootstrap_admin_id);
      if (designated.disabled || designated.role !== "admin") {
        throw new WebConsoleError("web_admin_required", "Recover the designated bootstrap administrator before enabling multi-user mode.", 409);
      }
      if (state.initialized_at !== null) return;
      this.database.prepare("UPDATE threads SET owner_user_id = ?, shared = 0 WHERE owner_user_id IS NULL").run(state.bootstrap_admin_id);
      this.database.prepare("UPDATE wake_schedules SET editor_user_id = ? WHERE editor_user_id IS NULL").run(state.bootstrap_admin_id);
      this.database.prepare("UPDATE web_auth_state SET initialized_at = ? WHERE id = 1").run(this.clock().toISOString());
    });
  }
  private assignGrants(id: string, assigned: readonly string[]): void {
    this.database.prepare("DELETE FROM web_user_agent_grants WHERE user_id = ?").run(id);
    const insert = this.database.prepare("INSERT INTO web_user_agent_grants(user_id, source_id) VALUES (?, ?)");
    for (const sourceId of assigned) insert.run(id, sourceId);
  }
  async createUser(input: CreateWebUserInput, authorizeWrite?: () => void): Promise<WebUser> {
    const username = normalizeWebUsername(input.username);
    const name = displayName(input.displayName ?? username);
    const assigned = grants(input.grants ?? []);
    const userRole = role(input.role);
    const password = await hashWebPassword(input.password);
    return this.transaction(() => {
      authorizeWrite?.();
      if (this.database.prepare("SELECT 1 FROM web_users WHERE username = ?").get(username) !== undefined) throw new WebConsoleError("username_conflict", "Username is already in use.", 409);
      const id = randomUUID(); const now = this.clock().toISOString();
      this.database.prepare("INSERT INTO web_users(id, username, display_name, role, password_record, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, username, name, userRole, password, now, now);
      this.assignGrants(id, assigned);
      return this.getUser(id);
    });
  }
  /** Offline recovery grants admin status, enables the named account and revokes its sessions. */
  async bootstrap(usernameInput: string, password: string): Promise<WebUser> {
    const username = normalizeWebUsername(usernameInput);
    const record = await hashWebPassword(password);
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT id FROM web_users WHERE username = ?").get(username) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID(); const now = this.clock().toISOString();
      if (existing === undefined) this.database.prepare("INSERT INTO web_users(id, username, display_name, role, password_record, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)").run(id, username, username, record, now, now);
      else this.database.prepare("UPDATE web_users SET role = 'admin', disabled = 0, password_record = ?, version = version + 1, updated_at = ? WHERE id = ?").run(record, now, id);
      this.revokeUserSessions(id);
      this.database.prepare("UPDATE web_auth_state SET bootstrap_admin_id = COALESCE(bootstrap_admin_id, ?) WHERE id = 1").run(id);
      return this.getUser(id);
    });
  }
  patchUser(id: string, patch: PatchWebUserInput): WebUser {
    const name = patch.displayName === undefined ? undefined : displayName(patch.displayName);
    const assigned = patch.grants === undefined ? undefined : grants(patch.grants);
    const userRole = patch.role === undefined ? undefined : role(patch.role);
    if (patch.disabled !== undefined && typeof patch.disabled !== "boolean") invalid("Invalid disabled state.");
    return this.transaction(() => {
      const before = this.row(id);
      if (before.role === "admin" && before.disabled === 0 && (userRole === "user" || patch.disabled === true)
        && (this.database.prepare("SELECT count(*) AS count FROM web_users WHERE role = 'admin' AND disabled = 0").get() as { count: number }).count <= 1) {
        throw new WebConsoleError("last_active_admin", "Cannot disable or demote the last active administrator.", 409);
      }
      this.database.prepare("UPDATE web_users SET display_name = ?, role = ?, disabled = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(name ?? before.display_name, userRole ?? before.role, patch.disabled === undefined ? before.disabled : Number(patch.disabled), this.clock().toISOString(), id);
      if (assigned !== undefined) this.assignGrants(id, assigned);
      this.revokeUserSessions(id);
      return this.getUser(id);
    });
  }
  async resetPassword(id: string, password: string, authorizeWrite?: () => void): Promise<void> {
    const record = await hashWebPassword(password);
    this.transaction(() => { authorizeWrite?.(); this.row(id); this.writePassword(id, record); });
  }
  async changePassword(id: string, current: string, password: string, authorizeWrite?: () => void): Promise<void> {
    const before = this.row(id);
    if (!await verifyWebPassword(current, before.password_record)) throw new WebConsoleError("invalid_password", "Current password is incorrect.", 403);
    const record = await hashWebPassword(password);
    this.transaction(() => {
      authorizeWrite?.();
      const latest = this.row(id);
      if (latest.version !== before.version || latest.disabled === 1) throw new WebConsoleError("auth_changed", "Account changed; authenticate again.", 401);
      this.writePassword(id, record);
    });
  }
  private writePassword(id: string, record: string): void {
    this.database.prepare("UPDATE web_users SET password_record = ?, version = version + 1, updated_at = ? WHERE id = ?").run(record, this.clock().toISOString(), id);
    this.revokeUserSessions(id);
  }
  private readonly invalidationListeners = new Set<(userId?: string, sessionHash?: string) => void>();
  subscribeInvalidation(listener: (userId?: string, sessionHash?: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }
  private invalidate(userId?: string, sessionHash?: string): void {
    for (const listener of [...this.invalidationListeners]) {
      try { listener(userId, sessionHash); } catch { this.invalidationListeners.delete(listener); }
    }
  }
  revokeUserSessions(id: string): void {
    this.database.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(id);
    this.invalidate(id);
  }
  revokeSession(hash: string): void {
    this.database.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(hash);
    this.invalidate(undefined, hash);
  }
  authenticate(token: string | undefined): WebPrincipal | undefined {
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    return this.authenticateHash(webSessionHash(token));
  }
  authenticateHash(hash: string): WebPrincipal | undefined {
    const session = this.database.prepare("SELECT user_id, expires_at FROM web_sessions WHERE token_hash = ? AND expires_at > ?").get(hash, this.clock().toISOString()) as { user_id: string; expires_at: string } | undefined;
    if (session === undefined) return undefined;
    const user = this.getUser(session.user_id);
    if (user.disabled) return undefined;
    return { ...user, sessionHash: hash, expiresAt: session.expires_at };
  }
  async login(usernameInput: string, password: string, remoteKey: string): Promise<{ token: string; principal: WebPrincipal }> {
    const now = this.clock().getTime();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    // IP-only accounting cannot be bypassed by rotating a guessed username. Bound memory and concurrent scrypt work.
    const key = webSessionHash(remoteKey);
    const attempt = this.attempts.get(key);
    if (this.inFlightLogins >= 4 || (attempt?.count ?? 0) >= 5 || (attempt === undefined && this.attempts.size >= MAX_THROTTLE_KEYS)) {
      throw new WebConsoleError("login_throttled", "Unable to log in; try again later.", 429);
    }
    this.attempts.set(key, { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? now + THROTTLE_WINDOW_MS });
    let username: string;
    try { username = normalizeWebUsername(usernameInput); } catch { username = ""; }
    const before = this.database.prepare("SELECT * FROM web_users WHERE username = ?").get(username) as unknown as UserRow | undefined;
    this.inFlightLogins += 1;
    let valid: boolean;
    try { valid = await verifyWebPassword(password, before?.password_record ?? DUMMY_PASSWORD_RECORD); }
    finally { this.inFlightLogins -= 1; }
    if (!valid || before === undefined || before.disabled === 1) throw new WebConsoleError("login_failed", "Invalid username or password.", 401);
    return this.transaction(() => {
      const latest = this.row(before.id);
      if (latest.version !== before.version || latest.disabled === 1) throw new WebConsoleError("login_failed", "Invalid username or password.", 401);
      this.attempts.delete(key);
      this.database.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(this.clock().toISOString());
      const token = randomBytes(32).toString("base64url"); const hash = webSessionHash(token);
      const createdAt = this.clock().toISOString(); const expiresAt = new Date(this.clock().getTime() + WEB_SESSION_TTL_MS).toISOString();
      this.database.prepare("INSERT INTO web_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hash, before.id, createdAt, expiresAt);
      return { token, principal: { ...this.getUser(before.id), sessionHash: hash, expiresAt } };
    });
  }
}

export interface BootstrapWebUserOptions extends WebStatePathOptions { readonly username: string; readonly password: string }
/** Offline only. The same exclusive state lease protects bootstrap/recovery and the running server. */
export async function bootstrapWebUser(options: BootstrapWebUserOptions): Promise<WebUser> {
  const paths = await prepareWebStatePaths(options);
  const lease = await acquireWebStateLease(paths);
  let store: WebStore | undefined;
  try {
    const { WebStore: Store } = await import("./store.js");
    store = await Store.openPrepared(paths);
    return await store.auth.bootstrap(options.username, options.password);
  } finally { store?.close(); await lease.release(); }
}
