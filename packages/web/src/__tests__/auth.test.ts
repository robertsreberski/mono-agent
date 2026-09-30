import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { bootstrapWebUser, hashWebPassword, verifyWebPassword, WEB_SESSION_TTL_MS, webSessionHash } from "../auth.js";
import type { WebAgentSummary } from "../contracts.js";
import { acquireWebStateLease, prepareWebStatePaths } from "../state-paths.js";
import { WebService } from "../service.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const roots: string[] = [];
const stores: WebStore[] = [];
const PASSWORD = "fictional-test-password";
const AGENT: WebAgentSummary = {
  sourceId: "agent-one", label: "Agent One", status: "online", health: "running",
  supportsAttachments: false, models: [], defaultModel: "provider/model", efforts: [],
  runSettings: { config: { model: "provider/model" }, override: null,
    effective: { model: "provider/model", modelSource: "config", effortSource: "config" } },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const root = await temporaryRoot("web-auth-");
  roots.push(root);
  return join(root, "state");
}
async function openStore(options: { stateDir?: string; clock?: () => Date } = {}): Promise<WebStore> {
  const store = await WebStore.open({ stateDir: await stateDir(), ...options });
  stores.push(store);
  return store;
}
function database(store: WebStore): DatabaseSync {
  // Inspect persistence, not the implementation's DTO, for hashing/backfill evidence.
  return (store as unknown as { database: DatabaseSync }).database;
}

