import {
  CronOperatorWireError,
  parseCronOperatorJob,
  parseCronOperatorOverview,
  parseCronOperatorRunDetail,
  parseCronOperatorRunPage,
  parseCronOperatorRunSummary,
  parseAgentStreamFrame,
  type AgentLiveInputSettlement,
  type AgentLiveInputUnavailableReason,
  type AgentAttachment,
  type AgentStreamWireFrame,
  type AgentToolEnvironment,
  type ChannelAskAnswer,
  type ChannelAskSnapshot,
  type ChannelAskSubmissionResult,
} from "@mono-agent/agent-contracts";

import type {
  WebChannelConfigView,
  WebCronJob,
  WebCronMutationResult,
  WebCronOverview,
  WebCronRun,
  WebCronRunDetail,
  WebCronRunPage,
  WebCronRunSummary,
  WebModelOption,
  WebSkillInfo,
  WebSkillRegistry,
} from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import { isTrustedOperatorBaseUrl } from "./discovery.js";

const OPERATOR_WIRE_SCHEMA = 1;
const MAX_INFO_BODY_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_NDJSON_FRAME_BYTES = 8 * 1024 * 1024;
const CANCEL_TIMEOUT_MS = 2_000;
const HISTORY_APPEND_TIMEOUT_MS = 5_000;
const MAX_SKILL_ITEMS = 256;
const MAX_SKILL_DESCRIPTION_BYTES = 256;
const MAX_SKILL_NAME_BYTES = 256;
const MAX_SKILL_REGISTRY_BYTES = 256 * 1024;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

type OperatorSkillRegistry =
  | Extract<WebSkillRegistry, { readonly status: "ready" }>
  | { readonly status: "error"; readonly items: readonly [] };

