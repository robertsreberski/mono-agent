import { createECDH } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";

import type { WebAgentSummary } from "../contracts.js";
import { webPushPreview } from "../push-preview.js";
import {
  generateWebPushIdentity,
  validateWebPushEndpoint,
  validateWebPushKeys,
  webPushPayload,
  webPushUrgency,
  WebPushDispatcher,
} from "../push.js";
import { WebStore, type ClaimedWebPushDelivery } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

const agent: WebAgentSummary = {
  sourceId: "agent-one",
  label: "Agent One",
  status: "online",
  supportsAttachments: true,
  updatedAt: "2026-08-13T08:00:00.000Z",
};

async function storeAt(clock: () => Date): Promise<WebStore> {
  const root = await temporaryRoot();
  cleanup.push(root);
  const store = await WebStore.open({ stateDir: join(root, "state"), clock });
  store.replaceAgents([agent]);
  return store;
}

function subscriptionInput(fingerprint: string, endpoint = "https://push.example.test/send/opaque") {
  const key = Buffer.alloc(65);
  key[0] = 4;
  return {
    endpoint,
    p256dh: key.toString("base64url"),
    auth: Buffer.alloc(16, 7).toString("base64url"),
    siteOrigin: "https://console.example.test",
    keyFingerprint: fingerprint,
  };
}

function deliveryStatus(store: WebStore, eventId: string): string | undefined {
  const database = new DatabaseSync(store.paths.database, { readOnly: true });
  try {
    return (database.prepare("SELECT status FROM push_deliveries WHERE event_id = ?").get(eventId) as { status?: string } | undefined)?.status;
  } finally {
    database.close();
  }
}

