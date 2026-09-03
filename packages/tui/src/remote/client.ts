import {
  AgentResponseCancelledError,
  frameFeedingMessageStream,
  MAX_INFO_BODY_BYTES,
  MAX_INFO_PROVIDER_ID_BYTES,
  MAX_INFO_PROVIDER_ITEMS,
  MAX_INFO_PROVIDER_LABEL_BYTES,
  parseAgentStreamFrame,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";

const MAX_REMOTE_FRAME_BYTES = 1024 * 1024;

export interface RemoteAgentResponderOptions {
  /** The running agent's operator-adapter TUI base URL, e.g. http://127.0.0.1:52341/gui */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Bounded provider summary from `/v1/info` — mirrors the operator-adapter's
 * `TuiProviderInfo` without importing it, so the TUI stays dependency-free.
 * Older agents that omit `providers` degrade to the flat model shortlist.
 *
 * The BOUNDS are not mirrored: they come from `@mono-agent/agent-contracts`, the
 * one place the producer and both consumers read them from. A local copy here
 * is how the console showed 64 vendors for the same agent this client showed 71
 * of — two clients disagreeing about one wire, with no error to explain it.
 */
export interface RemoteProviderInfo {
  readonly id: string;
  readonly label: string;
  readonly modelCount: number;
  readonly totalModelCount?: number;
  readonly source: "builtin" | "custom" | "discovered";
  readonly configured?: true;
}

export class RemoteAgentResponderError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "RemoteAgentResponderError";
    if (code !== undefined) {
      this.code = code;
    }
  }
}

/**
 * AgentResponder over the operator-adapter TUI NDJSON wire: one POST per turn, each
 * received frame replayed onto the local AgentMessageStream in order. Because
 * it implements the same contract as an in-process responder, every UI surface
 * works identically in embedded (`--responder`) and remote (`mono-agent tui`)
 * modes.
 */
export class RemoteAgentResponder implements AgentResponder {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RemoteAgentResponderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
    };
  }

  /** Probe GET /v1/info; throws RemoteAgentResponderError when unreachable/unauthorized. */
  async info(): Promise<{
    schema: number;
    pid?: number;
    label?: string;
    model?: string;
    effort?: string;
    models?: readonly string[];
    modelOptions?: Record<string, { effortLevels?: readonly string[]; reasoning?: boolean; reasoningMode?: string; label?: string }>;
    providers?: readonly RemoteProviderInfo[];
  }> {
    const response = await this.request(`${this.baseUrl}/v1/info`, { headers: this.headers(false) });
    // Read under the SHARED cap rather than `response.json()`. `/v1/info` is
    // polled for the life of the session, and the producer's own fence
    // guarantees a body at or under `MAX_INFO_BODY_BYTES`; a body over it is
    // either not this contract or an agent bounded nowhere else either, and
    // either way buffering it whole is an unbounded allocation per poll. The
    // console's `OperatorClient` already reads to exactly this bound.
    const body = JSON.parse(await readBoundedInfoBody(response)) as {
      schema: number;
      pid?: number;
      label?: string;
      model?: string;
      effort?: unknown;
      models?: unknown;
      modelOptions?: unknown;
      providers?: unknown;
    };
    const { effort, models, modelOptions, providers, ...rest } = body;
    const parsedModelOptions = parseModelOptions(modelOptions);
    const parsedProviders = parseProviders(providers);
    return {
      ...rest,
      // Older agents may omit `effort` entirely, or send a malformed value; either
      // way tolerate it and just leave `effort` unset rather than surfacing garbage.
      ...(typeof effort === "string" ? { effort } : {}),
      // Older agents omit `models`; only surface a well-formed array of strings so
      // the model picker never renders garbage entries.
      ...(Array.isArray(models) && models.every((entry): entry is string => typeof entry === "string")
        ? { models }
        : {}),
      // Older agents omit `modelOptions` entirely; a newer agent sends it keyed by
      // the same ref strings as `models`. Parsed defensively per-entry so one
      // malformed entry never poisons the well-formed rest.
      ...(parsedModelOptions === undefined ? {} : { modelOptions: parsedModelOptions }),
      // Older agents omit `providers`; the picker falls back to the flat model
      // shortlist when this is absent. Parsed defensively so one malformed entry
      // never poisons the rest.
      ...(parsedProviders === undefined ? {} : { providers: parsedProviders }),
    };
  }

  async respond(request: AgentRequestBase, stream: AgentMessageStream): Promise<AgentResponse> {
    const response = await this.request(`${this.baseUrl}/v1/turns`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        conversationId: request.conversationId,
        text: request.text,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      }),
      // Aborting tears down the socket; the adapter aborts the in-flight turn.
      signal: request.abortSignal,
    });
    if (response.body === null) {
      throw new RemoteAgentResponderError("Agent returned an empty stream body.");
    }

    const feed = frameFeedingMessageStream(stream);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        assertRemoteFrameSize(buffered);
        for (const line of lines) {
          if (line.length === 0) {
            continue;
          }
          assertRemoteFrameSize(line);
          const frame = parseAgentStreamFrame(line);
          if (frame.kind === "finish") {
            return {
              ...(frame.finalText === undefined ? {} : { text: frame.finalText }),
              ...(frame.metadata === undefined ? {} : { metadata: frame.metadata }),
            };
          }
          if (frame.kind === "error") {
            if (frame.cancelled === true) {
              throw new AgentResponseCancelledError(frame.message);
            }
            throw new RemoteAgentResponderError(frame.message, frame.code);
          }
          await feed(frame);
        }
        if (done) {
          break;
        }
      }
    } catch (error) {
      if (request.abortSignal.aborted && !(error instanceof AgentResponseCancelledError)) {
        throw new AgentResponseCancelledError();
      }
      throw error;
    } finally {
      // Idempotent; also tears the socket down on early return/throw.
      await reader.cancel().catch(() => undefined);
    }
    throw new RemoteAgentResponderError("Stream ended without a finish or error frame.");
  }

  cancel(conversationId: string): void {
    // Fire-and-forget: cancellation is best-effort and must never block the UI.
    void this.fetchImpl(`${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/cancel`, {
      method: "POST",
      headers: this.headers(false),
    }).catch(() => undefined);
  }

  private async request(url: string, init: Parameters<typeof fetch>[1]): Promise<globalThis.Response> {
    let response: globalThis.Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (init?.signal !== undefined && (init.signal as AbortSignal).aborted) {
        throw new AgentResponseCancelledError();
      }
      throw new RemoteAgentResponderError(
        `Agent is unreachable at ${this.baseUrl} (${error instanceof Error ? error.message : String(error)}).`,
        "unreachable",
      );
    }
    if (!response.ok && response.headers.get("content-type")?.includes("application/x-ndjson") !== true) {
      const detail = await response.text().catch(() => "");
      throw new RemoteAgentResponderError(
        `Agent responded ${response.status} at ${url}${detail.length > 0 ? `: ${detail.slice(0, 300)}` : "."}`,
        response.status === 401 ? "unauthorized" : "http_error",
      );
    }
    return response;
  }
}

