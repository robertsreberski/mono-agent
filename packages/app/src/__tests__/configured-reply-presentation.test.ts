import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import type { AgentResponder } from "@mono-agent/contracts";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { afterEach, expect, it, vi } from "vitest";
import { createReplyArtifactService } from "../artifacts/reply-artifacts.js";
import { createConfiguredAgentResponderForApp } from "../composition/configured-agent.js";
import { composeRuntimeOptionExtensions, type RuntimeOptionsExtension } from "../composition/runtime-option-extensions.js";
import { registerAskUserTool } from "../delivery/send-tools/ask-user.js";
import { createRequestScopedMcpRuntimeExtension } from "../mcp/request-scoped-mcp.js";
import { createReplyPartBudget } from "../delivery/reply-part-budget.js";
import { createSuggestRepliesService } from "../request-tools/suggest-replies.js";
import { createRestartProposalService } from "../service/restart/restart-proposal.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const answer = "Take the morning train and bring the printed map.";
const options = ["Show the timetable", "Review another route"];
const fileName = "trip-notes.txt";
const fileContents = "Fictional travel notes.";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(extra?: RuntimeOptionsExtension) {
  const root = await mkdtemp(join(tmpdir(), "configured-reply-presentation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identityPath = join(root, "IDENTITY.md");
  await writeFile(identityPath, "Fictional instructions");
  await writeFile(join(root, fileName), fileContents);
  const modelId = "claude-haiku-5-5";
  const artifactDir = join(root, "artifacts");
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
    runtime: { model: `anthropic:${modelId}`, workspace: root, session: { mode: "continuous", rollover: "none" } },
    context: { identityPath }, artifacts: { dir: artifactDir },
    tools: { allowedTools: ["SuggestReplies", "ProposeRestart", "PublishReplyFile", ...(extra ? ["AskUser"] : [])] },
  } });
  // Script only the provider. The configured responder, Pi loop, request-scoped
  // loopback endpoints and part wrappers still run end to end.
  const faux = fauxProvider({ provider: "anthropic", models: [{ id: modelId, reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests = vi.spyOn(models, "streamSimple");
  const calls = vi.spyOn(Client.prototype, "callTool");
  const runtime = createMonoRuntime({ workspace: root });
  const runs = vi.spyOn(runtime, "run");
  cleanup.push(() => runtime.disposeAllSessions!());
  const budget = createReplyPartBudget();
  const choices = createSuggestRepliesService({ budget });
  const verify = vi.fn(async () => ({ supported: true }));
  const restart = createRestartProposalService({ authority: { verify }, budget });
  const files = createReplyArtifactService({ artifactDir, workspace: root, retentionDays: 1, replyPartBudget: budget });
  const responder = await createConfiguredAgentResponderForApp({
    config, cwd: root, runtime,
    runtimeOptions: { piResolvedModels: models, compaction: { enabled: false } },
    runtimeOptionsForRequest: composeRuntimeOptionExtensions([restart.extension, choices.extension, files.createExtension, extra])!,
  }, {});
  cleanup.push(() => (responder as AgentResponder & { dispose(): Promise<void> }).dispose());
  const wrapped = restart.wrapResponder(choices.wrapResponder(files.wrapResponder(responder)));
  const respond = (source: "web" | "telegram") => wrapped.respond({
    conversationId: `${source}:fictional-thread`, text: "Plan a fictional trip.", abortSignal: new AbortController().signal,
    metadata: { source, ...(source === "web" ? { web: { threadId: "fictional-thread", turnId: "fictional-turn" } } : {}) },
  }, { append: async () => {} });
  return { faux, requests, calls, runs, files, verify, respond };
}

it("delivers the visible answer and choices in one configured provider dispatch", async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage([fauxText(answer), fauxToolCall("SuggestReplies", { options }, { id: "choices" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("The route buttons are ready.")]),
  ]);
  const reply = await f.respond("web");
  expect(f.requests).toHaveBeenCalledTimes(1);
  expect(f.runs).toHaveBeenCalledTimes(1);
  expect(f.calls.mock.calls.map(([call]) => call.name)).toEqual(["SuggestReplies"]);
  expect(reply.text).toBe(answer);
  expect(reply.parts).toMatchObject([{ type: "reply_options", id: expect.any(String), options }]);
});

it.each(["thinking only", "tool first"])("finalizes %s once and preserves all three configured reply parts", async (kind) => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage([
      ...(kind === "thinking only" ? [fauxThinking("Fictional private draft, not the user-facing reply.")] : []),
      fauxToolCall("SuggestReplies", { options }, { id: "choices" }),
      fauxToolCall("ProposeRestart", { reason: "Apply the fictional update" }, { id: "restart" }),
      fauxToolCall("PublishReplyFile", { path: fileName }, { id: "file" }),
    ], { stopReason: "toolUse" }),
    (context) => {
      expect(getCurrentTools(context.messages)).toEqual([]);
      expect(context.messages.filter((entry) => entry.role === "toolResult")).toMatchObject([
        { toolCallId: "choices", isError: false }, { toolCallId: "restart", isError: false }, { toolCallId: "file", isError: false },
      ]);
      expect(JSON.stringify(context.messages.at(-1))).toContain("write your reply");
      return fauxAssistantMessage([fauxText(answer)]);
    },
  ]);
  const reply = await f.respond("web");
  expect(f.requests).toHaveBeenCalledTimes(2);
  expect(f.runs).toHaveBeenCalledTimes(1);
  expect(f.calls.mock.calls.map(([call]) => call.name)).toEqual(["SuggestReplies", "ProposeRestart", "PublishReplyFile"]);
  const receipt = await f.calls.mock.results[2]?.value;
  expect(receipt?.structuredContent).toMatchObject({ published: true, attachmentId: expect.any(String) });
  expect(reply.text).toBe(answer);
  expect(reply.parts).toHaveLength(3);
  expect(reply.parts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "reply_options", id: expect.any(String), options }),
    expect.objectContaining({ type: "restart_proposal", id: expect.any(String), reason: "Apply the fictional update" }),
    expect.objectContaining({ type: "attachment", name: fileName,
      reference: { scheme: "mono-agent-artifact", id: receipt?.structuredContent?.attachmentId } }),
  ]));
});

