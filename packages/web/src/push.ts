import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import webPush, {
  type Headers as WebPushHeaders,
  type Urgency,
} from "web-push";

import { WebConsoleError } from "./errors.js";
import {
  type ClaimedWebPushDelivery,
  type StoredWebPushEvent,
  type WebPushIdentity,
  type WebStore,
} from "./store.js";

export const WEB_PUSH_SERVICE_WORKER_VERSION = 3 as const;
export const DEFAULT_WEB_PUSH_SUBJECT = "https://github.com/robertsreberski/mono-agent";
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_ENCRYPTED_PAYLOAD_BYTES = 4_096;
const MAX_RESPONSE_BODY_BYTES = 4_096;
const MINIMUM_PUSH_BODY = "Open the console to view the update.";
const REQUEST_TIMEOUT_MS = 10_000;
const DISPATCH_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 100;
const MAX_RETRY_MS = 15 * 60 * 1_000;
const CIRCUIT_WINDOW_MS = 10 * 60 * 1_000;
const CIRCUIT_FAILURES = 3;

export type WebPushDnsResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

export interface WebPushHttpResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: string;
}

export type WebPushSend = (
  delivery: ClaimedWebPushDelivery,
  identity: WebPushIdentity,
  subject: string,
  signal: AbortSignal,
) => Promise<WebPushHttpResult>;

export interface WebPushDispatcherOptions {
  readonly send?: WebPushSend;
  readonly resolve?: WebPushDnsResolver;
  readonly beforeSend?: (
    event: StoredWebPushEvent,
    signal: AbortSignal,
  ) => Promise<"current" | "stale" | "unknown">;
  readonly logger?: {
    debug?(message: string, metadata?: Readonly<Record<string, unknown>>): void;
    warn?(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  };
  readonly clock?: () => Date;
  readonly random?: () => number;
  readonly intervalMs?: number;
}

export interface ValidatedWebPushEndpoint {
  readonly endpoint: string;
  readonly url: URL;
  readonly addresses: readonly LookupAddress[];
}

interface CircuitState {
  readonly failures: ReadonlyArray<{ readonly subscriptionId: string; readonly at: number }>;
  openUntil?: number;
}

const unsafeAddresses = createUnsafeAddressBlockList();

export function generateWebPushIdentity(): { readonly publicKey: string; readonly privateKey: string } {
  return webPush.generateVAPIDKeys();
}

export function resolveWebPushSubject(value: string | undefined): string {
  const subject = value?.trim() || DEFAULT_WEB_PUSH_SUBJECT;
  if (/^mailto:[^\s@]+@[^\s@]+$/iu.test(subject)) return subject;
  let parsed: URL;
  try {
    parsed = new URL(subject);
  } catch {
    throw new WebConsoleError(
      "invalid_web_push_subject",
      "MONO_AGENT_WEB_PUSH_SUBJECT must be a mailto address or a non-localhost HTTPS URL.",
      500,
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || hostname === "localhost" || hostname.endsWith(".localhost")
    || (isIP(hostname) !== 0 && !isPublicAddress(hostname))) {
    throw new WebConsoleError(
      "invalid_web_push_subject",
      "MONO_AGENT_WEB_PUSH_SUBJECT must be a mailto address or a non-localhost HTTPS URL.",
      500,
    );
  }
  return parsed.href;
}

export async function validateWebPushEndpoint(
  value: string,
  resolver: WebPushDnsResolver = defaultWebPushDnsResolver,
): Promise<ValidatedWebPushEndpoint> {
  const endpoint = normalizeWebPushEndpoint(value);
  const url = new URL(endpoint);
  let addresses: readonly LookupAddress[];
  try {
    addresses = await resolver(url.hostname);
  } catch {
    throw endpointUnresolvable();
  }
  if (addresses.length === 0) throw endpointUnresolvable();
  if (addresses.some((address) => !isPublicAddress(address.address))) {
    throw invalidSubscription("The push endpoint must resolve only to public Internet addresses.");
  }
  return { endpoint, url, addresses };
}

/** Canonicalize an endpoint without resolving it or making an outbound request. */
export function normalizeWebPushEndpoint(value: string): string {
  if (value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw invalidSubscription("The push endpoint has an invalid length.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidSubscription("The push endpoint must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== ""
    || url.hash !== "" || isIP(url.hostname) !== 0) {
    throw invalidSubscription("The push endpoint must use HTTPS on port 443 with a public DNS hostname.");
  }
  return url.href;
}

export function validateWebPushKeys(p256dh: string, auth: string): void {
  if (!isBase64Url(p256dh) || !isBase64Url(auth)) {
    throw invalidSubscription("The push subscription keys must use base64url encoding.");
  }
  let publicKey: Buffer;
  let authSecret: Buffer;
  try {
    publicKey = Buffer.from(p256dh, "base64url");
    authSecret = Buffer.from(auth, "base64url");
  } catch {
    throw invalidSubscription("The push subscription keys are invalid.");
  }
  if (publicKey.byteLength !== 65 || publicKey[0] !== 4 || authSecret.byteLength !== 16) {
    throw invalidSubscription("The push subscription keys have invalid lengths.");
  }
}

export function webPushPayload(delivery: ClaimedWebPushDelivery): string {
  return webPushPayloadWithPreview(delivery, delivery.event.title, delivery.event.body);
}

function webPushPayloadWithPreview(
  delivery: ClaimedWebPushDelivery,
  title: string,
  body: string,
): string {
  const navigate = new URL("/", delivery.subscription.siteOrigin);
  if (delivery.event.threadId !== undefined) navigate.searchParams.set("thread", delivery.event.threadId);
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title,
      body,
      navigate: navigate.href,
      silent: false,
      tag: delivery.event.tag,
      data: {
        schema: "mono-agent.web-push.v1",
        eventId: delivery.event.id,
        kind: delivery.event.kind,
        ...(delivery.event.threadId === undefined ? {} : { threadId: delivery.event.threadId }),
      },
    },
  });
}

