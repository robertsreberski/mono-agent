import {
  AgentResponseCancelledError,
  frameFeedingMessageStream,
  parseAgentStreamFrame,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";

export interface RemoteAgentResponderOptions {
  /** The running agent's tui-adapter base URL, e.g. http://127.0.0.1:52341/tui */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
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
 * AgentResponder over the tui-adapter NDJSON wire: one POST per turn, each
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
  async info(): Promise<{ schema: number; pid?: number; label?: string; model?: string }> {
    const response = await this.request(`${this.baseUrl}/v1/info`, { headers: this.headers(false) });
    return (await response.json()) as { schema: number; pid?: number; label?: string; model?: string };
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
        for (const line of lines) {
          if (line.length === 0) {
            continue;
          }
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