it("delivers an openable file alongside the answer on a non-web destination without web-only tools", async () => {
  const f = await fixture();
  f.faux.setResponses([(context) => {
    const names = getCurrentTools(context.messages).map(({ name }) => name);
    expect(names).toContain("PublishReplyFile");
    expect(names).not.toContain("SuggestReplies");
    expect(names).not.toContain("ProposeRestart");
    return fauxAssistantMessage([fauxText(answer), fauxToolCall("PublishReplyFile", { path: fileName }, { id: "file" })], { stopReason: "toolUse" });
  }]);
  const reply = await f.respond("telegram");
  expect(f.requests).toHaveBeenCalledTimes(1);
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.calls.mock.calls.map(([call]) => call.name)).toEqual(["PublishReplyFile"]);
  expect(reply.text).toBe(answer);
  expect(reply.parts).toHaveLength(1);
  const part = reply.parts?.[0];
  if (part?.type !== "attachment") throw new Error("Expected the published file");
  const opened = await f.files.open({ conversationId: "telegram:fictional-thread", reference: part.reference, expectedIntegrityId: part.integrityId });
  const chunks: Uint8Array[] = [];
  for await (const chunk of opened.body) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe(fileContents);
});

it.each(["waiting", "already pending"])("continues a mixed presentation batch with AskUser %s", async (kind) => {
  const pollStarted = deferred();
  const answerReceived = deferred();
  const fetchBridge: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") return kind === "already pending"
      ? Response.json({}, { status: 409 })
      : Response.json({ interactionId: "fictional-ask" }, { status: 201 });
    expect(init?.method).toBe("GET");
    pollStarted.resolve();
    await answerReceived.promise;
    return Response.json({ status: "answered", answers: [], questions: [] });
  };
  const extension = createRequestScopedMcpRuntimeExtension({
    serverName: "test-ask-user", startingMessage: "AskUser starting",
    createServer({ request, runId }) {
      const server = new McpServer({ name: "test-ask-user", version: "1.0.0" });
      registerAskUserTool(server, { bridgeUrl: "http://127.0.0.1:9", bridgeToken: "unused-test-token", timeoutMs: 1_000,
        producerConversationId: request.conversationId, interactionConversationId: request.conversationId, runId }, fetchBridge);
      return server;
    },
  });
  const f = await fixture(extension);
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("SuggestReplies", { options }, { id: "choices" }),
      fauxToolCall("AskUser", { questions: [{ header: "Trip", question: "Which route?", options: [
        { label: "Train", description: "Travel by train." }, { label: "Bus", description: "Travel by bus." },
      ] }] }, { id: "ask" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText(answer)]),
  ]);
  const pending = f.respond("web");
  try {
    if (kind === "waiting") {
      await Promise.race([pollStarted.promise, pending.then(() => { throw new Error("Turn finished before waiting for AskUser"); })]);
      expect(f.requests).toHaveBeenCalledTimes(1);
      answerReceived.resolve();
    }
    const reply = await pending;
    expect(f.requests).toHaveBeenCalledTimes(2);
    const messages = f.requests.mock.calls[1]![1].messages;
    expect(getCurrentTools(messages)).toContainEqual(expect.objectContaining({ name: "AskUser" }));
    expect(messages.filter((entry) => entry.role === "toolResult")).toMatchObject([
      { toolCallId: "choices", isError: false }, { toolCallId: "ask", isError: false },
    ]);
    expect(f.calls.mock.calls.map(([call]) => call.name)).toEqual(["SuggestReplies", "AskUser"]);
    expect((await f.calls.mock.results[1]?.value)?.structuredContent).toMatchObject(kind === "already pending"
      ? { answered: false, reason: "already_pending" } : { answered: true });
    expect(reply.text).toBe(answer);
    expect(reply.parts).toMatchObject([{ type: "reply_options", id: expect.any(String), options }]);
  } finally {
    answerReceived.resolve();
    await pending.catch(() => {});
  }
});
