import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { createChannelUserCancelReason } from "@mono-agent/agent-contracts";
import { createDurableHistoryStore, type AgentHarness } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  createMonoRuntime,
  type MonoRuntimeLike,
  type RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

import { createConfiguredAgentHarness } from "../index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ObservedRuntimeCall {
  readonly prompt: string;
  readonly options: RuntimeRunOptions;
}

interface PiContextMessage {
  readonly role?: string;
  readonly content?: unknown;
}

interface PiContext {
  readonly messages?: readonly PiContextMessage[];
}

function observeRuntime(base: MonoRuntimeLike): {
  readonly runtime: MonoRuntimeLike;
  readonly calls: ObservedRuntimeCall[];
  readonly invalidationErrors: unknown[];
  readonly retirementErrors: unknown[];
} {
  const calls: ObservedRuntimeCall[] = [];
  const invalidationErrors: unknown[] = [];
  const retirementErrors: unknown[] = [];
  return {
    calls,
    invalidationErrors,
    retirementErrors,
    runtime: {
      ...base,
      async run(prompt, options) {
        calls.push({ prompt, options });
        return await base.run(prompt, options);
      },
      async retireDurableSession(providerSessionId, sessionsRoot) {
        try {
          await base.retireDurableSession?.(providerSessionId, sessionsRoot);
        } catch (error) {
          retirementErrors.push(error);
          throw error;
        }
      },
      async invalidateSession(providerSessionId) {
        try {
          return await base.invalidateSession?.(providerSessionId) ?? false;
        } catch (error) {
          invalidationErrors.push(error);
          throw error;
        }
      },
    },
  };
}

function transcriptOf(context: PiContext | undefined): string[] {
  return (context?.messages ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((block): block is { readonly type: "text"; readonly text: string } =>
                typeof block === "object"
                && block !== null
                && "type" in block
                && block.type === "text"
                && "text" in block
                && typeof block.text === "string")
              .map((block) => block.text)
              .join("")
          : "";
      return `${message.role}:${text}`;
    });
}

function contentMessages(options: RuntimeRunOptions): string[] {
  return options.messages.map((message) => `${message.role}:${String(message.content)}`);
}