export function webPushUrgency(kind: StoredWebPushEvent["kind"]): Urgency {
  if (kind === "input.required") return "high";
  if (kind === "run.cancelled" || kind === "test") return "low";
  return "normal";
}

export async function sendWebPushPinned(
  delivery: ClaimedWebPushDelivery,
  identity: WebPushIdentity,
  subject: string,
  signal: AbortSignal,
  resolver: WebPushDnsResolver = defaultWebPushDnsResolver,
): Promise<WebPushHttpResult> {
  const validated = await validateWebPushEndpoint(delivery.subscription.endpoint, resolver);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expirySeconds = Math.floor(new Date(delivery.event.expiresAt).getTime() / 1_000);
  const ttl = Math.max(0, expirySeconds - nowSeconds);
  let title = delivery.event.title;
  let body = delivery.event.body;
  let details = webPushRequestDetails(delivery, validated.endpoint, identity, subject, ttl, title, body);
  while (details.body === null || details.body.byteLength > MAX_ENCRYPTED_PAYLOAD_BYTES) {
    const bodyLength = [...body].length;
    const titleLength = [...title].length;
    if (bodyLength > [...MINIMUM_PUSH_BODY].length) {
      body = truncatePayloadText(body, Math.max([...MINIMUM_PUSH_BODY].length, Math.floor(bodyLength / 2)));
    } else if (body !== MINIMUM_PUSH_BODY) {
      body = MINIMUM_PUSH_BODY;
    } else if (titleLength > 1) {
      title = truncatePayloadText(title, Math.max(1, Math.floor(titleLength / 2)));
    } else {
      break;
    }
    details = webPushRequestDetails(delivery, validated.endpoint, identity, subject, ttl, title, body);
  }
  if (details.body === null || details.body.byteLength > MAX_ENCRYPTED_PAYLOAD_BYTES) {
    throw new WebConsoleError(
      "push_payload_too_large",
      "The encrypted notification payload exceeds the Web Push limit.",
      500,
    );
  }
  const pinned = validated.addresses[0];
  if (pinned === undefined) throw invalidSubscription("The push endpoint has no safe address.");
  return await performPinnedRequest(validated.url, pinned, details.headers, details.body, signal);
}

