import { performance } from "node:perf_hooks";
import { rm } from "node:fs/promises";

import { afterEach, expect, it } from "vitest";

import type { WebAgentSummary } from "../contracts.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];
const reproduce = process.env.MONO_AGENT_REPRO_CONSOLE_STALL === "1" ? it : it.skip;

const THREAD_TURNS = 68;
const MESSAGE_TEXT_BYTES = 150_000;
const LARGE_RUNNING_MESSAGE_BYTES = 4_000_000;

function agent(): WebAgentSummary {
  return {
    sourceId: "stall-repro-agent",
    label: "Stall repro",
    status: "online",
    health: "running",
    supportsAttachments: false,
    runSettings: {
      config: {},
      override: null,
      effective: { modelSource: "config", effortSource: "config" },
    },
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

/**
 * Manual performance reproduction for the synchronous transcript read path.
 *
 * Run with:
 *   MONO_AGENT_REPRO_CONSOLE_STALL=1 pnpm exec vitest run \
 *     packages/web/src/__tests__/event-loop-stall.repro.test.ts --reporter=verbose
 *
 * The shape mirrors the observed high-water marks without using owner data:
 * roughly 24 MiB in one thread, about 137 messages, and one 4 MiB running
 * message. This is an opt-in host benchmark rather than a portable CI gate;
 * the budget catches a return to blob-carrying sorts and per-row hydration.
 */
reproduce("blocks the event loop while reading a realistic large transcript", async () => {
  const root = await temporaryRoot();
  cleanup.push(root);
  const store = await WebStore.open({ stateDir: `${root}/state` });
  try {
    store.replaceAgents([agent()]);
    const thread = store.createThread("stall-repro-agent");
    const text = "x".repeat(MESSAGE_TEXT_BYTES);
    for (let index = 0; index < THREAD_TURNS; index += 1) {
      const turn = store.beginTurn({ threadId: thread.id, text, attachmentIds: [] });
      store.applyStreamFrames(turn.turnId, [{ kind: "append", delta: text }]);
      store.completeTurn(turn.turnId);
    }
    const running = store.beginTurn({ threadId: thread.id, text: "running", attachmentIds: [] });
    store.applyStreamFrames(running.turnId, [{ kind: "append", delta: "y".repeat(LARGE_RUNNING_MESSAGE_BYTES) }]);

    // Arm a zero-delay timer before the synchronous read. It cannot run until
    // SQLite, JSON parsing and per-message projection all release this thread.
    const scheduledAt = performance.now();
    const timerDelay = new Promise<number>((resolve) => {
      setTimeout(() => resolve(performance.now() - scheduledAt), 0);
    });
    const readAt = performance.now();
    const detail = store.getThreadDetail(thread.id);
    const readMs = performance.now() - readAt;
    const delayedMs = await timerDelay;
    const storedBytes = detail!.messages.reduce(
      (total, message) => total + Buffer.byteLength(JSON.stringify(message.parts)),
      0,
    );

    console.log(JSON.stringify({
      fixture: {
        threadMessages: 2 * THREAD_TURNS + 2,
        seededTextBytes: 2 * THREAD_TURNS * MESSAGE_TEXT_BYTES + LARGE_RUNNING_MESSAGE_BYTES,
        returnedMessages: detail!.messages.length,
        returnedPartBytes: storedBytes,
      },
      readMs: Number(readMs.toFixed(1)),
      eventLoopTimerDelayMs: Number(delayedMs.toFixed(1)),
    }));

    expect(detail).toBeDefined();
    expect(readMs).toBeLessThan(100);
    expect(delayedMs).toBeLessThan(100);
  } finally {
    store.close();
  }
}, 180_000);