export interface OperatorConnection {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export interface OperatorInfo {
  readonly schema: number;
  readonly label?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly models?: readonly string[];
  readonly modelOptions?: Readonly<Record<string, WebModelOption>>;
  /** Live registry snapshot. Absent when the producer predates skill discovery. */
  readonly skills?: OperatorSkillRegistry;
  readonly supportsAttachments: boolean;
  readonly supportsHistoryAppend: boolean;
  readonly supportsAskUser: boolean;
  readonly supportsAskById?: boolean;
  readonly supportsLiveInput: boolean;
  readonly supportsToolEnvironment?: boolean;
  readonly cron?: { readonly read: true; readonly actions: boolean };
}

export type OperatorLiveInputResult =
  | AgentLiveInputSettlement
  | { readonly status: "unavailable"; readonly reason: AgentLiveInputUnavailableReason };

export interface OperatorLiveInputInput {
  readonly conversationId: string;
  readonly id: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly signal?: AbortSignal;
}

export interface OperatorTurnInput {
  readonly conversationId: string;
  readonly text: string;
  readonly attachments: readonly AgentAttachment[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly client?: "web" | "acp";
  readonly toolEnvironment?: AgentToolEnvironment;
  readonly signal: AbortSignal;
  readonly onFrame: (frame: AgentStreamWireFrame) => void | Promise<void>;
}

export interface OperatorTurnResult {
  readonly finalText?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OperatorClientOptions extends OperatorConnection {
  readonly fetchImpl?: typeof fetch;
}

export class OperatorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OperatorClientOptions) {
    if (!isTrustedOperatorBaseUrl(options.baseUrl)) {
      throw new WebConsoleError("untrusted_operator_url", "Refusing to connect to a non-loopback operator endpoint.", 400);
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async info(signal?: AbortSignal): Promise<OperatorInfo> {
    const response = await this.request(`${this.baseUrl}/v1/info`, {
      headers: this.headers(false),
      ...(signal === undefined ? {} : { signal }),
    });
    let raw: unknown;
    try {
      raw = JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_info_too_large")) as unknown;
    } catch (error) {
      if (error instanceof WebConsoleError) throw error;
      throw new WebConsoleError("invalid_operator_info", "The agent returned invalid operator metadata JSON.", 502);
    }
    const body = record(raw);
    if (body === undefined || typeof body.schema !== "number") {
      throw new WebConsoleError("invalid_operator_info", "The agent returned invalid operator metadata.", 502);
    }
    if (body.schema !== OPERATOR_WIRE_SCHEMA) {
      throw new WebConsoleError("unsupported_operator_schema", `Agent operator schema ${body.schema} is not supported.`, 502);
    }
    const models = stringArray(body.models);
    const modelOptions = parseModelOptions(body.modelOptions);
    const skills = parseSkillRegistry(body.skills);
    const capabilities = record(body.capabilities);
    const cron = record(capabilities?.cron);
    return {
      schema: body.schema,
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
      ...(models === undefined ? {} : { models }),
      ...(modelOptions === undefined ? {} : { modelOptions }),
      ...(skills === undefined ? {} : { skills }),
      supportsAttachments: capabilities?.attachments === true,
      supportsHistoryAppend: capabilities?.historyAppend === true,
      supportsAskUser: capabilities?.askUser === true,
      ...(capabilities?.askById === true ? { supportsAskById: true } : {}),
      supportsLiveInput: capabilities?.liveInput === true,
      ...(capabilities?.toolEnvironment === true ? { supportsToolEnvironment: true } : {}),
      ...(cron?.read === true ? { cron: { read: true, actions: cron.actions === true } } : {}),
    };
  }

  async turn(input: OperatorTurnInput): Promise<OperatorTurnResult> {
    const response = await this.request(`${this.baseUrl}/v1/turns`, {
      method: "POST",
      headers: this.headers(true),
      signal: input.signal,
      body: JSON.stringify({
        conversationId: input.conversationId,
        text: input.text,
        client: input.client ?? "web",
        metadata: input.metadata,
        ...(input.toolEnvironment === undefined ? {} : { toolEnvironment: input.toolEnvironment }),
        ...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
      }),
    });
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/x-ndjson")) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebConsoleError("invalid_operator_content_type", "The agent turn endpoint did not return NDJSON.", 502);
    }
    if (response.body === null) {
      throw new WebConsoleError("empty_operator_stream", "The agent returned an empty response stream.", 502);
    }
    try {
      for await (const line of readBoundedNdjsonLines(response.body, MAX_NDJSON_FRAME_BYTES)) {
        if (line.trim().length === 0) continue;
        const frame = parseAgentStreamFrame(line);
        if (frame.kind === "finish") {
          return {
            ...(frame.finalText === undefined ? {} : { finalText: frame.finalText }),
            ...(frame.metadata === undefined ? {} : { metadata: frame.metadata }),
          };
        }
        if (frame.kind === "error") {
          const error = new WebConsoleError(
            frame.code ?? (frame.cancelled === true ? "cancelled" : "agent_error"),
            frame.message,
            frame.cancelled === true ? 409 : 502,
          ) as WebConsoleError & { cancelled?: boolean };
          error.cancelled = frame.cancelled === true;
          throw error;
        }
        await input.onFrame(frame);
      }
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
    throw new WebConsoleError("incomplete_operator_stream", "The agent stream ended without a terminal frame.", 502);
  }

  async cancel(conversationId: string): Promise<void> {
    await this.request(`${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/cancel`, {
      method: "POST",
      headers: this.headers(false),
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    }).then(async (response) => {
      await response.body?.cancel().catch(() => undefined);
    });
  }

  async liveInput(input: OperatorLiveInputInput): Promise<OperatorLiveInputResult> {
    const response = await this.request(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(input.conversationId)}/live-input`,
      {
        method: "POST",
        headers: this.headers(true),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        body: JSON.stringify({ id: input.id, text: input.text, receivedAt: input.receivedAt }),
      },
    );
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_live_input_too_large")));
    if (body === undefined || typeof body.status !== "string") {
      throw new WebConsoleError("invalid_operator_live_input", "The agent returned an invalid live-input response.", 502);
    }
    if (body.status === "applied" && typeof body.runId === "string") {
      return { status: "applied", runId: body.runId };
    }
    if (body.status === "discarded" && body.reason === "cancelled") {
      return { status: "discarded", reason: "cancelled" };
    }
    if (
      body.status === "requeue"
      && (body.reason === "unsupported" || body.reason === "closed" || body.reason === "failed")
    ) {
      return { status: "requeue", reason: body.reason };
    }
    if (
      body.status === "unavailable"
      && (body.reason === "inactive" || body.reason === "unsupported" || body.reason === "too_large" || body.reason === "full" || body.reason === "invalid")
    ) {
      return { status: "unavailable", reason: body.reason };
    }
    throw new WebConsoleError("invalid_operator_live_input", "The agent returned an invalid live-input settlement.", 502);
  }

  async recordVerbatim(conversationId: string, text: string, idempotencyKey: string): Promise<void> {
    await this.request(`${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/verbatim`, {
      method: "POST",
      headers: this.headers(true),
      signal: AbortSignal.timeout(HISTORY_APPEND_TIMEOUT_MS),
      body: JSON.stringify({ text, idempotencyKey }),
    }).then(async (response) => {
      await response.body?.cancel().catch(() => undefined);
    });
  }

  async pendingAsk(conversationId: string, signal?: AbortSignal): Promise<ChannelAskSnapshot | undefined> {
    const response = await this.request(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/ask`,
      {
        headers: this.headers(false),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_ask_too_large")));
    return body?.ask === null ? undefined : body?.ask as ChannelAskSnapshot | undefined;
  }

  async ask(interactionId: string, signal?: AbortSignal): Promise<ChannelAskSnapshot | undefined> {
    const response = await this.request(
      `${this.baseUrl}/v1/interactions/${encodeURIComponent(interactionId)}`,
      { headers: this.headers(false), ...(signal === undefined ? {} : { signal }) },
    );
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_ask_too_large")));
    return body?.ask === null ? undefined : body?.ask as ChannelAskSnapshot | undefined;
  }

  async cronOverview(signal?: AbortSignal): Promise<Omit<WebCronOverview, "jobs"> & {
    readonly jobs: readonly Omit<WebCronJob, "threadId">[];
  }> {
    const response = await this.request(`${this.baseUrl}/v1/cron`, {
      headers: this.headers(false),
      ...(signal === undefined ? {} : { signal }),
    });
    return parseCronOverview(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_cron_too_large")));
  }

  async cronRuns(jobId: string, input: {
    readonly limit: number;
    readonly before?: string;
    readonly signal?: AbortSignal;
  }): Promise<WebCronRunPage> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.before !== undefined) query.set("before", input.before);
    const response = await this.request(
      `${this.baseUrl}/v1/cron/jobs/${encodeURIComponent(jobId)}/runs?${query.toString()}`,
      {
        headers: this.headers(false),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    return parseCronRunPage(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_cron_too_large")));
  }

  async cronRun(jobId: string, runId: string, signal?: AbortSignal): Promise<WebCronRunDetail> {
    const response = await this.request(
      `${this.baseUrl}/v1/cron/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}`,
      {
        headers: this.headers(false),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_cron_too_large")));
    if (!hasOnlyKeys(body, ["run"])) return invalidCronResponse();
    return parseCronRunDetail(body.run);
  }

  async cronConfigView(signal?: AbortSignal): Promise<WebChannelConfigView> {
    const response = await this.request(`${this.baseUrl}/v1/cron/config-view`, {
      headers: this.headers(false),
      ...(signal === undefined ? {} : { signal }),
    });
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_cron_too_large")));
    return parseCronConfigView(body?.configView);
  }

  async cronRunNow(
    jobId: string,
    input: { readonly idempotencyKey: string; readonly confirmationToken?: string },
    signal?: AbortSignal,
  ): Promise<WebCronMutationResult<{ readonly run: WebCronRunSummary }>> {
    const result = await this.cronMutation(
      `${this.baseUrl}/v1/cron/jobs/${encodeURIComponent(jobId)}/run`,
      input,
      signal,
    );
    if (result.kind === "confirmation_required") return result;
    const value = record(result.value);
    if (value === undefined) invalidCronResponse();
    if (!hasOnlyKeys(value, ["run"])) return invalidCronResponse();
    return { ...result, value: { run: parseCronRunSummary(value.run) } };
  }

  async cronSetEffectiveEnabled(
    jobId: string,
    enabled: boolean,
    input: { readonly idempotencyKey: string; readonly confirmationToken?: string },
    signal?: AbortSignal,
  ): Promise<WebCronMutationResult<{ readonly job: Omit<WebCronJob, "threadId"> }>> {
    const result = await this.cronMutation(
      `${this.baseUrl}/v1/cron/jobs/${encodeURIComponent(jobId)}/effective-enabled`,
      { ...input, enabled },
      signal,
    );
    if (result.kind === "confirmation_required") return result;
    const value = record(result.value);
    if (value === undefined) invalidCronResponse();
    if (!hasOnlyKeys(value, ["job"])) return invalidCronResponse();
    return { ...result, value: { job: parseCronJob(value.job) } };
  }

  async submitAsk(
    conversationId: string,
    interactionId: string,
    answers: readonly ChannelAskAnswer[],
    signal?: AbortSignal,
  ): Promise<ChannelAskSubmissionResult> {
    const response = await this.request(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/ask`,
      {
        method: "POST",
        headers: this.headers(true),
        ...(signal === undefined ? {} : { signal }),
        body: JSON.stringify({ interactionId, answers }),
      },
    );
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_ask_too_large")));
    if (body === undefined || typeof body.accepted !== "boolean") {
      throw new WebConsoleError("invalid_operator_ask", "The agent returned an invalid AskUser response.", 502);
    }
    return body as unknown as ChannelAskSubmissionResult;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
    };
  }

  private async cronMutation(
    url: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<WebCronMutationResult<unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(true),
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw new WebConsoleError("agent_unreachable", `Agent is unreachable (${errorMessage(error)}).`, 502);
    }
    if (response.status !== 200 && response.status !== 428) {
      const detail = await readBodyPrefix(response, MAX_ERROR_BODY_BYTES).catch(() => "");
      throw new WebConsoleError(
        response.status === 401 ? "agent_unauthorized" : "agent_http_error",
        `Agent responded ${response.status}${detail.length === 0 ? "." : `: ${detail.slice(0, 300)}`}`,
        502,
      );
    }
    const parsed = JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_cron_too_large")) as unknown;
    return parseCronMutation(parsed);
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, redirect: "error" });
    } catch (error) {
      if (init.signal?.aborted === true) throw error;
      throw new WebConsoleError("agent_unreachable", `Agent is unreachable (${errorMessage(error)}).`, 502);
    }
    if (!response.ok && !response.headers.get("content-type")?.includes("application/x-ndjson")) {
      const detail = await readBodyPrefix(response, MAX_ERROR_BODY_BYTES).catch(() => "");
      throw new WebConsoleError(
        response.status === 401 ? "agent_unauthorized" : "agent_http_error",
        `Agent responded ${response.status}${detail.length === 0 ? "." : `: ${detail.slice(0, 300)}`}`,
        502,
      );
    }
    return response;
  }
}

function invalidCronResponse(): never {
  throw new WebConsoleError("invalid_operator_cron", "The agent returned invalid cron operator data.", 502);
}

function parseCronOverview(value: unknown): Omit<WebCronOverview, "jobs"> & {
  readonly jobs: readonly Omit<WebCronJob, "threadId">[];
} {
  return parseSharedCron(parseCronOperatorOverview, value);
}

function parseCronJob(value: unknown): Omit<WebCronJob, "threadId"> {
  return parseSharedCron(parseCronOperatorJob, value);
}

function parseCronRunSummary(value: unknown): WebCronRunSummary {
  return parseSharedCron(parseCronOperatorRunSummary, value);
}

function parseCronRunDetail(value: unknown): WebCronRunDetail {
  return parseSharedCron(parseCronOperatorRunDetail, value);
}

function parseCronRunPage(value: unknown): WebCronRunPage {
  return parseSharedCron(parseCronOperatorRunPage, value);
}

function parseSharedCron<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof CronOperatorWireError) return invalidCronResponse();
    throw error;
  }
}

function parseCronConfigView(value: unknown): WebChannelConfigView {
  const view = record(value);
  if (view === undefined
    || typeof view.id !== "string"
    || typeof view.label !== "string"
    || (view.status !== "active" && view.status !== "disabled")
    || !Array.isArray(view.fields)) return invalidCronResponse();
  const fields = view.fields.map((value) => {
    const field = record(value);
    if (field === undefined
      || typeof field.id !== "string"
      || typeof field.label !== "string"
      || typeof field.value !== "string"
      || !["env", "json", "default"].includes(String(field.source))
      || (field.redacted !== undefined && typeof field.redacted !== "boolean")
      || (field.envKey !== undefined && typeof field.envKey !== "string")) return invalidCronResponse();
    return field as unknown as WebChannelConfigView["fields"][number];
  });
  return { id: view.id, label: view.label, status: view.status, fields };
}

function parseCronMutation(value: unknown): WebCronMutationResult<unknown> {
  const mutation = record(value);
  if (mutation?.kind === "confirmation_required") {
    const confirmation = record(mutation.confirmation);
    if (!hasOnlyKeys(mutation, ["kind", "confirmation"])
      || !hasOnlyKeys(confirmation, ["token", "expiresAt", "message"])
      || typeof confirmation.token !== "string"
      || !validDateString(confirmation.expiresAt)
      || typeof confirmation.message !== "string") return invalidCronResponse();
    return {
      kind: "confirmation_required",
      confirmation: {
        token: confirmation.token,
        expiresAt: confirmation.expiresAt,
        message: confirmation.message,
      },
    };
  }
  if (mutation?.kind === "completed"
    && hasOnlyKeys(mutation, ["kind", "value", "replayed"])
    && mutation.value !== undefined
    && typeof mutation.replayed === "boolean") {
    return { kind: "completed", value: mutation.value, replayed: mutation.replayed };
  }
  return invalidCronResponse();
}

function parseSkillRegistry(
  value: unknown,
): OperatorSkillRegistry | undefined {
  if (value === undefined) return undefined;
  const registry = record(value);
  if (
    registry !== undefined
    && Buffer.byteLength(JSON.stringify(registry), "utf8") > MAX_SKILL_REGISTRY_BYTES
  ) {
    return { status: "error", items: [] };
  }
  if (registry?.status === "error") return { status: "error", items: [] };
  if (registry?.status !== "ready" || !Array.isArray(registry.items)) {
    return { status: "error", items: [] };
  }
  if (
    !Number.isSafeInteger(registry.total)
    || (registry.total as number) < registry.items.length
    || registry.items.length > MAX_SKILL_ITEMS
    || (registry.truncated !== undefined && registry.truncated !== true)
    || (registry.truncated === true) !== ((registry.total as number) > registry.items.length)
  ) {
    return { status: "error", items: [] };
  }
  const items: WebSkillInfo[] = [];
  const names = new Set<string>();
  for (const value of registry.items) {
    const item = parseSkillInfo(value);
    if (item === undefined) continue;
    const key = item.name.toLowerCase();
    if (names.has(key)) {
      return { status: "error", items: [] };
    }
    names.add(key);
    items.push(item);
  }
  return {
    status: "ready",
    items,
    total: registry.total as number,
    ...(registry.truncated === true || items.length < registry.items.length
      ? { truncated: true }
      : {}),
  };
}

function parseSkillInfo(value: unknown): WebSkillInfo | undefined {
  const item = record(value);
  if (
    item === undefined
    || typeof item.name !== "string"
    || item.name.length === 0
    || Buffer.byteLength(item.name, "utf8") > MAX_SKILL_NAME_BYTES
    || typeof item.description !== "string"
    || Buffer.byteLength(item.description, "utf8") > MAX_SKILL_DESCRIPTION_BYTES
    || !["inlined", "on-demand", "unavailable"].includes(String(item.availability))
  ) {
    return undefined;
  }
  if (item.availability === "inlined" || item.availability === "on-demand") {
    if (
      !SKILL_NAME.test(item.name)
      || item.reference !== `$${item.name}`
      || item.unavailableReason !== undefined
    ) return undefined;
    return {
      name: item.name,
      description: item.description,
      availability: item.availability,
      reference: item.reference,
    };
  }
  if (
    item.reference !== undefined
    || !["not-selected", "read-skill-disabled", "unsupported-name"]
      .includes(String(item.unavailableReason))
    || (item.unavailableReason === "unsupported-name") === SKILL_NAME.test(item.name)
  ) {
    return undefined;
  }
  return {
    name: item.name,
    description: item.description,
    availability: "unavailable",
    unavailableReason: item.unavailableReason as NonNullable<WebSkillInfo["unavailableReason"]>,
  };
}

async function readBoundedBody(response: Response, maxBytes: number, code: string): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new WebConsoleError(code, "Agent response exceeded its size limit.", 502);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

async function readBodyPrefix(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return `${Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")}${truncated ? "…" : ""}`;
}

async function* readBoundedNdjsonLines(
  body: ReadableStream<Uint8Array>,
  maxFrameBytes: number,
): AsyncGenerator<string> {
  const reader = body.getReader();
  let segments: Uint8Array[] = [];
  let pendingBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 0x0a) continue;
        const segment = value.subarray(start, index);
        if (pendingBytes + segment.byteLength > maxFrameBytes) {
          throw new WebConsoleError("operator_frame_too_large", "Agent stream frame exceeded its size limit.", 502);
        }
        yield decodeSegments(segments, segment, pendingBytes + segment.byteLength);
        segments = [];
        pendingBytes = 0;
        start = index + 1;
      }
      const remainder = value.subarray(start);
      if (pendingBytes + remainder.byteLength > maxFrameBytes) {
        throw new WebConsoleError("operator_frame_too_large", "Agent stream frame exceeded its size limit.", 502);
      }
      if (remainder.byteLength > 0) {
        segments.push(remainder);
        pendingBytes += remainder.byteLength;
      }
    }
    if (pendingBytes > 0) yield decodeSegments(segments, undefined, pendingBytes);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function decodeSegments(segments: readonly Uint8Array[], tail: Uint8Array | undefined, total: number): string {
  const buffers = segments.map((segment) => Buffer.from(segment));
  if (tail !== undefined && tail.byteLength > 0) buffers.push(Buffer.from(tail));
  return Buffer.concat(buffers, total).toString("utf8");
}

function parseModelOptions(value: unknown): Record<string, WebModelOption> | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const result: Record<string, WebModelOption> = {};
  for (const [model, raw] of Object.entries(input)) {
    const option = record(raw);
    if (option === undefined) continue;
    const effortLevels = stringArray(option.effortLevels);
    result[model] = {
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(typeof option.reasoning === "boolean" ? { reasoning: option.reasoning } : {}),
      ...(typeof option.reasoningMode === "string" ? { reasoningMode: option.reasoningMode } : {}),
      ...(typeof option.label === "string" ? { label: option.label } : {}),
      ...(Number.isSafeInteger(option.contextWindow) && Number(option.contextWindow) > 0
        ? { contextWindow: option.contextWindow as number }
        : {}),
    };
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyKeys(
  value: Record<string, unknown> | undefined,
  allowed: readonly string[],
): value is Record<string, unknown> {
  if (value === undefined) return false;
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function validDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