export class WebPushDispatcher {
  private readonly active = new Map<Promise<void>, AbortController>();
  private readonly circuits = new Map<string, CircuitState>();
  private readonly send: WebPushSend;
  private readonly clock: () => Date;
  private readonly random: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly store: WebStore,
    private readonly identity: WebPushIdentity,
    private readonly subject: string,
    private readonly options: WebPushDispatcherOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.send = options.send ?? ((delivery, currentIdentity, currentSubject, signal) =>
      sendWebPushPinned(delivery, currentIdentity, currentSubject, signal, options.resolve));
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => this.wake(), this.options.intervalMs ?? DISPATCH_INTERVAL_MS);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.stopped || this.ticking) return;
    void this.tick();
  }

  isDegraded(): boolean {
    const now = this.clock().getTime();
    for (const [origin, circuit] of this.circuits) {
      if ((circuit.openUntil ?? 0) > now) return true;
      if (circuit.openUntil !== undefined) this.circuits.delete(origin);
    }
    return false;
  }

  async stopAndDrain(timeoutMs = 5_000): Promise<void> {
    if (this.stopped) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && (this.store.webPushDueQueueDepth() > 0 || this.active.size > 0)) {
      this.wake();
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 50);
        timer.unref();
      });
    }
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active.size > 0) {
      for (const controller of this.active.values()) controller.abort(new Error("Web Push shutdown deadline reached."));
      await Promise.allSettled([...this.active.keys()]);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const available = Math.max(0, 4 - this.active.size);
      if (available === 0) return;
      for (const delivery of this.store.claimDueWebPushDeliveries(available)) {
        const controller = new AbortController();
        const operation = this.deliver(delivery, controller.signal)
          .catch((error: unknown) => {
            this.options.logger?.warn?.("Web Push delivery failed safely.", {
              eventId: delivery.event.id,
              subscriptionId: delivery.subscription.id,
              error: safeErrorCode(error),
            });
          })
          .finally(() => {
            this.active.delete(operation);
            this.wake();
          });
        this.active.set(operation, controller);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async deliver(delivery: ClaimedWebPushDelivery, signal: AbortSignal): Promise<void> {
    const now = this.clock();
    if (new Date(delivery.event.expiresAt).getTime() <= now.getTime()) {
      this.store.settleWebPushDelivery({
        eventId: delivery.event.id,
        subscriptionId: delivery.subscription.id,
        status: "dropped",
        errorCode: "expired",
      });
      return;
    }
    if (delivery.subscription.keyFingerprint !== this.identity.fingerprint) {
      this.store.expireWebPushSubscription(delivery.subscription.id, "application_key_changed");
      return;
    }
    if (delivery.event.kind === "input.required" && this.options.beforeSend !== undefined) {
      let relevance: "current" | "stale" | "unknown";
      try {
        relevance = await this.options.beforeSend(delivery.event, signal);
      } catch {
        relevance = "unknown";
      }
      if (relevance === "stale") {
        this.store.settleWebPushDelivery({
          eventId: delivery.event.id,
          subscriptionId: delivery.subscription.id,
          status: "stale",
          errorCode: "interaction_resolved",
        });
        return;
      }
      if (relevance === "unknown") {
        this.retry(delivery, undefined, "interaction_state_unknown");
        return;
      }
    }

    const origin = new URL(delivery.subscription.endpoint).origin;
    const circuit = this.circuits.get(origin);
    if (delivery.event.kind !== "test" && (circuit?.openUntil ?? 0) > now.getTime()) {
      this.store.deferClaimedWebPushDelivery(
        delivery.event.id,
        delivery.subscription.id,
        new Date(circuit?.openUntil ?? now.getTime() + CIRCUIT_WINDOW_MS).toISOString(),
      );
      return;
    }

    let result: WebPushHttpResult;
    try {
      result = await this.send(delivery, this.identity, this.subject, signal);
    } catch (error) {
      if (error instanceof WebConsoleError) {
        if (error.code === "invalid_push_subscription") {
          this.store.expireWebPushSubscription(delivery.subscription.id, "unsafe_endpoint");
          return;
        }
        if (error.code === "push_endpoint_unresolvable") {
          this.retry(delivery, undefined, error.code);
          return;
        }
        this.store.settleWebPushDelivery({
          eventId: delivery.event.id,
          subscriptionId: delivery.subscription.id,
          status: "config_error",
          errorCode: error.code,
        });
        return;
      }
      this.retry(delivery, undefined, safeErrorCode(error));
      return;
    }

    const status = result.statusCode;
    if (status >= 200 && status < 300) {
      this.circuits.delete(origin);
      this.store.settleWebPushDelivery({
        eventId: delivery.event.id,
        subscriptionId: delivery.subscription.id,
        status: "accepted",
        statusCode: status,
      });
      return;
    }
    if (status === 404 || status === 410) {
      this.store.expireWebPushSubscription(delivery.subscription.id, `push_service_${String(status)}`);
      return;
    }
    if ((status === 400 || status === 403) && hasSubscriptionMismatchReason(result.body)) {
      this.store.expireWebPushSubscription(delivery.subscription.id, "push_service_unregistered");
      return;
    }
    if (status === 401 || status === 403) {
      this.recordAuthFailure(origin, delivery.subscription.id);
      this.store.settleWebPushDelivery({
        eventId: delivery.event.id,
        subscriptionId: delivery.subscription.id,
        status: "config_error",
        statusCode: status,
        errorCode: `push_service_${String(status)}`,
      });
      return;
    }
    if (status === 429) {
      this.retry(delivery, status, "push_service_429", retryAfterMs(result.headers, now));
      return;
    }
    if (status === 408 || status === 425 || status >= 500) {
      this.retry(delivery, status, `push_service_${String(status)}`);
      return;
    }
    this.store.settleWebPushDelivery({
      eventId: delivery.event.id,
      subscriptionId: delivery.subscription.id,
      status: "failed",
      statusCode: status,
      errorCode: `push_service_${String(status)}`,
    });
  }

  private retry(
    delivery: ClaimedWebPushDelivery,
    statusCode: number | undefined,
    errorCode: string,
    requestedDelayMs?: number,
  ): void {
    const attempt = delivery.attempts + 1;
    const exponential = Math.min(MAX_RETRY_MS, 5_000 * 2 ** Math.min(attempt - 1, 16));
    const jittered = Math.round(exponential * (0.75 + this.random() * 0.5));
    const delay = Math.min(MAX_RETRY_MS, Math.max(1_000, requestedDelayMs ?? jittered));
    const next = new Date(this.clock().getTime() + delay);
    if (attempt >= MAX_ATTEMPTS || next.getTime() >= new Date(delivery.event.expiresAt).getTime()) {
      this.store.settleWebPushDelivery({
        eventId: delivery.event.id,
        subscriptionId: delivery.subscription.id,
        status: "failed",
        ...(statusCode === undefined ? {} : { statusCode }),
        errorCode: attempt >= MAX_ATTEMPTS ? "attempt_limit" : "expired_before_retry",
      });
      return;
    }
    this.store.retryWebPushDelivery({
      eventId: delivery.event.id,
      subscriptionId: delivery.subscription.id,
      nextAttemptAt: next.toISOString(),
      ...(statusCode === undefined ? {} : { statusCode }),
      errorCode,
    });
  }

  private recordAuthFailure(origin: string, subscriptionId: string): void {
    const now = this.clock().getTime();
    const recent = (this.circuits.get(origin)?.failures ?? []).filter((failure) => now - failure.at <= CIRCUIT_WINDOW_MS);
    recent.push({ subscriptionId, at: now });
    const distinctSubscriptions = new Set(recent.map((failure) => failure.subscriptionId)).size;
    this.circuits.set(origin, {
      failures: recent,
      ...(recent.length >= CIRCUIT_FAILURES && distinctSubscriptions >= 2
        ? { openUntil: now + CIRCUIT_WINDOW_MS }
        : {}),
    });
  }
}

function webPushRequestDetails(
  delivery: ClaimedWebPushDelivery,
  endpoint: string,
  identity: WebPushIdentity,
  subject: string,
  ttl: number,
  title: string,
  body: string,
) {
  return webPush.generateRequestDetails(
    {
      endpoint,
      ...(delivery.subscription.expirationTime === undefined ? {} : { expirationTime: delivery.subscription.expirationTime }),
      keys: { p256dh: delivery.subscription.p256dh, auth: delivery.subscription.auth },
    },
    webPushPayloadWithPreview(delivery, title, body),
    {
      TTL: ttl,
      contentEncoding: "aes128gcm",
      urgency: webPushUrgency(delivery.event.kind),
      topic: delivery.event.topic,
      vapidDetails: {
        subject,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
      },
    },
  );
}

function truncatePayloadText(value: string, maxCodePoints: number): string {
  const points = [...value];
  if (points.length <= maxCodePoints) return value;
  if (maxCodePoints <= 0) return "";
  if (maxCodePoints === 1) return "…";
  return `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

async function defaultWebPushDnsResolver(hostname: string): Promise<readonly LookupAddress[]> {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

function performPinnedRequest(
  url: URL,
  pinned: LookupAddress,
  headers: WebPushHeaders,
  body: Buffer,
  signal: AbortSignal,
): Promise<WebPushHttpResult> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: WebPushHttpResult): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolvePromise(value);
    };
    const request = httpsRequest(url, {
      method: "POST",
      headers,
      servername: url.hostname,
      signal,
      // Keep TLS hostname verification on the original host while pinning the
      // validated address. Node's HTTPS client does not follow redirects.
      lookup: createWebPushPinnedLookup(pinned),
    }, (response) => {
      const chunks: Buffer[] = [];
      let captured = 0;
      response.on("data", (raw: Buffer | Uint8Array | string) => {
        if (captured >= MAX_RESPONSE_BODY_BYTES) return;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const remaining = MAX_RESPONSE_BODY_BYTES - captured;
        chunks.push(chunk.subarray(0, remaining));
        captured += Math.min(chunk.byteLength, remaining);
      });
      response.once("error", (error) => finish(error));
      response.once("end", () => finish(undefined, {
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        ...(captured === 0 ? {} : { body: Buffer.concat(chunks).toString("utf8") }),
      }));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("push_request_timeout")));
    request.once("error", (error) => finish(error));
    request.end(body);
  });
}

/** Preserve one validated address while honoring both Node lookup callback modes. */
export function createWebPushPinnedLookup(pinned: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [pinned]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

function retryAfterMs(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  now: Date,
): number | undefined {
  const raw = headers["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  if (/^\d+$/u.test(value.trim())) return Math.min(MAX_RETRY_MS, Number(value.trim()) * 1_000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.min(MAX_RETRY_MS, Math.max(1_000, parsed - now.getTime())) : undefined;
}

function createUnsafeAddressBlockList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [
    ["::", 96],
    ["100::", 64],
    ["64:ff9b::", 96],
    ["2001::", 32],
    ["2002::", 16],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) list.addSubnet(network, prefix, "ipv6");
  return list;
}

function isPublicAddress(address: string): boolean {
  if (address.toLowerCase().startsWith("::ffff:")) return false;
  const family = isIP(address);
  return family === 4
    ? !unsafeAddresses.check(address, "ipv4")
    : family === 6 && !unsafeAddresses.check(address, "ipv6");
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function hasSubscriptionMismatchReason(body: string | undefined): boolean {
  if (body === undefined || body.length === 0) return false;
  const allowed = new Set(["BADSUBSCRIPTION", "UNREGISTERED"]);
  const normalize = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]+/gu, "");
  if (allowed.has(normalize(body.trim()))) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: parsed, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 64) {
    const item = pending.shift();
    if (item === undefined) break;
    visited += 1;
    if (item.depth > 5 || typeof item.value !== "object" || item.value === null) continue;
    if (Array.isArray(item.value)) {
      for (const value of item.value) pending.push({ value, depth: item.depth + 1 });
      continue;
    }
    for (const [key, value] of Object.entries(item.value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/gu, "");
      if ((normalizedKey === "reason" || normalizedKey === "error" || normalizedKey === "errorcode")
        && typeof value === "string" && allowed.has(normalize(value))) return true;
      pending.push({ value, depth: item.depth + 1 });
    }
  }
  return false;
}

function invalidSubscription(message: string): WebConsoleError {
  return new WebConsoleError("invalid_push_subscription", message, 400);
}

function endpointUnresolvable(): WebConsoleError {
  return new WebConsoleError(
    "push_endpoint_unresolvable",
    "The push endpoint hostname could not be resolved right now.",
    503,
  );
}

function safeErrorCode(error: unknown): string {
  if (error instanceof WebConsoleError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return error instanceof Error ? createHash("sha256").update(error.name).digest("hex").slice(0, 12) : "network_error";
}
