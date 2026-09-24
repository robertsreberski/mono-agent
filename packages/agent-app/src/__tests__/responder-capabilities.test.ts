import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createAgentResponder } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import { createConfiguredAgentHarness } from "../configured-agent.js";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { startTuiAdapter } from "@mono-agent/operator-adapter";

import { createSlackPostedReplyHistory } from "../posted-reply-history.js";
import { bindProcessJobWakeContextToResponder } from "../process-jobs-context.js";

// Keep this inventory tied to the shared contract: a new optional capability
// must be considered by the app's explicit responder decorators.
const optionalResponderKeys = [
  "liveInputOwnership",
  "compactConversation",
  "offerLiveInput",
  "cancel",
  "deliverVerbatim",
  "importContext",
  "openReplyArtifact",
  "loadMcpApp",
  "requestMcpApp",
] as const satisfies readonly Exclude<keyof AgentResponder, "respond">[];
type UnlistedResponderKey = Exclude<keyof AgentResponder, "respond" | (typeof optionalResponderKeys)[number]>;
const noUnlistedResponderKeys: UnlistedResponderKey extends never ? true : never = true;
void noUnlistedResponderKeys;

describe("app responder decorators", () => {
  it("retains a bound manual compaction capability across posted-reply and process-job wrappers", async () => {
    const inner: AgentResponder & { name: string } = {
      name: "inner",
      respond: async () => ({ text: "ok" }),
      compactConversation: vi.fn(function (this: typeof inner, conversationId: string) {
        expect(this).toBe(inner);
        expect(conversationId).toBe("web:thread");
        return Promise.resolve({ status: "succeeded" as const, operationId: "compact-1", trigger: "manual" as const });
      }),
    };
    const postedReplyHistory = createSlackPostedReplyHistory({ maxMessages: 64 });
    // The two allowlist decorators are the last stages of app-controller-responder's
    // replyArtifacts -> mcpApps -> postedReplyHistory -> processJobWake composition.
    const responder = bindProcessJobWakeContextToResponder(postedReplyHistory.wrapResponder(inner));

    expect(typeof responder.compactConversation).toBe("function");
    expect(await responder.compactConversation?.("web:thread", { model: "openai:test" })).toEqual({
      status: "succeeded", operationId: "compact-1", trigger: "manual",
    });
    expect(inner.compactConversation).toHaveBeenCalledWith("web:thread", { model: "openai:test" });

    const operator = await startTuiAdapter({ responder });
    try {
      const info = await (await fetch(operator.infoUrl)).json() as {
        capabilities: { manualCompaction?: { version: number } };
      };
      expect(info.capabilities.manualCompaction).toEqual({ version: 1 });
    } finally {
      await operator.stop();
    }
  });
});

it("advertises and executes manual compaction from a configured harness through the operator route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "configured-manual-compaction-"));
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are a test agent.");
  const config: MonoAgentConfig = {
    runtime: { model: { provider: "faux", model: "test", reference: "faux:test" }, workspace: dir,
      session: { mode: "continuous", idleTimeoutMs: 60_000 } },
    providers: { piNative: { piSessionsRoot: join(dir, "pi") } },
    context: { identityPath, selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(dir, "artifacts"), retention: { maxAgeDays: 365, maxCount: 100, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 100, dryRun: false } },
    traceability: { registryDir: join(dir, "sources") },
  };
  const calls: RuntimeRunOptions[] = [];
  let releaseCompaction: (() => void) | undefined;
  const runtime = {
    async run(_prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
      calls.push(options);
      if ((options as RuntimeRunOptions & { manualCompaction?: boolean }).manualCompaction === true) {
        await new Promise<void>((resolve) => { releaseCompaction = resolve; });
        return { providerSessionId: options.sessionId as string, manualCompaction: {
            status: "succeeded", trigger: "manual", operationId: "compact-test", tokensBefore: 1000,
            tokensAfter: 300, tokenCountsExact: false,
          } } as RuntimeResult;
      }
      return { text: "test answer", providerSessionId: options.sessionId as string };
    },
    async syncSession() { return true; },
    async refreshSession() {},
    async retireDurableSession() {},
    async invalidateSession() { return true; },
    async disposeSession() { return true; },
  };
  let harness: Awaited<ReturnType<typeof createConfiguredAgentHarness>> | undefined;
  let operator: Awaited<ReturnType<typeof startTuiAdapter>> | undefined;
  try {
    harness = await createConfiguredAgentHarness({ config, cwd: dir, runtime });
    const postedReplyHistory = createSlackPostedReplyHistory({ maxMessages: 64 });
    const responder = bindProcessJobWakeContextToResponder(postedReplyHistory.wrapResponder(
      createAgentResponder({ harness }),
    ));
    expect(typeof responder.compactConversation).toBe("function");
    operator = await startTuiAdapter({ host: "127.0.0.1", port: 0, responder });
    const info = await (await fetch(operator.infoUrl)).json() as { capabilities: { manualCompaction?: { version: number } } };
    expect(info.capabilities.manualCompaction).toEqual({ version: 1 });
    const url = `${operator.baseUrl}/v1/conversations/${encodeURIComponent("web:thread")}/compact`;
    const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const empty = await post();
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ status: "skipped", reason: "nothing_to_compact" });
    await responder.respond({ conversationId: "web:thread", text: "First turn", abortSignal: new AbortController().signal },
      { append: async () => {} });
    const pending = post();
    await vi.waitFor(() => { expect(releaseCompaction).toBeTypeOf("function"); });
    const busy = await post();
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "compaction_busy" } });
    releaseCompaction?.();
    const compacted = await pending;
    expect(compacted.status).toBe(200);
    expect(await compacted.json()).toMatchObject({ status: "succeeded", trigger: "manual", operationId: "compact-test",
      tokensBefore: 1000, tokensAfter: 300 });
    expect(calls.map((call) => (call as RuntimeRunOptions & { manualCompaction?: boolean }).manualCompaction)).toEqual([undefined, true]);
    expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
    expect(calls[1]?.messages).toEqual([]);
  } finally {
    await operator?.stop();
    await harness?.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});
