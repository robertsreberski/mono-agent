import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import {
  A2AConsumerError,
  A2AProviderError,
  createA2AAgentCard,
  createA2AConsumer,
  createA2AConsumerResponder,
  loadA2AAdapterConfig,
  redactA2AAdapterConfig,
  sendA2AMessage,
  startA2AProvider,
} from "../index.js";

describe("A2A adapter contract", () => {
  it("creates a v1 Agent Card without secrets and with JSON-RPC and REST interfaces", () => {
    const card = createA2AAgentCard({
      name: "Local Mono",
      description: "Local test agent",
      version: "0.1.0",
      publicBaseUrl: "http://127.0.0.1:4300",
      requireBearer: true,
      provider: {
        organization: "Worklab",
        url: "https://example.com",
      },
      skill: {
        id: "mono-chat",
        name: "Mono Chat",
        description: "Answers text prompts.",
        tags: ["mono", "chat"],
      },
    });

    expect(card.supportedInterfaces).toEqual([
      {
        url: "http://127.0.0.1:4300/a2a/json-rpc",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "",
      },
      {
        url: "http://127.0.0.1:4300/a2a/rest",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        tenant: "",
      },
    ]);
    expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: false });
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
    expect(card.securitySchemes.bearer?.scheme?.$case).toBe("httpAuthSecurityScheme");
    expect(JSON.stringify(card)).not.toContain("secret");
  });

  it("round-trips text over loopback HTTP through provider discovery and consumer send", async () => {
    const responder: AgentResponder = {
      async respond(request, stream) {
        expect(request.conversationId).toEqual(expect.any(String));
        expect(request.metadata?.a2a).toMatchObject({
          taskId: expect.any(String),
          messageId: expect.any(String),
          inputModes: ["text/plain"],
        });
        await stream.append(`echo: ${request.text}`);
        return {};
      },
    };

    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder,
      agent: {
        name: "Echo Mono",
        description: "Echoes text",
        version: "0.1.0",
      },
      skill: {
        id: "echo",
        name: "Echo",
        description: "Echo text",
        tags: ["echo"],
      },
    });

    try {
      const response = await sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
      });
      expect(response.text).toBe("echo: hello");
      expect(response.metadata.a2a).toMatchObject({
        remoteAgentUrl: provider.agentCardUrl,
        protocolVersion: "1.0",
      });
    } finally {
      await provider.stop();
    }
  });

  it("enforces bearer auth on message endpoints while keeping the card discoverable", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      requireBearer: true,
      bearerToken: "top-secret",
      responder: echoResponder(),
      agent: {
        name: "Secure Mono",
        description: "Secure echo",
        version: "0.1.0",
      },
      skill: {
        id: "secure-echo",
        name: "Secure Echo",
        description: "Echo text",
        tags: ["echo"],
      },
    });

    try {
      const cardResponse = await fetch(provider.agentCardUrl);
      expect(cardResponse.status).toBe(200);
      expect(await cardResponse.json()).toMatchObject({ name: "Secure Mono" });

      await expect(sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
      })).rejects.toMatchObject({
        code: "remote_auth_required",
      });

      const authed = await sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        bearerToken: "top-secret",
        text: "hello",
      });
      expect(authed.text).toBe("echo: hello");
    } finally {
      await provider.stop();
    }
  });

  it("rejects non-text-only requests explicitly", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: echoResponder(),
      agent: {
        name: "Text Mono",
        description: "Text only",
        version: "0.1.0",
      },
      skill: {
        id: "text",
        name: "Text",
        description: "Text only",
        tags: ["text"],
      },
    });

    try {
      const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
      await expect(consumer.sendMessage({
        message: {
          messageId: "file-only",
          role: 1,
          parts: [
            {
              content: { $case: "url", value: "file:///tmp/example.txt" },
              mediaType: "text/plain",
              filename: "example.txt",
              metadata: {},
            },
          ],
          contextId: "",
          taskId: "",
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
      })).rejects.toMatchObject({
        code: "remote_rejected",
      });
    } finally {
      await provider.stop();
    }
  });

  it("cancels active responder work through A2A task cancellation", async () => {
    let observedAbort = false;
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((resolve) => {
          request.abortSignal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        return { text: "should not complete" };
      },
    };

    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder,
      agent: {
        name: "Cancelable Mono",
        description: "Can cancel",
        version: "0.1.0",
      },
      skill: {
        id: "cancel",
        name: "Cancel",
        description: "Cancellation",
        tags: ["cancel"],
      },
    });

    try {
      const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
      const task = await consumer.sendMessage({ text: "wait", returnImmediately: true });
      const taskId = task.metadata.a2a.taskId;
      expect(taskId).toEqual(expect.any(String));
      await consumer.cancelTask(taskId as string);
      expect(observedAbort).toBe(true);
    } finally {
      await provider.stop();
    }
  });

  it("returns typed failures for empty remote output", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: {
        async respond() {
          return {};
        },
      },
      agent: {
        name: "Empty Mono",
        description: "No output",
        version: "0.1.0",
      },
      skill: {
        id: "empty",
        name: "Empty",
        description: "No output",
        tags: ["empty"],
      },
    });

    try {
      await expect(sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
      })).rejects.toBeInstanceOf(A2AConsumerError);
      await expect(sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
      })).rejects.toMatchObject({
        code: "empty_a2a_response",
      });
    } finally {
      await provider.stop();
    }
  });

  it("returns a typed timeout error when a remote agent exceeds the consumer timeout", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: {
        async respond() {
          await delay(100);
          return { text: "late response" };
        },
      },
      agent: {
        name: "Slow Mono",
        description: "Responds too slowly",
        version: "0.1.0",
      },
      skill: {
        id: "slow",
        name: "Slow",
        description: "Slow response",
        tags: ["slow"],
      },
    });

    try {
      await expect(sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
        timeoutMs: 10,
      })).rejects.toMatchObject({
        code: "timeout",
        message: "A2A request timed out after 10ms.",
        details: {
          timeoutMs: 10,
          agentUrl: provider.agentCardUrl,
        },
      });
    } finally {
      await provider.stop();
    }
  });

  it("adapts a remote A2A agent as an AgentResponder", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: echoResponder(),
      agent: {
        name: "Remote Mono",
        description: "Remote responder",
        version: "0.1.0",
      },
      skill: {
        id: "remote",
        name: "Remote",
        description: "Remote text",
        tags: ["remote"],
      },
    });

    try {
      const responder = createA2AConsumerResponder({ agentUrl: provider.agentCardUrl });
      const chunks: string[] = [];
      const response = await responder.respond({
        conversationId: "local-conversation",
        text: "hello",
        abortSignal: new AbortController().signal,
      }, {
        async append(delta) {
          chunks.push(delta);
        },
      });
      expect(response.text).toBe("echo: hello");
      expect(chunks.join("")).toContain("echo: hello");
    } finally {
      await provider.stop();
    }
  });

  it("loads optional config from JSON and env with redacted secrets", async () => {
    await expect(loadA2AAdapterConfig({ env: {}, json: {} }))
      .resolves.toMatchObject({ provider: { enabled: false } });

    const config = await loadA2AAdapterConfig({
      env: {
        MONO_AGENT_A2A_PROVIDER_ENABLED: "true",
        MONO_AGENT_A2A_BEARER_TOKEN: "env-token",
        MONO_AGENT_A2A_REMOTE_AGENT_URLS: "http://127.0.0.1:4300, http://127.0.0.1:4301",
      },
      json: {
        a2a: {
          provider: {
            host: "127.0.0.1",
            port: 4300,
            requireBearer: true,
          },
          agent: {
            name: "Configured Mono",
            description: "Configured provider",
            version: "0.1.0",
          },
          skill: {
            id: "configured",
            name: "Configured",
            description: "Configured skill",
            tags: ["configured"],
          },
          consumer: {
            defaultRemoteAgentUrl: "http://127.0.0.1:4300",
            timeoutMs: 1234,
          },
        },
      },
    });

    expect(config.provider).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 4300,
      requireBearer: true,
      bearerToken: "env-token",
    });
    expect(config.consumer.remoteAgentUrls).toEqual([
      "http://127.0.0.1:4300",
      "http://127.0.0.1:4301",
    ]);
    expect(redactA2AAdapterConfig(config)).toMatchObject({
      provider: {
        enabled: true,
        bearerToken: { present: true, redacted: true },
      },
      consumer: {
        bearerToken: { present: false, redacted: true },
      },
    });
    expect(JSON.stringify(redactA2AAdapterConfig(config))).not.toContain("env-token");
  });

  it("fails fast for unsafe provider exposure and invalid enabled config", async () => {
    await expect(loadA2AAdapterConfig({
      env: { MONO_AGENT_A2A_PROVIDER_ENABLED: "true" },
      json: {
        a2a: {
          provider: {
            host: "0.0.0.0",
            port: 4300,
          },
          agent: {
            name: "Unsafe",
            description: "Unsafe",
            version: "0.1.0",
          },
          skill: {
            id: "unsafe",
            name: "Unsafe",
            description: "Unsafe",
            tags: [],
          },
        },
      },
    })).rejects.toBeInstanceOf(A2AProviderError);
  });
});

function echoResponder(): AgentResponder {
  return {
    async respond(request) {
      return { text: `echo: ${request.text}` };
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