function deliveryRecord(store: WebStore, eventId: string): {
  readonly status: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
} | undefined {
  const database = new DatabaseSync(store.paths.database, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT status, attempts, next_attempt_at FROM push_deliveries WHERE event_id = ?
    `).get(eventId) as { status: string; attempts: number; next_attempt_at: string } | undefined;
    return row === undefined ? undefined : {
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
    };
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for push state.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

describe("Web Push safety and persistence", () => {
  it("persists one VAPID identity and fails closed on partial state", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const first = store.ensureWebPushIdentity(generateWebPushIdentity);
    const second = store.ensureWebPushIdentity(() => {
      throw new Error("must not regenerate");
    });
    expect(second).toEqual(first);
    const path = store.paths.database;
    store.close();

    const database = new DatabaseSync(path);
    database.prepare("UPDATE settings SET value = ? WHERE key = 'web_push_private_key'")
      .run(generateWebPushIdentity().privateKey);
    database.close();
    const mismatched = await WebStore.open({ stateDir: join(path, ".."), clock: now });
    expect(() => mismatched.ensureWebPushIdentity(generateWebPushIdentity))
      .toThrowError(expect.objectContaining({ code: "web_push_identity_corrupt" }));
    mismatched.close();

    const partialDatabase = new DatabaseSync(path);
    partialDatabase.prepare("DELETE FROM settings WHERE key = 'web_push_private_key'").run();
    partialDatabase.close();
    const corrupted = await WebStore.open({ stateDir: join(path, ".."), clock: now });
    expect(() => corrupted.ensureWebPushIdentity(generateWebPushIdentity))
      .toThrowError(expect.objectContaining({ code: "web_push_identity_corrupt" }));
    corrupted.close();
  });

  it("rejects malformed VAPID key material and caps reactivated subscriptions", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const malformedStore = await storeAt(now);
    expect(() => malformedStore.ensureWebPushIdentity(() => ({
      publicKey: "A".repeat(43),
      privateKey: "B".repeat(43),
    }))).toThrowError(expect.objectContaining({ code: "web_push_identity_generation_failed" }));
    malformedStore.close();

    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const subscriptions = Array.from({ length: 32 }, (_, index) => store.registerWebPushSubscription({
      ...subscriptionInput(identity.fingerprint),
      endpoint: `https://push.example.test/send/${String(index)}`,
    }));
    store.disableWebPushSubscription(subscriptions[0]!.id);
    store.registerWebPushSubscription({
      ...subscriptionInput(identity.fingerprint),
      endpoint: "https://push.example.test/send/replacement",
    });
    expect(() => store.registerWebPushSubscription({
      ...subscriptionInput(identity.fingerprint),
      endpoint: "https://push.example.test/send/0",
    })).toThrowError(expect.objectContaining({ code: "push_subscription_limit" }));
    store.close();
  });

  it("atomically replaces a rotated subscription without leaking an active slot", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const oldEndpoint = "https://push.example.test/send/old";
    const old = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint, oldEndpoint));
    for (let index = 0; index < 31; index += 1) {
      store.registerWebPushSubscription(subscriptionInput(
        identity.fingerprint,
        `https://push.example.test/send/filler-${String(index)}`,
      ));
    }

    const replacement = store.registerWebPushSubscription({
      ...subscriptionInput(identity.fingerprint, "https://push.example.test/send/new"),
      previousEndpoint: oldEndpoint,
    });
    expect(store.getWebPushSubscription(old.id)).toMatchObject({
      state: "expired",
      lastErrorCode: "subscription_rotated",
    });
    expect(replacement).toMatchObject({ state: "active" });
    const database = new DatabaseSync(store.paths.database, { readOnly: true });
    const active = database.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE state = 'active'")
      .get() as { count: number };
    database.close();
    expect(active.count).toBe(32);
    store.close();
  });

  it("does not backfill old turns and suppresses only an unattempted pending delivery", async () => {
    let instant = new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(() => instant);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const oldThread = store.createThread("agent-one");
    const oldTurn = store.beginTurn({ threadId: oldThread.id, text: "old", attachmentIds: [] });
    store.completeTurn(oldTurn.turnId, "Old response");
    expect(store.webPushEventByLogicalKey(`turn:${oldTurn.turnId}:terminal`)).toBeUndefined();

    const subscription = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint));
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "new", attachmentIds: [] });
    store.completeTurn(turn.turnId, "# Done\nUse [the console](https://example.test). token=secret-value");
    const event = store.webPushEventByLogicalKey(`turn:${turn.turnId}:terminal`);
    expect(event).toMatchObject({ kind: "response.ready", body: "Done Use the console. token=[redacted]" });
    expect(store.acknowledgeWebPushEvent(event!.id, subscription.id)).toBe(true);
    instant = new Date("2026-08-13T08:00:10.000Z");
    expect(store.claimDueWebPushDeliveries(4)).toEqual([]);

    const retryEvent = store.enqueueWebPushEvent({
      logicalKey: "retry-race",
      kind: "run.failed",
      threadId: thread.id,
      title: "Failed",
      body: "Failure",
      expiresAt: "2026-08-13T09:00:00.000Z",
      notBefore: instant.toISOString(),
    });
    expect(store.claimDueWebPushDeliveries(1)).toHaveLength(1);
    expect(store.acknowledgeWebPushEvent(retryEvent!.id, subscription.id)).toBe(false);
    store.close();
  });

  it("validates public DNS endpoints and subscription key material", async () => {
    await expect(validateWebPushEndpoint("https://push.example.test/send", async () => [
      { address: "203.0.114.10", family: 4 },
    ])).resolves.toMatchObject({ endpoint: "https://push.example.test/send" });
    await expect(validateWebPushEndpoint("https://push.example.test/send", async () => [
      { address: "203.0.114.10", family: 4 },
      { address: "100.64.1.4", family: 4 },
    ])).rejects.toMatchObject({ code: "invalid_push_subscription" });
    await expect(validateWebPushEndpoint("https://127.0.0.1/send", async () => []))
      .rejects.toMatchObject({ code: "invalid_push_subscription" });
    await expect(validateWebPushEndpoint("https://push.example.test/send", async () => {
      throw new Error("temporary resolver outage");
    })).rejects.toMatchObject({ code: "push_endpoint_unresolvable", status: 503 });
    await expect(validateWebPushEndpoint("https://push.example.test:443/send", async () => [
      { address: "203.0.114.10", family: 4 },
    ])).resolves.toMatchObject({ endpoint: "https://push.example.test/send" });
    for (const address of [
      "::192.168.1.1",
      "64:ff9b::a00:1",
      "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
      "2002:0a00:0001::",
      "192.88.99.1",
    ]) {
      await expect(validateWebPushEndpoint("https://push.example.test/send", async () => [
        { address, family: address.includes(":") ? 6 : 4 },
      ])).rejects.toMatchObject({ code: "invalid_push_subscription" });
    }
    const valid = subscriptionInput("fingerprint");
    expect(() => validateWebPushKeys(valid.p256dh, valid.auth)).not.toThrow();
    expect(() => validateWebPushKeys("not+base64", valid.auth)).toThrowError(
      expect.objectContaining({ code: "invalid_push_subscription" }),
    );
  });

  it("gives every durable logical event its own Web Push topic", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    store.registerWebPushSubscription(subscriptionInput(identity.fingerprint));
    const thread = store.createThread("agent-one");
    const first = store.enqueueWebPushEvent({
      logicalKey: "turn:first:terminal",
      kind: "response.ready",
      threadId: thread.id,
      title: "Ready",
      body: "First response",
      expiresAt: "2026-08-13T09:00:00.000Z",
    });
    const second = store.enqueueWebPushEvent({
      logicalKey: "turn:second:terminal",
      kind: "response.ready",
      threadId: thread.id,
      title: "Ready",
      body: "Second response",
      expiresAt: "2026-08-13T09:00:00.000Z",
    });
    expect(first?.topic).not.toBe(second?.topic);
    store.close();
  });

  it("builds a same-origin declarative payload without exposing subscription secrets", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    store.registerWebPushSubscription(subscriptionInput(identity.fingerprint));
    const thread = store.createThread("agent-one");
    const event = store.enqueueWebPushEvent({
      logicalKey: "payload",
      kind: "response.ready",
      threadId: thread.id,
      title: "Agent replied",
      body: "Plain preview",
      expiresAt: "2026-08-14T08:00:00.000Z",
      notBefore: "2026-08-13T08:00:00.000Z",
    });
    const claimed = store.claimDueWebPushDeliveries(1)[0] as ClaimedWebPushDelivery;
    const payload = JSON.parse(webPushPayload(claimed)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      web_push: 8030,
      notification: {
        title: "Agent replied",
        body: "Plain preview",
        navigate: `https://console.example.test/?thread=${thread.id}`,
        data: { schema: "mono-agent.web-push.v1", eventId: event?.id, kind: "response.ready", threadId: thread.id },
      },
    });
    expect(JSON.stringify(payload)).not.toContain(claimed.subscription.auth);
    store.close();
  });

  it("keeps a maximal Unicode notification below the encrypted Web Push limit", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const subscription = store.registerWebPushSubscription({
      ...subscriptionInput(identity.fingerprint),
      p256dh: ecdh.getPublicKey().toString("base64url"),
      siteOrigin: `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(40)}.example.test`,
    });
    const thread = store.createThread("agent-one");
    store.enqueueWebPushEvent({
      logicalKey: "maximal-payload",
      kind: "response.ready",
      threadId: thread.id,
      title: "🙂".repeat(180),
      body: "🙂".repeat(180),
      expiresAt: "2026-08-14T08:00:00.000Z",
      notBefore: "2026-08-13T08:00:00.000Z",
      subscriptionId: subscription.id,
    });
    const delivery = store.claimDueWebPushDeliveries(1)[0]!;
    const details = webPush.generateRequestDetails({
      endpoint: delivery.subscription.endpoint,
      keys: { p256dh: delivery.subscription.p256dh, auth: delivery.subscription.auth },
    }, webPushPayload(delivery), {
      TTL: 60,
      contentEncoding: "aes128gcm",
      urgency: webPushUrgency(delivery.event.kind),
      topic: delivery.event.topic,
      vapidDetails: {
        subject: "mailto:owner@example.test",
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
      },
    });
    expect(details.body).not.toBeNull();
    expect(details.body!.byteLength).toBeLessThanOrEqual(4_096);
    expect(webPushUrgency("test")).toBe("low");
    store.close();
  });

  it("keeps one bad subscription from opening a vendor-wide circuit", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const bad = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint, "https://push.example.test/send/bad"));
    const healthy = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint, "https://push.example.test/send/healthy"));
    const send = vi.fn(async (delivery: ClaimedWebPushDelivery) => delivery.subscription.id === bad.id
      ? { statusCode: 403, headers: {} }
      : { statusCode: 201, headers: {} });
    const dispatcher = new WebPushDispatcher(store, identity, "mailto:owner@example.test", {
      send,
      clock: now,
      intervalMs: 5,
      random: () => 0.5,
    });
    const rejectedEventIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const event = store.enqueueWebPushEvent({
        logicalKey: `auth-${index}`,
        kind: "run.failed",
        title: "Run failed",
        body: "Safe failure",
        expiresAt: "2026-08-13T09:00:00.000Z",
        notBefore: "2026-08-13T08:00:00.000Z",
        subscriptionId: bad.id,
      });
      rejectedEventIds.push(event!.id);
    }
    dispatcher.start();
    await waitFor(() => rejectedEventIds.every((eventId) => deliveryStatus(store, eventId) === "config_error"));
    expect(dispatcher.isDegraded()).toBe(false);

    const acceptedEvent = store.enqueueWebPushEvent({
      logicalKey: "accepted",
      kind: "run.failed",
      title: "Run failed",
      body: "Safe failure",
      expiresAt: "2026-08-13T09:00:00.000Z",
      notBefore: "2026-08-13T08:00:00.000Z",
      subscriptionId: healthy.id,
    });
    await waitFor(() => deliveryStatus(store, acceptedEvent!.id) === "accepted");
    await dispatcher.stopAndDrain(50);
    expect(store.getWebPushSubscription(healthy.id)).toMatchObject({ state: "active" });
    store.close();
  });

  it("opens an origin circuit only after repeated failures from distinct subscriptions", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const first = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint, "https://push.example.test/send/first"));
    const second = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint, "https://push.example.test/send/second"));
    const send = vi.fn(async () => ({ statusCode: 403, headers: {} }));
    const dispatcher = new WebPushDispatcher(store, identity, "mailto:owner@example.test", {
      send,
      clock: now,
      intervalMs: 5,
    });
    for (const [index, subscriptionId] of [first.id, first.id, second.id].entries()) {
      store.enqueueWebPushEvent({
        logicalKey: `distinct-auth-${String(index)}`,
        kind: "run.failed",
        title: "Run failed",
        body: "Safe failure",
        expiresAt: "2026-08-13T09:00:00.000Z",
        notBefore: "2026-08-13T08:00:00.000Z",
        subscriptionId,
      });
    }
    dispatcher.start();
    await waitFor(() => send.mock.calls.length === 3);
    await waitFor(() => dispatcher.isDegraded());
    await dispatcher.stopAndDrain(50);
    store.close();
  });

  it("retires only explicitly unregistered 400 or 403 subscriptions", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const apple = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint, "https://push.example.test/send/apple"));
    const fcm = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint, "https://push.example.test/send/fcm"));
    const ambiguous = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint, "https://push.example.test/send/ambiguous"));
    const send = vi.fn(async (delivery: ClaimedWebPushDelivery) => {
      if (delivery.subscription.id === apple.id) {
        return { statusCode: 403, headers: {}, body: JSON.stringify({ reason: "BadSubscription" }) };
      }
      if (delivery.subscription.id === fcm.id) {
        return {
          statusCode: 400,
          headers: {},
          body: JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } }),
        };
      }
      return { statusCode: 403, headers: {}, body: JSON.stringify({ reason: "BadJwtToken" }) };
    });
    for (const subscription of [apple, fcm, ambiguous]) {
      store.enqueueWebPushEvent({
        logicalKey: `reason-${subscription.id}`,
        kind: "run.failed",
        title: "Run failed",
        body: "Safe failure",
        expiresAt: "2026-08-13T09:00:00.000Z",
        notBefore: "2026-08-13T08:00:00.000Z",
        subscriptionId: subscription.id,
      });
    }
    const dispatcher = new WebPushDispatcher(store, identity, "mailto:owner@example.test", {
      send,
      clock: now,
      intervalMs: 5,
    });
    dispatcher.start();
    await waitFor(() => send.mock.calls.length === 3);
    await waitFor(() => store.getWebPushSubscription(apple.id)?.state === "expired"
      && store.getWebPushSubscription(fcm.id)?.state === "expired");
    expect(store.getWebPushSubscription(ambiguous.id)).toMatchObject({
      state: "active",
      lastErrorCode: "push_service_403",
    });
    await dispatcher.stopAndDrain(50);
    store.close();
  });

  it("honors Retry-After and expires a subscription after a gone response", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const subscription = store.registerWebPushSubscription(subscriptionInput(identity.fingerprint));
    const retryEvent = store.enqueueWebPushEvent({
      logicalKey: "rate-limited",
      kind: "run.failed",
      title: "Run failed",
      body: "Safe failure",
      expiresAt: "2026-08-13T09:00:00.000Z",
      notBefore: "2026-08-13T08:00:00.000Z",
      subscriptionId: subscription.id,
    });
    const retryDispatcher = new WebPushDispatcher(store, identity, "mailto:owner@example.test", {
      send: async () => ({ statusCode: 429, headers: { "retry-after": "120" } }),
      clock: now,
      intervalMs: 5,
    });
    retryDispatcher.start();
    await waitFor(() => deliveryRecord(store, retryEvent!.id)?.attempts === 1);
    expect(deliveryRecord(store, retryEvent!.id)).toEqual({
      status: "pending",
      attempts: 1,
      nextAttemptAt: "2026-08-13T08:02:00.000Z",
    });
    await expect(Promise.race([
      retryDispatcher.stopAndDrain(1_000).then(() => "stopped"),
      new Promise<string>((resolvePromise) => setTimeout(() => resolvePromise("timed-out"), 200)),
    ])).resolves.toBe("stopped");

    const goneEvent = store.enqueueWebPushEvent({
      logicalKey: "gone",
      kind: "test",
      title: "Test",
      body: "Connected",
      expiresAt: "2026-08-13T09:00:00.000Z",
      notBefore: "2026-08-13T08:00:00.000Z",
      subscriptionId: subscription.id,
    });
    const goneDispatcher = new WebPushDispatcher(store, identity, "mailto:owner@example.test", {
      send: async () => ({ statusCode: 410, headers: {} }),
      clock: now,
      intervalMs: 5,
    });
    goneDispatcher.start();
    await waitFor(() => store.getWebPushSubscription(subscription.id)?.state === "expired");
    expect(deliveryStatus(store, goneEvent!.id)).toBe("stale");
    expect(deliveryStatus(store, retryEvent!.id)).toBe("stale");
    await goneDispatcher.stopAndDrain(50);
    store.close();
  });

  it("retries transient DNS failures but expires a resolved unsafe endpoint", async () => {
    const now = () => new Date("2026-08-13T08:00:00.000Z");
    const store = await storeAt(now);
    const identity = store.ensureWebPushIdentity(generateWebPushIdentity);
    const transient = store.registerWebPushSubscription(subscriptionInput(
      identity.fingerprint,
      "https://push.example.test/send/transient",
    ));
    const transientEvent = store.enqueueWebPushEvent({
      logicalKey: "dns-transient",
      kind: "run.failed",
      title: "Run failed",
      body: "Safe failure",
      expiresAt: "2026-08-13T09:00:00.000Z",
      notBefore: "2026-08-13T08:00:00.000Z",
      subscriptionId: transient.id,
    });
    const transientDispatcher = new WebPushDispatcher(store, identity, "mailto:owner@example.test", {
      resolve: async () => { throw new Error("EAI_AGAIN"); },
      clock: now,
      intervalMs: 5,
      random: () => 0.5,
    });
    transientDispatcher.start();
    await waitFor(() => deliveryRecord(store, transientEvent!.id)?.attempts === 1);
    expect(store.getWebPushSubscription(transient.id)).toMatchObject({ state: "active" });
    expect(deliveryRecord(store, transientEvent!.id)).toMatchObject({ status: "pending", attempts: 1 });
    await transientDispatcher.stopAndDrain(50);

    const unsafe = store.registerWebPushSubscription(subscriptionInput(
      identity.fingerprint,
      "https://unsafe.example.test/send/opaque",
    ));
    store.enqueueWebPushEvent({
      logicalKey: "dns-unsafe",
      kind: "run.failed",
      title: "Run failed",
      body: "Safe failure",
      expiresAt: "2026-08-13T09:00:00.000Z",
      notBefore: "2026-08-13T08:00:00.000Z",
      subscriptionId: unsafe.id,
    });
    const unsafeDispatcher = new WebPushDispatcher(store, identity, "mailto:owner@example.test", {
      resolve: async () => [{ address: "::192.168.1.1", family: 6 }],
      clock: now,
      intervalMs: 5,
    });
    unsafeDispatcher.start();
    await waitFor(() => store.getWebPushSubscription(unsafe.id)?.state === "expired");
    expect(store.getWebPushSubscription(unsafe.id)).toMatchObject({ lastErrorCode: "unsafe_endpoint" });
    await unsafeDispatcher.stopAndDrain(50);
    store.close();
  });

  it("removes Markdown, bidi controls, and obvious credentials before truncating by code point", () => {
    const preview = webPushPreview(
      `# Result\n> **Ready** [open](https://example.test) Authorization: Bearer abcdefghijklmnop \u202E ${"🙂".repeat(200)}`,
    );
    expect(preview).toContain("Result Ready open Authorization: [redacted]");
    expect(preview).not.toContain("https://");
    expect(preview).not.toContain("\u202E");
    expect([...preview].length).toBeLessThanOrEqual(180);
    expect(webPushPreview('{"apiKey":"my-secret-value"}')).toBe('{"apiKey":"[redacted]"}');
    expect(webPushPreview('{"password":"x"}')).toBe('{"password":"[redacted]"}');
    expect(webPushPreview('{"password":"two words"}')).toBe('{"password":"[redacted]"}');
    expect(webPushPreview("'password': 'another-secret-value'")).toBe("'password': '[redacted]'");
    expect(webPushPreview('password: "two words"')).toBe('password: "[redacted]"');
    expect(webPushPreview('--password "two words"')).toBe('--password "[redacted]"');
    expect(webPushPreview('password: "prefix""secret suffix" tail')).toBe("password: [redacted] tail");
    expect(webPushPreview('--token "prefix""secret suffix" tail')).toBe("--token [redacted] tail");
    expect(webPushPreview('password=alpha"beta gamma" tail')).toBe("password=[redacted] tail");
    expect(webPushPreview('password="alpha"beta gamma')).toBe("password=[redacted] gamma");
    expect(webPushPreview("password=ab}cd tail")).toBe("password=[redacted] tail");
    expect(webPushPreview("password=ab)cd tail")).toBe("password=[redacted] tail");
    expect(webPushPreview("password=ab]cd tail")).toBe("password=[redacted] tail");
    expect(webPushPreview("token: abc,secret: def")).toBe("token: [redacted],secret: [redacted]");
    expect(webPushPreview("token: abc;password: def")).toBe("token: [redacted];password: [redacted]");
    expect(webPushPreview("password=ab}token: leaked")).toBe("password=[redacted]}token: [redacted]");
    expect(webPushPreview("password=ab)secret: leaked")).toBe("password=[redacted])secret: [redacted]");
    expect(webPushPreview("password=ab]password: leaked")).toBe("password=[redacted]]password: [redacted]");
    expect(webPushPreview('{"password":"alpha","host":"db.example"}')).toBe('{"password":"[redacted]","host":"db.example"}');
    expect(webPushPreview('--password "two words" --port 5432')).toBe('--password "[redacted]" --port 5432');
    expect(webPushPreview("token\u202E: my-secret-value")).toBe("token: [redacted]");
    expect(webPushPreview("Bearer\u200B abcdefghijklmnop")).toBe("Bearer [redacted]");
    expect(webPushPreview("Authorization: Bearer abcdefgh\u200Bijklmnop")).toBe("Authorization: [redacted]");
    expect(webPushPreview("Bearer abcdefgh\u200Bijklmnopqrst")).toBe("Bearer [redacted]");
    expect(webPushPreview("basic YWJjZGVm\u200BZ2hpamts")).toBe("basic [redacted]");
    expect(webPushPreview("Bearer abcdefgh\uFEFFijklmnop")).toBe("Bearer [redacted]");
    expect(webPushPreview("token abcdefgh\u2060ijklmnop")).toBe("token [redacted]");
    expect(webPushPreview("Bearer abcdefgh\u00ADijklmnop")).toBe("Bearer [redacted]");
    expect(webPushPreview("Bearer abcdefgh\u034Fijklmnop")).toBe("Bearer [redacted]");
    expect(webPushPreview("Bearer abcdefgh\u3164ijklmnop")).toBe("Bearer [redacted]");
    expect(webPushPreview("Bearer abcdefgh\uFFF9ijklmnop")).toBe("Bearer [redacted]");
    expect(webPushPreview("Bearer\u200Babcdefghijklmnop")).toBe("Bearer [redacted]");
    expect(webPushPreview("Authorization\u200B:\u200BBearer\u200Babcdefghijklmnop")).toBe("Authorization:[redacted]");
    expect(webPushPreview("token&#x202e;: encoded-secret-value")).toBe("token: [redacted]");
    expect(webPushPreview(`password: "${"\\".repeat(7_000)}`)).toBe("password: [redacted]");

    for (const source of [
      '{"password":"alpha","host":"db.example"}',
      '--token "prefix""secret suffix" --port 5432',
      "Bearer\u200Babcdefghijklmnop",
      `password: "${"\\".repeat(7_000)}`,
    ]) {
      const once = webPushPreview(source);
      expect(webPushPreview(once)).toBe(once);
    }
  });
});
