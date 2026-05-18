import { describe, expect, it } from "vitest";

import {
  createRuntimeResponder,
  RuntimeResponderError,
} from "../runtime-responder.js";
import type { AgentRequest } from "../adapter.js";
import type { AgentMessageStream } from "../message-stream.js";
import type { RuntimeRunOptions } from "../runtime-responder.js";

describe("createRuntimeResponder", () => {
  it("passes Slack requests into the runtime and streams assistant events", async () => {
    const events: unknown[] = [];
    let runOptions: RuntimeRunOptions | undefined;
    const responder = createRuntimeResponder({
      runtime: {
        async run(_systemPrompt, options) {
          runOptions = options;
          options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
          return { text: "final", model: "fake-model" };
        },
      },
      systemPrompt: "You are helpful.",
      model: { sdk: "fake", model: "fake-model" },
      runtimeOptions: {
        onEvent(event) {
          events.push(event);
        },
      },
    });
    const stream = new MemoryStream();

    const response = await responder.respond(slackRequest("hello"), stream);

    expect(runOptions).toMatchObject({
      messages: [{ role: "user", content: "hello" }],
      model: { sdk: "fake", model: "fake-model" },
    });
    expect(stream.text).toBe("partial");
    expect(events).toHaveLength(1);
    expect(response).toMatchObject({
      text: "final",
      metadata: { runtime: { model: "fake-model" } },
    });
  });

  it("throws explicit runtime errors instead of returning fake success", async () => {
    const responder = createRuntimeResponder({
      runtime: {
        async run() {
          return { error: "provider failed", failureKind: "provider_unavailable" };
        },
      },
      systemPrompt: "You are helpful.",
      model: { sdk: "fake", model: "fake-model" },
    });

    await expect(responder.respond(slackRequest("hello"), new MemoryStream())).rejects.toBeInstanceOf(RuntimeResponderError);
  });
});

class MemoryStream implements AgentMessageStream {
  text = "";

  async status(_text: string): Promise<void> {}

  async append(delta: string): Promise<void> {
    this.text += delta;
  }

  async replace(text: string): Promise<void> {
    this.text = text;
  }

  async finish(finalText?: string): Promise<void> {
    if (finalText !== undefined) {
      this.text = finalText;
    }
  }
}

function slackRequest(text: string): AgentRequest {
  return {
    conversationId: "slack:D1:171.000001",
    channelId: "D1",
    messageTs: "171.000001",
    threadTs: "171.000001",
    eventId: "Ev1",
    teamId: "T1",
    userId: "U1",
    text,
    trigger: "direct",
    abortSignal: new AbortController().signal,
    metadata: {
      slack: {
        teamId: "T1",
        apiAppId: "A1",
        eventId: "Ev1",
        channel: { id: "D1", type: "im" },
        message: { ts: "171.000001" },
        user: { id: "U1" },
        trigger: "direct",
      },
    },
  };
}
