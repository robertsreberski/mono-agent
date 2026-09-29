import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type { AgentReplyPart, ProcessJobProjection } from "@mono-agent/agent-contracts";

import type { WebThreadNotificationTriggerKind } from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import { fetchLongLivedHostWake } from "@mono-agent/operator-adapter/client";
import { resolveWebStatePaths, type WebStatePathOptions } from "./state-paths.js";

const NOTIFICATION_INGRESS_SCHEMA = 1;
const NOTIFICATION_INGRESS_PATH = "/internal/v1/notifications";
const MAX_INGRESS_RECORD_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface DeliverWebThreadNotificationInput {
  readonly sourceId: string;
  readonly triggerKind: WebThreadNotificationTriggerKind;
  readonly deliveryKey: string;
  readonly text: string;
  readonly jobId?: string;
  readonly runId?: string;
}

export interface DeliverWebProcessJobNotificationInput {
  readonly sourceId: string;
  readonly triggerKind: "job";
  readonly deliveryKey: string;
  readonly threadId: string;
  readonly processJob: ProcessJobProjection;
  readonly wakePrompt?: string;
  readonly text?: string;
  readonly parts?: readonly AgentReplyPart[];
}

export type DeliverWebNotificationInput =
  | DeliverWebThreadNotificationInput
  | DeliverWebProcessJobNotificationInput;

export interface DeliverWebNotificationOptions extends WebStatePathOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface DeliverWebNotificationResult {
  readonly threadId?: string;
  readonly duplicate: boolean;
  readonly tombstoned?: true;
  readonly delivery?: {
    readonly delivered: boolean;
    readonly disposition?: "steered" | "follow_up";
    readonly code?: string;
    readonly retryable?: boolean;
    readonly ambiguous?: boolean;
  };
}

interface NotificationIngressRecord {
  readonly schema: number;
  readonly pid: number;
  readonly instanceId: string;
  readonly url: string;
  readonly token: string;
  readonly updatedAt: string;
}