describe("web authentication storage", () => {
  it("uses salted versioned scrypt records and a constant-length comparison", async () => {
    const first = await hashWebPassword(PASSWORD);
    const second = await hashWebPassword(PASSWORD);
    expect(first).toMatch(/^scrypt:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/u);
    expect(second).not.toBe(first);
    expect(first).not.toContain(PASSWORD);
    expect(await verifyWebPassword(PASSWORD, first)).toBe(true);
    expect(await verifyWebPassword("incorrect-password", first)).toBe(false);
    expect(await verifyWebPassword("x".repeat(1025), first)).toBe(false);
    await expect(verifyWebPassword(PASSWORD, "scrypt:2:invalid")).rejects.toMatchObject({ code: "storage_corrupt" });
    await expect(hashWebPassword("too-short")).rejects.toMatchObject({ status: 400 });
    await expect(hashWebPassword("😀".repeat(257))).rejects.toMatchObject({ status: 400 });
  });

  it("normalizes usernames, validates input and never exposes password records", async () => {
    const store = await openStore();
    const user = await store.auth.createUser({ username: " Avery ", displayName: "Avery", password: PASSWORD,
      role: "user", grants: ["agent-two", "agent-one", "agent-one"] });
    expect(user).toMatchObject({ username: "avery", displayName: "Avery", grants: ["agent-one", "agent-two"], disabled: false });
    expect(JSON.stringify(store.auth.listUsers())).not.toMatch(/password|scrypt/u);
    expect(database(store).prepare("SELECT password_record FROM web_users WHERE id = ?").get(user.id))
      .toMatchObject({ password_record: expect.stringMatching(/^scrypt:1:/u) });
    await expect(store.auth.createUser({ username: "AVERY", password: PASSWORD, role: "user" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(store.auth.createUser({ username: "invalid name", password: PASSWORD, role: "user" }))
      .rejects.toMatchObject({ status: 400 });
    expect(() => store.auth.patchUser(user.id, { displayName: "Avery\nAdmin" })).toThrow();
    expect(() => store.auth.patchUser(user.id, { grants: ["bad\u0000agent"] })).toThrow();
  });

  it("stores only token digests, expires sessions and persists them across reopen", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const directory = await stateDir();
    const store = await openStore({ stateDir: directory, clock: () => now });
    const user = await store.auth.bootstrap("Morgan", PASSWORD);
    const { token, principal } = await store.auth.login("MORGAN", PASSWORD, "browser-one");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(principal.id).toBe(user.id);
    const persisted = database(store).prepare("SELECT * FROM web_sessions").all();
    expect(persisted).toEqual([{ token_hash: webSessionHash(token), user_id: user.id,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + WEB_SESSION_TTL_MS).toISOString() }]);
    expect(JSON.stringify(persisted)).not.toContain(token);
    store.close();
    const reopened = await openStore({ stateDir: directory, clock: () => now });
    expect(reopened.auth.authenticate(token)?.id).toBe(user.id);
    expect(reopened.auth.authenticate("invalid")).toBeUndefined();
    now = new Date(now.getTime() + WEB_SESSION_TTL_MS);
    expect(reopened.auth.authenticate(token)).toBeUndefined();
    expect(reopened.auth.authenticateHash(principal.sessionHash)).toBeUndefined();
  });

  it("returns the same failure for nonexistent, incorrect-password and disabled accounts", async () => {
    const store = await openStore();
    const user = await store.auth.createUser({ username: "avery", password: PASSWORD, role: "user" });
    await expect(store.auth.login("unknown", PASSWORD, "one")).rejects.toMatchObject({ code: "login_failed", status: 401, message: "Invalid username or password." });
    await expect(store.auth.login("avery", "incorrect-password", "two")).rejects.toMatchObject({ code: "login_failed", status: 401, message: "Invalid username or password." });
    store.auth.patchUser(user.id, { disabled: true });
    await expect(store.auth.login("avery", PASSWORD, "three")).rejects.toMatchObject({ code: "login_failed", status: 401, message: "Invalid username or password." });
    expect(database(store).prepare("SELECT count(*) AS n FROM web_sessions").get()).toEqual({ n: 0 });
  });

  it("throttles rotating guesses by remote address and recovers after the bounded window", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = await openStore({ clock: () => now });
    await store.auth.bootstrap("morgan", PASSWORD);
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(store.auth.login(`unknown-${attempt}`, PASSWORD, "same-remote")).rejects.toMatchObject({ status: 401 });
    }
    await expect(store.auth.login("morgan", PASSWORD, "same-remote")).rejects.toMatchObject({ status: 429 });
    expect((await store.auth.login("morgan", PASSWORD, "different-remote")).principal.role).toBe("admin");
    now = new Date(now.getTime() + 60_001);
    expect((await store.auth.login("morgan", PASSWORD, "same-remote")).principal.role).toBe("admin");
  });

  it("revokes all sessions on password change/reset, disable and role/grant changes", async () => {
    const store = await openStore();
    await store.auth.bootstrap("morgan", PASSWORD);
    const user = await store.auth.createUser({ username: "avery", password: PASSWORD, role: "user" });
    const first = await store.auth.login("avery", PASSWORD, "one");
    const second = await store.auth.login("avery", PASSWORD, "two");
    await expect(store.auth.changePassword(user.id, "incorrect-password", "new-fictional-password"))
      .rejects.toMatchObject({ status: 403 });
    expect(store.auth.authenticate(first.token)?.id).toBe(user.id);
    await store.auth.changePassword(user.id, PASSWORD, "new-fictional-password");
    expect(store.auth.authenticate(first.token)).toBeUndefined();
    expect(store.auth.authenticate(second.token)).toBeUndefined();
    let session = await store.auth.login("avery", "new-fictional-password", "one");
    await store.auth.resetPassword(user.id, PASSWORD);
    expect(store.auth.authenticate(session.token)).toBeUndefined();
    for (const patch of [{ role: "admin" as const }, { grants: ["agent-one"] }, { disabled: true }]) {
      session = await store.auth.login("avery", PASSWORD, "one");
      store.auth.patchUser(user.id, patch);
      expect(store.auth.authenticate(session.token)).toBeUndefined();
    }
  });

  it("cannot disable or demote the last active admin", async () => {
    const store = await openStore();
    const admin = await store.auth.bootstrap("morgan", PASSWORD);
    expect(() => store.auth.patchUser(admin.id, { role: "user" })).toThrow("last active administrator");
    expect(() => store.auth.patchUser(admin.id, { disabled: true })).toThrow("last active administrator");
    const other = await store.auth.createUser({ username: "avery", password: PASSWORD, role: "admin" });
    store.auth.patchUser(other.id, { disabled: true });
    expect(() => store.auth.patchUser(admin.id, { disabled: true })).toThrow("last active administrator");
    store.auth.patchUser(other.id, { disabled: false });
    store.auth.patchUser(admin.id, { role: "user" });
    expect(store.auth.hasActiveAdmin()).toBe(true);
  });

  it("logout revokes only the named session", async () => {
    const store = await openStore();
    await store.auth.bootstrap("morgan", PASSWORD);
    const first = await store.auth.login("morgan", PASSWORD, "one");
    const second = await store.auth.login("morgan", PASSWORD, "two");
    store.auth.revokeSession(first.principal.sessionHash);
    expect(store.auth.authenticate(first.token)).toBeUndefined();
    expect(store.auth.authenticate(second.token)).toBeDefined();
  });

  it("backfills first-enable ownership once and covers later unattributed insertions", async () => {
    const store = await openStore();
    store.replaceAgents([AGENT]);
    const legacy = store.createThread(AGENT.sourceId);
    expect(database(store).prepare("SELECT owner_user_id, shared FROM threads WHERE id = ?").get(legacy.id))
      .toEqual({ owner_user_id: null, shared: 0 });
    expect(() => store.auth.initializeOwnership()).toThrow("Bootstrap an active web administrator");
    const bootstrap = await store.auth.bootstrap("morgan", PASSWORD);
    // Merely creating/recovering accounts is not first enablement.
    expect(database(store).prepare("SELECT owner_user_id FROM threads WHERE id = ?").get(legacy.id))
      .toEqual({ owner_user_id: null });
    store.auth.initializeOwnership();
    expect(database(store).prepare("SELECT owner_user_id, shared FROM threads WHERE id = ?").get(legacy.id))
      .toEqual({ owner_user_id: bootstrap.id, shared: 0 });
    const other = await store.auth.createUser({ username: "avery", password: PASSWORD, role: "user" });
    database(store).prepare("UPDATE threads SET owner_user_id = ?, shared = 1 WHERE id = ?").run(other.id, legacy.id);
    await store.auth.bootstrap("another-admin", PASSWORD);
    store.auth.initializeOwnership();
    expect(database(store).prepare("SELECT owner_user_id, shared FROM threads WHERE id = ?").get(legacy.id))
      .toEqual({ owner_user_id: other.id, shared: 1 });
    const automation = store.createThread(AGENT.sourceId);
    expect(database(store).prepare("SELECT owner_user_id, shared FROM threads WHERE id = ?").get(automation.id))
      .toEqual({ owner_user_id: bootstrap.id, shared: 0 });
    expect(store.auth.bootstrapAdminId()).toBe(bootstrap.id);
  });

  it("recovers an existing account without reassigning the designated bootstrap admin", async () => {
    const store = await openStore();
    const original = await store.auth.bootstrap("morgan", PASSWORD);
    const user = await store.auth.createUser({ username: "avery", password: PASSWORD, role: "user" });
    const { token } = await store.auth.login("avery", PASSWORD, "browser");
    store.auth.patchUser(user.id, { disabled: true });
    const recovered = await store.auth.bootstrap("AVERY", "recovered-fictional-password");
    expect(recovered).toMatchObject({ id: user.id, role: "admin", disabled: false });
    expect(store.auth.authenticate(token)).toBeUndefined();
    expect(store.auth.bootstrapAdminId()).toBe(original.id);
  });

  it("requires a bootstrap designation as well as an active admin for ownership initialization", async () => {
    const store = await openStore();
    await store.auth.createUser({ username: "morgan", password: PASSWORD, role: "admin" });
    expect(() => store.auth.initializeOwnership()).toThrow("Run web users bootstrap");
  });

  it("refuses offline bootstrap while the state lease is held and succeeds after release", async () => {
    const directory = await stateDir();
    const paths = await prepareWebStatePaths({ stateDir: directory });
    const lease = await acquireWebStateLease(paths);
    try {
      await expect(bootstrapWebUser({ stateDir: directory, username: "morgan", password: PASSWORD }))
        .rejects.toThrow("already");
    } finally { await lease.release(); }
    const user = await bootstrapWebUser({ stateDir: directory, username: "morgan", password: PASSWORD });
    const store = await openStore({ stateDir: directory });
    expect(store.auth.getUser(user.id)).toMatchObject({ role: "admin", disabled: false });
  });

  it.each([
    "DROP TRIGGER threads_default_web_owner",
    "DROP INDEX threads_by_owner",
    "DROP INDEX web_sessions_by_user",
    "DROP INDEX web_sessions_by_expiry",
    "DELETE FROM web_auth_state",
    "UPDATE web_auth_state SET initialized_at = '2026-01-01T00:00:00.000Z'",
  ])("rejects corrupt current-schema authentication storage (%s)", async (corruption) => {
    const directory = await stateDir();
    const store = await openStore({ stateDir: directory });
    database(store).exec(corruption);
    store.close();
    await expect(WebStore.open({ stateDir: directory })).rejects.toMatchObject({ code: "storage_corrupt", status: 500 });
  });

  it("keeps the enablement checkpoint fail-closed until route enforcement is installed", async () => {
    const directory = await stateDir();
    await expect(WebService.create({ stateDir: directory, multiUser: true })).rejects.toMatchObject({
      code: "multi_user_unavailable", status: 503,
    });
  });
});