describe("configured durable Pi history", () => {
  it("replays canonical history once on warm turns and reseeds a fresh epoch after cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-durable-pi-history-"));
    tempDirs.push(dir);
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    const historyRoot = join(dir, ".mono-agent", "history");
    const piSessionsRoot = join(dir, ".mono-agent", "pi-sessions");
    await writeFile(identityPath, "You are Mono.", "utf8");

    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const piModel = faux.getModel();
    const model = {
      provider: "faux",
      model: "faux-model",
      reference: "faux:faux-model",
    } as const;
    const config: MonoAgentConfig = {
      runtime: {
        model,
        maxTurns: 4,
        workspace: dir,
        session: { mode: "continuous", idleTimeoutMs: 60_000 },
      },
      providers: { piNative: { piSessionsRoot } },
      context: { identityPath, selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: {
        dir: artifactDir,
        retention: { maxAgeDays: 365, maxCount: 50_000, dryRun: false },
        memoryRetention: { maxAgeDays: 7, maxCount: 5_000, dryRun: false },
      },
      traceability: { registryDir: join(dir, "trace-sources") },
    };
    const seedStore = createDurableHistoryStore({
      root: historyRoot,
      retireProviderSession: async () => undefined,
    });
    await seedStore.append("durable-conversation", [
      { role: "user", content: "seed-user", timestamp: "2026-07-01T00:00:00.000Z" },
      { role: "assistant", content: "seed-assistant", timestamp: "2026-07-01T00:00:01.000Z" },
    ]);

    let createOnMissContext: PiContext | undefined;
    let warmContext: PiContext | undefined;
    let cancelledContext: PiContext | undefined;
    let freshAfterCancellationContext: PiContext | undefined;
    const cancellation = new AbortController();
    faux.setResponses([
      (context) => {
        createOnMissContext = context as PiContext;
        return fauxAssistantMessage([fauxText("turn-1-assistant")]);
      },
      (context) => {
        warmContext = context as PiContext;
        return fauxAssistantMessage([fauxText("turn-2-assistant")]);
      },
      (context) => {
        cancelledContext = context as PiContext;
        cancellation.abort(createChannelUserCancelReason("Web"));
        return fauxAssistantMessage([fauxText("cancelled-provider-tail")]);
      },
      (context) => {
        freshAfterCancellationContext = context as PiContext;
        return fauxAssistantMessage([fauxText("turn-3-assistant")]);
      },
    ]);

    let firstHarness: AgentHarness | undefined;
    let resumedHarness: AgentHarness | undefined;
    try {
      const firstRuntime = observeRuntime(createMonoRuntime());
      firstHarness = await createConfiguredAgentHarness({
        config,
        cwd: dir,
        runtime: firstRuntime.runtime,
        runtimeOptions: {
          piResolvedModel: piModel,
          piResolvedModels: models,
          effort: "none",
        },
      });

      const first = await firstHarness.run({
        conversationId: "durable-conversation",
        userMessage: "turn-1-user",
        abortSignal: new AbortController().signal,
      });
      expect(first.text).toBe("turn-1-assistant");
      expect(firstRuntime.calls[0]?.prompt).not.toContain("seed-user");
      expect(firstRuntime.calls[0]?.prompt).not.toContain("seed-assistant");
      expect(contentMessages(firstRuntime.calls[0]!.options)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
      ]);
      expect(transcriptOf(createOnMissContext)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
      ]);

      const second = await firstHarness.run({
        conversationId: "durable-conversation",
        userMessage: "turn-2-user",
        abortSignal: new AbortController().signal,
      });
      expect(second.text).toBe("turn-2-assistant");
      expect(contentMessages(firstRuntime.calls[1]!.options)).toEqual(["user:turn-2-user"]);
      expect(transcriptOf(warmContext)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
        "assistant:turn-1-assistant",
        "user:turn-2-user",
      ]);

      const cancelled = await firstHarness.run({
        conversationId: "durable-conversation",
        userMessage: "cancelled-turn-user",
        abortSignal: cancellation.signal,
      });
      expect(cancelled.failure?.kind).toBe("cancelled");
      expect(cancelled.metadata.summary).toMatchObject({
        status: "cancelled",
        failureKind: "cancelled_user",
        cancellationReason: { code: "operator", channel: "Web" },
      });
      expect({
        invalidationErrors: firstRuntime.invalidationErrors,
        retirementErrors: firstRuntime.retirementErrors,
      }).toEqual({ invalidationErrors: [], retirementErrors: [] });
      expect(transcriptOf(cancelledContext)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
        "assistant:turn-1-assistant",
        "user:turn-2-user",
        "assistant:turn-2-assistant",
        "user:cancelled-turn-user",
      ]);
      const historyAfterCancellation = await seedStore.load("durable-conversation");
      expect(historyAfterCancellation.at(-2)).toMatchObject({ role: "user", content: "cancelled-turn-user" });
      expect(historyAfterCancellation.at(-1)).toMatchObject({
        role: "assistant",
        content: expect.stringContaining("Run stopped by the operator."),
      });

      // Simulate process teardown. Cancellation rotated the durable provider
      // epoch, so the next harness must seed a fresh Pi session from canonical
      // history, including the host-authored stopped-turn account.
      await firstHarness.dispose?.();
      firstHarness = undefined;

      const resumedRuntime = observeRuntime(createMonoRuntime());
      resumedHarness = await createConfiguredAgentHarness({
        config,
        cwd: dir,
        runtime: resumedRuntime.runtime,
        runtimeOptions: {
          piResolvedModel: piModel,
          piResolvedModels: models,
          effort: "none",
        },
      });
      const third = await resumedHarness.run({
        conversationId: "durable-conversation",
        userMessage: "turn-3-user",
        abortSignal: new AbortController().signal,
      });
      expect(third.text).toBe("turn-3-assistant");
      expect(resumedRuntime.calls[0]?.prompt).not.toContain("seed-user");
      expect(resumedRuntime.calls[0]?.prompt).not.toContain("turn-1-user");
      expect(contentMessages(resumedRuntime.calls[0]!.options)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
        "assistant:turn-1-assistant",
        "user:turn-2-user",
        "assistant:turn-2-assistant",
        "user:cancelled-turn-user",
        expect.stringContaining("assistant:<cancelled_turn_history version=\"1\">") as unknown as string,
        "user:turn-3-user",
      ]);
      expect(transcriptOf(freshAfterCancellationContext)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
        "assistant:turn-1-assistant",
        "user:turn-2-user",
        "assistant:turn-2-assistant",
        "user:cancelled-turn-user",
        expect.stringContaining("assistant:<cancelled_turn_history version=\"1\">") as unknown as string,
        "user:turn-3-user",
      ]);
    } finally {
      await resumedHarness?.dispose?.();
      await firstHarness?.dispose?.();
    }
  });
});