/**
 * Buffer a `/v1/info` response under {@link MAX_INFO_BODY_BYTES}, failing as
 * soon as the stream passes it rather than after the whole body has landed.
 */
async function readBoundedInfoBody(response: globalThis.Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INFO_BODY_BYTES) {
        throw new RemoteAgentResponderError(
          `Agent /v1/info body exceeds the ${String(MAX_INFO_BODY_BYTES)}-byte wire limit.`,
          "info_too_large",
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

function assertRemoteFrameSize(frame: string): void {
  if (Buffer.byteLength(frame, "utf8") <= MAX_REMOTE_FRAME_BYTES) return;
  throw new RemoteAgentResponderError(
    `Agent stream frame exceeds the ${String(MAX_REMOTE_FRAME_BYTES)}-byte client limit.`,
    "frame_too_large",
  );
}

/**
 * Defensively parses `/v1/info`'s `modelOptions` field: tolerates absence (an
 * older agent), a non-record payload, and per-entry shape mismatches — a
 * malformed entry is dropped rather than surfacing garbage or throwing. Never
 * returns an empty record; an all-malformed payload degrades to `undefined`,
 * same as an agent that never sent the field.
 */
function parseModelOptions(
  value: unknown,
): Record<string, { effortLevels?: readonly string[]; reasoning?: boolean; reasoningMode?: string; label?: string }> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, { effortLevels?: readonly string[]; reasoning?: boolean; reasoningMode?: string; label?: string }> = {};
  for (const [ref, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const entry = raw as { effortLevels?: unknown; reasoning?: unknown; reasoningMode?: unknown; label?: unknown };
    const parsedEntry: { effortLevels?: readonly string[]; reasoning?: boolean; reasoningMode?: string; label?: string } = {
      ...(Array.isArray(entry.effortLevels) && entry.effortLevels.every((level): level is string => typeof level === "string")
        ? { effortLevels: entry.effortLevels }
        : {}),
      ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
      ...(typeof entry.reasoningMode === "string" ? { reasoningMode: entry.reasoningMode } : {}),
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
    };
    if (Object.keys(parsedEntry).length > 0) {
      result[ref] = parsedEntry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Defensively parses `/v1/info`'s `providers` field: tolerates absence (an
 * older agent that advertises only the flat `models` shortlist), a non-array
 * payload, and per-entry shape mismatches — a malformed entry is dropped rather
 * than surfacing garbage or throwing. Never returns an empty array; an
 * all-malformed/all-empty payload degrades to `undefined`, same as an agent
 * that never sent the field.
 */
function parseProviders(value: unknown): readonly RemoteProviderInfo[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: RemoteProviderInfo[] = [];
  for (const raw of value) {
    // The item cap is a PREFIX window, and the producer knows its size: it
    // orders the providers its own routes use into the front of the list
    // precisely so this cut cannot reach them. Reading from any other order —
    // sorting, filtering or reversing before this loop — throws that away.
    if (result.length >= MAX_INFO_PROVIDER_ITEMS) break;
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0 || typeof entry.label !== "string" || typeof entry.modelCount !== "number") {
      continue;
    }
    if (Buffer.byteLength(entry.id, "utf8") > MAX_INFO_PROVIDER_ID_BYTES) {
      continue;
    }
    if (entry.source !== "builtin" && entry.source !== "custom" && entry.source !== "discovered") {
      continue;
    }
    const parsed: RemoteProviderInfo = {
      id: entry.id,
      // An over-long label costs the label, never the provider: the id alone
      // still selects a working route.
      label: Buffer.byteLength(entry.label, "utf8") > MAX_INFO_PROVIDER_LABEL_BYTES ? entry.id : entry.label,
      modelCount: entry.modelCount,
      ...(typeof entry.totalModelCount === "number" ? { totalModelCount: entry.totalModelCount } : {}),
      source: entry.source,
      ...(entry.configured === true ? { configured: true as const } : {}),
    };
    result.push(parsed);
  }
  return result.length > 0 ? result : undefined;
}