/** Deliver once to the active local web console. There is intentionally no retry or outbox. */
export async function deliverWebNotification(
  input: DeliverWebNotificationInput,
  options: DeliverWebNotificationOptions = {},
): Promise<DeliverWebNotificationResult> {
  const path = resolveWebStatePaths(options).notificationIngress;
  const ingress = await readIngressRecord(path);
  const carriesWakeTurn = input.triggerKind === "job" && input.wakePrompt !== undefined;
  const fetchImpl = options.fetchImpl ?? (carriesWakeTurn ? fetchLongLivedHostWake : fetch);
  let response: Response;
  try {
    response = await fetchImpl(ingress.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs
        ?? (carriesWakeTurn ? 10 * 60 * 1_000 : DEFAULT_TIMEOUT_MS)),
      headers: {
        authorization: `Bearer ${ingress.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    // An abort means the request reached the wire and the console may still be
    // running the delivery — for a job wake that is a whole agent turn. Callers
    // must be able to tell that apart from a connect failure, which provably
    // delivered nothing and is therefore safe to replay.
    if (isAbortError(error)) {
      throw new WebConsoleError(
        "notification_ingress_timeout",
        `The web notification ingress did not answer in time (${errorMessage(error)}).`,
        504,
      );
    }
    throw new WebConsoleError(
      "notification_ingress_unavailable",
      `The web notification ingress is unavailable (${errorMessage(error)}).`,
      503,
    );
  }
  const bodyText = await readBoundedResponse(response);
  if (!response.ok) {
    // Job ingress returns 400/invalid_notification only before accepting a
    // card or wake (request parsing precedes service delivery). Preserve that
    // narrow refusal separately from timeouts and post-acceptance failures.
    let rejection: unknown;
    try { rejection = JSON.parse(bodyText) as unknown; } catch { /* opaque response */ }
    const rejectedBeforeAcceptance = input.triggerKind === "job" && response.status === 400
      && asRecord(asRecord(rejection)?.error)?.code === "invalid_notification";
    throw new WebConsoleError(
      rejectedBeforeAcceptance ? "notification_rejected" : "notification_delivery_failed",
      `The web notification ingress responded ${String(response.status)}${bodyText.length === 0 ? "." : `: ${bodyText.slice(0, 300)}`}`,
      502,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    throw new WebConsoleError("invalid_notification_response", "The web notification ingress returned invalid JSON.", 502);
  }
  const result = asRecord(parsed);
  if (result === undefined
    || (typeof result.threadId !== "string" && result.threadId !== null)
    || typeof result.duplicate !== "boolean"
    || (result.threadId === null && (result.duplicate !== true || result.tombstoned !== true))) {
    throw new WebConsoleError("invalid_notification_response", "The web notification ingress returned an invalid result.", 502);
  }
  const delivery = parseDeliveryResult(result.delivery);
  return {
    ...(typeof result.threadId === "string" ? { threadId: result.threadId } : {}),
    duplicate: result.duplicate,
    ...(result.tombstoned === true ? { tombstoned: true } : {}),
    ...(delivery === undefined ? {} : { delivery }),
  };
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const name = (error as { readonly name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function parseDeliveryResult(value: unknown): DeliverWebNotificationResult["delivery"] | undefined {
  if (value === undefined) return undefined;
  const result = asRecord(value);
  if (result === undefined
    || typeof result.delivered !== "boolean"
    || (result.disposition !== undefined
      && result.disposition !== "steered"
      && result.disposition !== "follow_up")
    || (result.code !== undefined && typeof result.code !== "string")
    || (result.retryable !== undefined && typeof result.retryable !== "boolean")
    || (result.ambiguous !== undefined && typeof result.ambiguous !== "boolean")) {
    throw new WebConsoleError("invalid_notification_response", "The web notification ingress returned an invalid delivery receipt.", 502);
  }
  return {
    delivered: result.delivered,
    ...(result.disposition === undefined ? {} : { disposition: result.disposition }),
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
    ...(result.ambiguous === undefined ? {} : { ambiguous: result.ambiguous }),
  } as DeliverWebNotificationResult["delivery"];
}

async function readIngressRecord(path: string): Promise<NotificationIngressRecord> {
  const info = await lstat(path).catch(() => undefined);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (info === undefined || !info.isFile() || info.isSymbolicLink()
    || info.nlink !== 1 || info.size <= 0 || info.size > MAX_INGRESS_RECORD_BYTES
    || (currentUid !== undefined && info.uid !== currentUid)
    || (info.mode & 0o077) !== 0) {
    throw new WebConsoleError(
      "notification_ingress_unavailable",
      "The owner-private web notification ingress record is unavailable.",
      503,
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let contents: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size
      || opened.nlink !== 1 || (currentUid !== undefined && opened.uid !== currentUid)
      || (opened.mode & 0o077) !== 0) {
      throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress record changed while opening.", 503);
    }
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress record is invalid.", 503);
  }
  const record = asRecord(parsed);
  if (record === undefined
    || record.schema !== NOTIFICATION_INGRESS_SCHEMA
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
    || typeof record.instanceId !== "string" || record.instanceId.length === 0 || record.instanceId.length > 128
    || typeof record.url !== "string"
    || typeof record.token !== "string" || record.token.length < 32 || record.token.length > 256
    || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress record is invalid.", 503);
  }
  assertTrustedIngressUrl(record.url);
  return record as unknown as NotificationIngressRecord;
}

function assertTrustedIngressUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress URL is invalid.", 503);
  }
  if (url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.port.length === 0
    || url.pathname !== NOTIFICATION_INGRESS_PATH
    || url.search.length > 0
    || url.hash.length > 0
    || url.username.length > 0
    || url.password.length > 0) {
    throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress URL is not trusted.", 503);
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new WebConsoleError("invalid_notification_response", "The web notification response is too large.", 502);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** App-owned callback client. Discovery and credentials stay inside this closure. */
export async function createWebConsoleToolClient(
  scope: import("./console-tools.js").WebConsoleToolScope,
  options: DeliverWebNotificationOptions = {},
): Promise<(operation: import("./console-tools.js").ConsoleToolOperation) => Promise<Record<string, unknown>>> {
  const ingress = await readIngressRecord(resolveWebStatePaths(options).notificationIngress);
  const request = consoleToolRequester(ingress, options);
  const issued = await request(ingress.token, scope);
  if (typeof issued.capability !== "string" || !/^[a-zA-Z0-9_-]{40,128}$/u.test(issued.capability)) {
    throw new WebConsoleError("console_tool_unavailable", "Console capability unavailable.", 503);
  }
  return consoleToolCaller(request, issued.capability);
}

type ConsoleToolRequester = (token: string, body: unknown) => Promise<Record<string, unknown>>;

function consoleToolRequester(ingress: NotificationIngressRecord, options: DeliverWebNotificationOptions): ConsoleToolRequester {
  const endpoint = new URL("/internal/v1/console-tools", ingress.url).href;
  return async (token, body) => {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } catch {
      throw new WebConsoleError("console_tool_delivery_unknown", "Console delivery is unknown. Do not automatically retry this operation.", 502);
    }
    let parsed: Record<string, unknown> | undefined;
    try { parsed = asRecord(JSON.parse(await readBoundedResponse(response))); } catch {
      throw new WebConsoleError("console_tool_delivery_unknown", "Console response is unavailable. Do not automatically retry this operation.", 502);
    }
    if (!response.ok) {
      const code = errorCode(parsed, "console_tool_failed");
      // The callback emits controlled validation messages only; never reflect an arbitrary server body.
      throw new WebConsoleError(code, code === "project_busy" ? "Wait for current conversation turns before deleting or archiving this project." : "The console refused this operation.", response.status);
    }
    if (parsed === undefined) throw new WebConsoleError("console_tool_delivery_unknown", "Invalid console response; do not retry automatically.", 502);
    return parsed;
  };
}

function consoleToolCaller(
  request: ConsoleToolRequester,
  capability: string,
): (operation: import("./console-tools.js").ConsoleToolOperation) => Promise<Record<string, unknown>> {
  return async (operation) => {
    const response = await request(capability, operation);
    const result = asRecord(response.result);
    if (result === undefined) throw new WebConsoleError("console_tool_delivery_unknown", "Invalid console result; do not retry automatically.", 502);
    return result;
  };
}

function errorCode(body: Record<string, unknown> | undefined, fallback: string): string {
  const error = asRecord(body?.error);
  return typeof error?.code === "string" && /^[a-z_]{1,64}$/u.test(error.code) ? error.code : fallback;
}

/** One owner-authenticated call to a channel-conversation endpoint; failures carry a code only. */
async function ownerPost(path: string, body: unknown, options: DeliverWebNotificationOptions): Promise<Record<string, unknown>> {
  const ingress = await readIngressRecord(resolveWebStatePaths(options).notificationIngress);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL(path, ingress.url).href, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { authorization: `Bearer ${ingress.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    throw new WebConsoleError("web_console_unavailable", "The web console did not answer.", 503);
  }
  let parsed: Record<string, unknown> | undefined;
  try { parsed = asRecord(JSON.parse(await readBoundedResponse(response))); } catch {
    throw new WebConsoleError("web_console_unavailable", "The web console returned an invalid response.", 502);
  }
  if (!response.ok) throw new WebConsoleError(errorCode(parsed, "web_console_refused"), "The web console refused this request.", response.status);
  if (parsed === undefined) throw new WebConsoleError("web_console_unavailable", "The web console returned an invalid response.", 502);
  return parsed;
}

/** What an owning process observed about one channel conversation. */
export interface WebExternalObservationInput {
  /** Host-owned routing key, `telegram:<bot>:<chat>:<topic|main>`. */
  readonly key: string;
  readonly kind: "topic" | "main";
  readonly chatLabel?: string;
  readonly topicLabel?: string;
  readonly state?: "open" | "closed";
  readonly stateAt?: string;
  readonly seenAt: string;
}

/** Mirror a batch of channel observations into projects. No retry: the caller replays. */
export async function syncWebExternalConversations(
  input: { readonly sourceId: string; readonly channel: "telegram"; readonly observations: readonly WebExternalObservationInput[] },
  options: DeliverWebNotificationOptions = {},
): Promise<{ readonly truncated: boolean }> {
  const result = await ownerPost("/internal/v1/external-conversations", input, options);
  return { truncated: result.truncated === true };
}

export interface BeginWebExternalTurnInput {
  readonly sourceId: string;
  readonly channel: "telegram";
  /** This process's pid: the scope is bound to the discovered process generation. */
  readonly pid: number;
  /** The owning process's own identity for this turn. */
  readonly turnKey: string;
  /** Present only for a conversation that can be a project. */
  readonly key?: string;
  readonly observation?: WebExternalObservationInput;
  /** Ask for a console-tool capability as well as the context. */
  readonly tools: boolean;
}

/** One channel turn's view of the web console. */
export interface WebExternalTurn {
  readonly project?: { readonly id: string; readonly name: string; readonly context: string };
  readonly conversation?: { readonly id: string; readonly label: string; readonly state: "open" | "closed" | "gone" };
  /** Present when a capability was issued. Each call is one operation; no retry. */
  readonly call?: (operation: import("./console-tools.js").ConsoleToolOperation) => Promise<Record<string, unknown>>;
  readonly capabilityError?: string;
  /** Revoke the capability, best effort. Idempotent. */
  revoke(): Promise<void>;
}

/**
 * Read a channel turn's project context and, when asked, a console-tool
 * capability bound to this process and revoked at settlement.
 */
export async function beginWebExternalTurn(
  input: BeginWebExternalTurnInput,
  options: DeliverWebNotificationOptions = {},
): Promise<WebExternalTurn> {
  const ingress = await readIngressRecord(resolveWebStatePaths(options).notificationIngress);
  const result = await ownerPost("/internal/v1/external-turns", input, options);
  const project = asRecord(result.project);
  const conversation = asRecord(result.conversation);
  if ((result.project !== null && (project === undefined || typeof project.id !== "string" || typeof project.name !== "string" || typeof project.context !== "string"))
    || (result.conversation !== null && (conversation === undefined || typeof conversation.id !== "string" || typeof conversation.label !== "string"
      || !["open", "closed", "gone"].includes(conversation.state as string)))) {
    throw new WebConsoleError("web_console_unavailable", "The web console returned an invalid channel turn.", 502);
  }
  const capability = typeof result.capability === "string" && /^[a-zA-Z0-9_-]{40,128}$/u.test(result.capability) ? result.capability : undefined;
  let revoked = false;
  return {
    ...(project === undefined ? {} : { project: { id: project.id as string, name: project.name as string, context: project.context as string } }),
    ...(conversation === undefined ? {} : { conversation: { id: conversation.id as string, label: conversation.label as string, state: conversation.state as "open" | "closed" | "gone" } }),
    ...(capability === undefined ? {} : { call: consoleToolCaller(consoleToolRequester(ingress, options), capability) }),
    ...(typeof result.capabilityError === "string" && /^[a-z_]{1,64}$/u.test(result.capabilityError) ? { capabilityError: result.capabilityError } : {}),
    async revoke() {
      if (capability === undefined || revoked) return;
      revoked = true;
      await (options.fetchImpl ?? fetch)(new URL("/internal/v1/console-tools/revoke", ingress.url).href, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" }, body: "{}",
      }).then((response) => response.body?.cancel()).catch(() => undefined);
    },
  };
}

/** Resolve a project to its bound channel conversation's host-owned key, for a send. */
export async function resolveWebExternalProjectDestination(
  input: { readonly sourceId: string; readonly channel: "telegram"; readonly projectId: string },
  options: DeliverWebNotificationOptions = {},
): Promise<{ readonly key: string; readonly label: string }> {
  const result = await ownerPost("/internal/v1/external-destinations", input, options);
  if (typeof result.key !== "string" || typeof result.label !== "string") {
    throw new WebConsoleError("web_console_unavailable", "The web console returned an invalid destination.", 502);
  }
  return { key: result.key, label: result.label };
}

/** Record that a send proved a channel conversation gone. */
export async function markWebExternalConversationGone(
  input: { readonly sourceId: string; readonly channel: "telegram"; readonly key: string },
  options: DeliverWebNotificationOptions = {},
): Promise<void> {
  await ownerPost("/internal/v1/external-conversations/gone", input, options);
}
