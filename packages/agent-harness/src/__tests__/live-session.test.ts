import { describe, expect, it } from "vitest";

import { isAgentResponseCancelledError } from "@mono-agent/agent-contracts";

import { createLiveSessionManager } from "../live-session.js";
import type { AgentHarnessRequest, AgentHarnessResponse } from "../index.js";

function req(
  conversationId: string,
  userMessage = "hi",
  abortSignal: AbortSignal = new AbortController().signal,
): AgentHarnessRequest {
  return { conversationId, userMessage, abortSignal };
}

function response(text: string, conversationId = "c"): AgentHarnessResponse {
  return {
    text,
    metadata: { runId: "r", conversationId, contextSources: [], contextSectionIds: [] },
  };
}

/** Yield long enough for queued microtasks + a macrotask to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createLiveSessionManager", () => {
  it("runs an enqueued request through the runner and resolves with its response", async () => {
    const manager = createLiveSessionManager({
      run: async (request) => response(`answer:${request.userMessage}`),
    });

    const res = await manager.enqueue("c1", req("c1", "hello"));

    expect(res.text).toBe("answer:hello");
  });

  it("runs same-conversation turns sequentially in FIFO order (queue-after-turn)", async () => {
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const manager = createLiveSessionManager({
      run: async (request) => {
        order.push(`start:${request.userMessage}`);
        await new Promise<void>((resolve) => gates.push(resolve));
        order.push(`end:${request.userMessage}`);
        return response(request.userMessage);
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "one"));
    const p2 = manager.enqueue("c1", req("c1", "two"));
    await flush();

    // Only the first turn has started; the second is queued behind it.
    expect(order).toEqual(["start:one"]);

    gates[0]?.();
    await p1;
    await flush();
    expect(order).toEqual(["start:one", "end:one", "start:two"]);

    gates[1]?.();
    await p2;
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("runs different conversations concurrently (no cross-conversation serialization)", async () => {
    const started: string[] = [];
    const never = new Promise<void>(() => {});
    const manager = createLiveSessionManager({
      run: async (request) => {
        started.push(request.conversationId);
        await never;
        return response("x", request.conversationId);
      },
    });

    void manager.enqueue("a", req("a"));
    void manager.enqueue("b", req("b"));
    await flush();

    expect([...started].sort()).toEqual(["a", "b"]);
  });

  it("reports the count of queued-but-not-yet-started turns", async () => {
    const never = new Promise<void>(() => {});
    const manager = createLiveSessionManager({
      run: async () => {
        await never;
        return response("x");
      },
    });

    void manager.enqueue("c1", req("c1"));
    void manager.enqueue("c1", req("c1"));
    void manager.enqueue("c1", req("c1"));
    await flush();

    // One turn is active (draining); the other two are pending.
    expect(manager.pendingCount("c1")).toBe(2);
  });

  it("cancel aborts the active turn and rejects every queued turn", async () => {
    let activeSignal: AbortSignal | undefined;
    const manager = createLiveSessionManager({
      run: async (request) => {
        activeSignal = request.abortSignal;
        await new Promise<void>((resolve) => {
          request.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          metadata: { runId: "r", conversationId: request.conversationId, contextSources: [], contextSectionIds: [] },
          failure: { kind: "cancelled", message: "aborted" },
        };
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "one"));
    const p2 = manager.enqueue("c1", req("c1", "two"));
    await flush();

    manager.cancel("c1");

    expect(activeSignal?.aborted).toBe(true);
    await expect(p2).rejects.toSatisfy(isAgentResponseCancelledError);
    await expect(p1).resolves.toMatchObject({ failure: { kind: "cancelled" } });
    expect(manager.pendingCount("c1")).toBe(0);
  });

  it("a failing turn rejects only its own promise; the next queued turn still runs", async () => {
    const calls: string[] = [];
    const manager = createLiveSessionManager({
      run: async (request) => {
        calls.push(request.userMessage);
        if (request.userMessage === "boom") {
          throw new Error("kaboom");
        }
        return response(request.userMessage);
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "boom"));
    const p2 = manager.enqueue("c1", req("c1", "ok"));

    await expect(p1).rejects.toThrow("kaboom");
    await expect(p2).resolves.toMatchObject({ text: "ok" });
    expect(calls).toEqual(["boom", "ok"]);
  });

  it("propagates an already-aborted request signal into the run", async () => {
    const controller = new AbortController();
    controller.abort();
    let seen: boolean | undefined;
    const manager = createLiveSessionManager({
      run: async (request) => {
        seen = request.abortSignal.aborted;
        return response("x");
      },
    });

    await manager.enqueue("c1", req("c1", "hi", controller.signal));
    expect(seen).toBe(true);
  });

  it("dispose rejects all in-flight and queued turns and stops accepting new ones", async () => {
    const never = new Promise<void>(() => {});
    const manager = createLiveSessionManager({
      run: async () => {
        await never;
        return response("x");
      },
    });

    const queued = manager.enqueue("c1", req("c1"));
    await flush();
    manager.dispose();

    await expect(queued).rejects.toSatisfy(isAgentResponseCancelledError);
    await expect(manager.enqueue("c1", req("c1"))).rejects.toSatisfy(isAgentResponseCancelledError);
  });
});
