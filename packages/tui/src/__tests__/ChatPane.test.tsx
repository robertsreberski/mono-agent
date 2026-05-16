import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "ink-testing-library";

import { ChatPane } from "../components/ChatPane.js";
import { createInMemoryTuiHistory } from "../agent/history.js";
import {
  TuiAgentCancelledError,
  type AgentMessageStreamLike,
  type AgentRequestLike,
  type AgentResponderLike,
  type AgentResponseLike,
} from "../agent/responder.js";

afterEach(() => {
  cleanup();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let idCounter = 0;
const idGenerator = () => `id_${++idCounter}`;
const clock = () => 0;

interface ScriptedTurn {
  readonly deltas?: readonly string[];
  readonly status?: string;
  readonly response?: AgentResponseLike;
  readonly throwAfterDeltas?: () => unknown;
  readonly waitForAbort?: boolean;
}

function scriptedResponder(turns: ScriptedTurn[]): {
  responder: AgentResponderLike;
  calls: AgentRequestLike[];
} {
  const calls: AgentRequestLike[] = [];
  let index = 0;
  return {
    calls,
    responder: {
      async respond(
        request: AgentRequestLike,
        stream: AgentMessageStreamLike,
      ): Promise<AgentResponseLike> {
        calls.push(request);
        const turn = turns[index++];
        if (turn === undefined) {
          throw new Error("scriptedResponder: ran out of turns");
        }
        if (turn.status !== undefined) {
          await stream.status?.(turn.status);
        }
        for (const delta of turn.deltas ?? []) {
          await stream.append(delta);
          await sleep(1);
        }
        if (turn.throwAfterDeltas !== undefined) {
          throw turn.throwAfterDeltas();
        }
        if (turn.waitForAbort) {
          await new Promise<never>((_, reject) => {
            request.abortSignal.addEventListener("abort", () => {
              reject(new TuiAgentCancelledError());
            });
          });
        }
        await stream.finish?.(turn.response?.text);
        return turn.response ?? { text: (turn.deltas ?? []).join("") };
      },
    },
  };
}

async function flushTimersAndMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) {
    await sleep(40);
  }
}

describe("ChatPane", () => {
  it("submits input, streams deltas, and finalises an assistant turn", async () => {
    const history = createInMemoryTuiHistory();
    const { responder, calls } = scriptedResponder([
      { deltas: ["hel", "lo"], response: { text: "hello" } },
    ]);
    const { stdin, lastFrame } = render(
      <ChatPane
        responder={responder}
        history={history}
        conversationId="conv-1"
        active
        idGenerator={idGenerator}
        clock={clock}
      />,
    );

    stdin.write("hi");
    await sleep(20);
    stdin.write("\r");
    await flushTimersAndMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("hi");
    expect(calls[0]?.conversationId).toBe("conv-1");
    expect(history.list().map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history.list()[1]?.text).toBe("hello");
    expect(history.list()[1]?.status).toBe("ok");
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/you/);
    expect(frame).toMatch(/agent/);
  });

  it("renders streamed deltas progressively while in flight", async () => {
    const history = createInMemoryTuiHistory();
    let resolveTurn: ((value: AgentResponseLike) => void) | undefined;
    const responder: AgentResponderLike = {
      async respond(_req, stream) {
        await stream.append("partial-");
        await sleep(10);
        await stream.append("delta");
        await sleep(10);
        await new Promise<AgentResponseLike>((resolve) => {
          resolveTurn = resolve;
        }).then(async (response) => {
          await stream.finish?.(response.text);
        });
        return { text: "partial-delta-final" };
      },
    };
    const { stdin, lastFrame } = render(
      <ChatPane
        responder={responder}
        history={history}
        conversationId="conv-1"
        active
        idGenerator={idGenerator}
        clock={clock}
      />,
    );

    stdin.write("go");
    await sleep(20);
    stdin.write("\r");
    await flushTimersAndMicrotasks(3);

    expect(lastFrame() ?? "").toMatch(/partial-delta/);
    expect(lastFrame() ?? "").toMatch(/streaming/);

    resolveTurn?.({ text: "partial-delta-final" });
    await flushTimersAndMicrotasks();

    expect(history.list().at(-1)?.text).toBe("partial-delta-final");
    expect(history.list().at(-1)?.status).toBe("ok");
  });

  it("escape aborts the in-flight responder and records a cancelled assistant turn", async () => {
    const history = createInMemoryTuiHistory();
    const { responder } = scriptedResponder([
      { deltas: ["working"], waitForAbort: true },
    ]);
    const { stdin, lastFrame } = render(
      <ChatPane
        responder={responder}
        history={history}
        conversationId="conv-1"
        active
        idGenerator={idGenerator}
        clock={clock}
      />,
    );

    stdin.write("slow");
    await sleep(20);
    stdin.write("\r");
    await flushTimersAndMicrotasks(2);
    stdin.write("\u001b"); // escape
    await flushTimersAndMicrotasks();

    const assistant = history.list().at(-1);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.status).toBe("cancelled");
    expect(assistant?.text).toBe("working");
    expect(lastFrame() ?? "").toMatch(/cancelled/);
  });

  it("renders an error block when the responder rejects with a non-cancel error", async () => {
    const history = createInMemoryTuiHistory();
    const { responder } = scriptedResponder([
      {
        deltas: ["start"],
        throwAfterDeltas: () => new Error("upstream blew up"),
      },
    ]);
    const { stdin, lastFrame } = render(
      <ChatPane
        responder={responder}
        history={history}
        conversationId="conv-1"
        active
        idGenerator={idGenerator}
        clock={clock}
      />,
    );

    stdin.write("crash");
    await sleep(20);
    stdin.write("\r");
    await flushTimersAndMicrotasks();

    expect(lastFrame() ?? "").toMatch(/error:/);
    expect(lastFrame() ?? "").toMatch(/upstream blew up/);
    const assistant = history.list().at(-1);
    expect(assistant?.status).toBe("error");
    expect(assistant?.metadata).toMatchObject({ errorMessage: "upstream blew up" });
  });

  it("ignores empty submissions and never invokes the responder", async () => {
    const history = createInMemoryTuiHistory();
    const respond = vi.fn().mockResolvedValue({ text: "" });
    const responder: AgentResponderLike = { respond };
    const { stdin } = render(
      <ChatPane
        responder={responder}
        history={history}
        conversationId="conv-1"
        active
        idGenerator={idGenerator}
        clock={clock}
      />,
    );

    stdin.write("   ");
    await sleep(20);
    stdin.write("\r");
    await flushTimersAndMicrotasks();

    expect(respond).not.toHaveBeenCalled();
    expect(history.list()).toHaveLength(0);
  });
});
