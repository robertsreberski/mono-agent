import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createJsonlRunRecorder, type RunSummary, type RuntimeEventLike } from "@mono-agent/observability";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRunHistoryRuntimeExtension,
  isRunHistoryToolAllowed,
  RUN_HISTORY_MCP_SERVER_NAME,
  RUN_HISTORY_TOOL_NAME,
} from "../run-history.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-run-history-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface WriteRunOptions {
  readonly artifactDir: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly startedAt: string;
  readonly userInput?: string;
  readonly events?: readonly RuntimeEventLike[];
  readonly result?: Record<string, unknown>;
  readonly running?: boolean;
}

async function writeRun(options: WriteRunOptions): Promise<RunSummary> {
  let now = Date.parse(options.startedAt);
  const recorder = createJsonlRunRecorder({
    runId: options.runId,
    conversationId: options.conversationId,
    artifactDir: options.artifactDir,
    ...(options.userInput === undefined ? {} : { userInput: options.userInput }),
    clock: () => {
      const value = now;
      now += 1_000;
      return value;
    },
  });
  for (const event of options.events ?? []) recorder.onEvent(event);
  if (options.running === true) {
    const summary = await recorder.start?.();
    if (summary === undefined) throw new Error("Recorder does not support start().");
    return summary;
  }
  return await recorder.finish(options.result ?? {});
}

interface OpenHistoryClient {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

async function openHistoryClient(
  artifactDir: string,
  conversationId: string,
  runId = "current-run",
): Promise<OpenHistoryClient> {
  const extension = await createRunHistoryRuntimeExtension({ artifactDir })({
    runId,
    request: {
      conversationId,
      userMessage: "inspect history",
      abortSignal: new AbortController().signal,
    },
    context: {} as never,
  });
  const mcpServers = extension.runtimeOptions?.mcpServers as Record<string, unknown> | undefined;
  const spec = mcpServers?.[RUN_HISTORY_MCP_SERVER_NAME] as { readonly url: string } | undefined;
  if (spec === undefined) throw new Error("RunHistory MCP server was not registered.");
  const client = new Client({ name: "run-history-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await extension.cleanup?.();
    },
  };
}

function structured<T>(result: unknown): T {
  return (result as { readonly structuredContent?: unknown }).structuredContent as T;
}

describe("isRunHistoryToolAllowed", () => {
  it.each([
    RUN_HISTORY_TOOL_NAME,
    "run_history",
    `mcp__${RUN_HISTORY_MCP_SERVER_NAME}__${RUN_HISTORY_TOOL_NAME}`,
    `mcp__${RUN_HISTORY_MCP_SERVER_NAME}__*`,
    "*",
  ])("allows the supported policy spelling %s", (name) => {
    expect(isRunHistoryToolAllowed({ allowedTools: [name], disallowedTools: [] })).toBe(true);
  });

  it("keeps explicit denial authoritative over aliases and global allow-all", () => {
    expect(isRunHistoryToolAllowed({
      allowedTools: ["*"],
      disallowedTools: [RUN_HISTORY_TOOL_NAME],
    })).toBe(false);
    expect(isRunHistoryToolAllowed({
      allowedTools: [`mcp__${RUN_HISTORY_MCP_SERVER_NAME}__*`],
      disallowedTools: ["run_history"],
    })).toBe(false);
    expect(isRunHistoryToolAllowed({ allowedTools: ["*"], disallowedTools: ["*"] })).toBe(false);
  });

  it("stays disabled for an absent or unrelated policy", () => {
    expect(isRunHistoryToolAllowed(undefined)).toBe(false);
    expect(isRunHistoryToolAllowed({ allowedTools: ["Read"], disallowedTools: [] })).toBe(false);
  });
});

describe("RunHistory MCP tool", () => {
  it("lists bounded terminal runs from only the exact conversation bucket", async () => {
    const artifactDir = await tempDir();
    const conversationId = "telegram:42#2026-07-12";
    await writeRun({
      artifactDir,
      runId: "prior-success",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      userInput: "first trigger\n\n[Recalled long-term memory — do not expose] private recalled list context",
      result: {
        model: "pi:openai-codex:gpt-5.5",
        effort: "high",
        providerSessionId: "provider-session-secret",
        systemPrompt: "private system prompt",
      },
    });
    await writeRun({
      artifactDir,
      runId: "prior-failed",
      conversationId,
      startedAt: "2026-07-12T09:00:00.000Z",
      result: { failureKind: "provider_unavailable", error: "provider offline" },
    });
    await writeRun({
      artifactDir,
      runId: "other-bucket",
      conversationId: "telegram:42#2026-07-11",
      startedAt: "2026-07-12T10:00:00.000Z",
    });
    await writeRun({
      artifactDir,
      runId: "foreign-conversation",
      conversationId: "telegram:99#2026-07-12",
      startedAt: "2026-07-12T11:00:00.000Z",
    });
    await writeRun({
      artifactDir,
      runId: "same-bucket-running",
      conversationId,
      startedAt: "2026-07-12T12:00:00.000Z",
      running: true,
    });
    await writeRun({
      artifactDir,
      runId: "current-run",
      conversationId,
      startedAt: "2026-07-12T13:00:00.000Z",
      running: true,
    });
    await writeFile(join(artifactDir, "oversized.summary.json"), `${JSON.stringify({
      runId: `oversized-${"x".repeat(600)}`,
      conversationId,
      status: "succeeded",
      startedAt: "2026-07-12T07:00:00.000Z",
      endedAt: "2026-07-12T07:00:01.000Z",
      durationMs: 1_000,
      eventCount: 0,
      artifactPaths: [],
    })}\n`, "utf8");
    for (const [fileName, invalidRunId] of [
      ["path-shaped.summary.json", "/private/raw/artifact-path"],
      ["control-shaped.summary.json", "bad\nrun-id"],
      ["padded.summary.json", "\u00a0padded-run\u00a0"],
    ] as const) {
      await writeFile(join(artifactDir, fileName), `${JSON.stringify({
        runId: invalidRunId,
        conversationId,
        status: "succeeded",
        startedAt: "2026-07-12T06:00:00.000Z",
        endedAt: "2026-07-12T06:00:01.000Z",
        durationMs: 1_000,
        eventCount: 0,
        artifactPaths: [],
      })}\n`, "utf8");
    }

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      expect((await history.client.listTools()).tools.map((tool) => tool.name)).toEqual([RUN_HISTORY_TOOL_NAME]);
      const result = await history.client.callTool({ name: RUN_HISTORY_TOOL_NAME, arguments: { action: "list" } });
      const body = structured<{
        readonly runs: ReadonlyArray<Record<string, unknown>>;
        readonly count: number;
        readonly hasMore: boolean;
        readonly warnings: readonly string[];
        readonly untrusted: boolean;
      }>(result);

      expect(body.runs.map((run) => run.runId)).toEqual(["prior-failed", "prior-success"]);
      expect(body.count).toBe(2);
      expect(body.hasMore).toBe(false);
      expect(body.warnings).toEqual(["Some recorded-run artifacts were unavailable or malformed."]);
      expect(body.untrusted).toBe(true);
      expect(body.runs[0]).toMatchObject({ status: "failed", failureKind: "provider_unavailable" });
      expect(body.runs[1]).toMatchObject({ runId: "prior-success", trigger: "first trigger" });
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("— first trigger") }),
      ]));
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(conversationId);
      expect(serialized).not.toContain("other-bucket");
      expect(serialized).not.toContain("foreign-conversation");
      expect(serialized).not.toContain("same-bucket-running");
      expect(serialized).not.toContain("current-run");
      expect(serialized).not.toContain("/private/raw/artifact-path");
      expect(serialized).not.toContain("bad\\nrun-id");
      expect(serialized).not.toContain("padded-run");
      expect(serialized).not.toContain("provider-session-secret");
      expect(serialized).not.toContain("private system prompt");
      expect(serialized).not.toContain("private recalled list context");
      expect(serialized).not.toContain("summaryFileName");

      const limited = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "list", limit: 1 },
      });
      expect(structured<{ readonly runs: unknown[]; readonly hasMore: boolean }>(limited)).toMatchObject({
        runs: [expect.objectContaining({ runId: "prior-failed" })],
        hasMore: true,
      });
    } finally {
      await history.close();
    }
  });

  it("inspects a redacted chronological projection with correlated tool results", async () => {
    const artifactDir = await tempDir();
    const conversationId = "cron:nightly#2026-07-12";
    await writeRun({
      artifactDir,
      runId: "prior-detail",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      userInput: "Prepare the nightly digest.\n\n[Recalled long-term memory — do not expose] appended private memory",
      events: [
        {
          type: "turn_context",
          history: [{ role: "user", text: "private previous message" }],
          memory: { content: "private recalled memory" },
          timestamp: "2026-07-12T08:00:00.050Z",
        },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "private chain of thought" },
              { type: "text", phase: "analysis", text: "private phase reasoning" },
              { type: "text", phase: "commentary", text: "Checking the inputs." },
              { type: "text", text: "I will read the source." },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: {
                  path: "notes.md",
                  apiKey: "raw-api-key",
                  password: 987654321,
                  providerSessionId: "nested-provider-session",
                  conversationId: "telegram:foreign",
                  reasoning: "hidden tool reasoning",
                },
              },
              {
                type: "tool_use",
                id: "tool-2",
                name: "Read",
                input: { path: join(artifactDir, "prior-detail.events.jsonl") },
              },
              {
                type: "tool_use",
                id: "tool-3",
                name: "Bash",
                input: { command: `cat ${join(artifactDir, "prior-detail.summary.json")}` },
              },
              {
                type: "tool_use",
                id: "tool-4",
                name: "Bash",
                input: { command: "printenv OPENAI_API_KEY" },
              },
            ],
          },
          timestamp: "2026-07-12T08:00:01.000Z",
        },
        {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "text", text: "source contents" }],
              raw_result: { artifactPaths: ["/private/artifacts/prior-detail.events.jsonl"] },
            }, {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: [{ type: "text", text: JSON.stringify({
                systemPrompt: "tool-result-system-prompt",
                providerSessionId: "tool-result-provider-session",
                artifactPaths: [join(artifactDir, "prior-detail.events.jsonl")],
                note: "OPENAI_API_KEY=nested-tool-secret",
                backupPassword: 987654321,
                blocks: [
                  { type: "text", phase: "analysis", text: "tool-result-private-reasoning" },
                  { type: "text", text: "safe structured evidence" },
                ],
                messages: [
                  { role: "system", content: "role-system-private-prompt" },
                  { role: "developer", content: "role-developer-private-prompt" },
                  { role: "user", content: "safe structured user evidence" },
                ],
              }) }],
            }, {
              type: "tool_result",
              tool_use_id: "tool-3",
              content: [{
                type: "text",
                text: `raw ${join(artifactDir, "prior-detail.summary.json")}\nsystemPrompt: raw-tool-result-prompt`,
              }],
            }, {
              type: "tool_result",
              tool_use_id: "tool-4",
              content: [{ type: "text", text: "OPENAI_API_KEY=opaque-tool-secret" }],
            }],
          },
          timestamp: "2026-07-12T08:00:02.000Z",
        },
        {
          type: "runtime_warning",
          warning_kind: "memory_degraded",
          message: "Recall was unavailable.",
          providerSessionId: "warning-provider-session",
          timestamp: "2026-07-12T08:00:03.000Z",
        },
        {
          type: "provider_request_failed",
          failureKind: "provider_unavailable",
          error: "Primary provider timed out.",
          systemPrompt: "event system prompt",
          timestamp: "2026-07-12T08:00:04.000Z",
        },
        {
          type: "runtime_warning",
          warning_kind: "credential_echo",
          message: "Authorization: Bearer diagnostic-secret",
          timestamp: "2026-07-12T08:00:04.500Z",
        },
        { type: "user_message", message: { content: [{ type: "text", text: "private event user message" }] } },
        { type: "memory_context", text: "private memory-context payload" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "more private reasoning" },
              { type: "text", text: "Final visible digest." },
            ],
          },
          timestamp: "2026-07-12T08:00:05.000Z",
        },
      ],
      result: {
        model: "pi:openai-codex:gpt-5.5",
        providerSessionId: "summary-provider-session",
        systemPrompt: "summary system prompt",
        runtimeWarnings: [{ kind: "fallback_used", message: "Backup provider completed the run." }],
      },
    });

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const result = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "prior-detail" },
      });
      const body = structured<{
        readonly trigger: string;
        readonly timeline: ReadonlyArray<Record<string, unknown>>;
        readonly finalOutput: string;
        readonly untrusted: boolean;
      }>(result);

      expect(body.trigger).toBe("Prepare the nightly digest.");
      expect(body.timeline[0]).toMatchObject({ kind: "trigger", text: "Prepare the nightly digest." });
      expect(body.timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", phase: "commentary", text: "Checking the inputs." }),
        expect.objectContaining({ kind: "assistant", text: "I will read the source." }),
        expect.objectContaining({
          kind: "warning",
          warningKind: "memory_degraded",
          message: "Recall was unavailable.",
        }),
        expect.objectContaining({
          kind: "failure",
          failureKind: "provider_unavailable",
          message: "Primary provider timed out.",
        }),
        expect.objectContaining({ kind: "warning", warningKind: "fallback_used" }),
      ]));
      const tool = body.timeline.find((entry) => entry.kind === "tool") as {
        readonly input: Record<string, unknown>;
        readonly result: { readonly content: unknown; readonly isError: boolean; readonly timestamp: string };
      };
      expect(tool).toMatchObject({
        toolUseId: "tool-1",
        name: "Read",
        input: { path: "notes.md", apiKey: "[redacted]" },
        result: { content: "source contents", isError: false, timestamp: "2026-07-12T08:00:02.000Z" },
      });
      expect(tool.input).not.toHaveProperty("providerSessionId");
      expect(tool.input).not.toHaveProperty("conversationId");
      expect(tool.input).not.toHaveProperty("reasoning");
      expect(tool.input.password).toBe("[redacted]");
      const privateStructuredTool = body.timeline.find((entry) => entry.toolUseId === "tool-2") as {
        readonly input: Record<string, unknown>;
        readonly result: { readonly content: unknown };
      };
      expect(privateStructuredTool.input.path).toBe(
        "[tool result omitted because it contained private run-artifact internals]",
      );
      expect(JSON.stringify(privateStructuredTool.result.content)).toContain("safe structured evidence");
      expect(JSON.stringify(privateStructuredTool.result.content)).toContain("safe structured user evidence");
      const opaqueArtifactTool = body.timeline.find((entry) => entry.toolUseId === "tool-3") as {
        readonly result: { readonly content: unknown };
      };
      expect(opaqueArtifactTool.result.content).toBe(
        "[tool result omitted because it contained private run-artifact internals]",
      );
      const opaqueCredentialTool = body.timeline.find((entry) => entry.toolUseId === "tool-4") as {
        readonly result: { readonly content: unknown };
      };
      expect(opaqueCredentialTool.result.content).toBe(
        "[tool result omitted because it contained private run-artifact internals]",
      );
      expect(body.timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "warning",
          warningKind: "credential_echo",
          message: "[diagnostic omitted because it contained private run-artifact internals]",
        }),
      ]));
      expect(body.finalOutput).toBe("Final visible digest.");
      expect(body.untrusted).toBe(true);

      // Some runtimes (including Pi) expose MCP text content but not
      // structuredContent to the model. The safe projection must be present in
      // both representations or the model can list a run but cannot inspect it.
      const textContent = (result as {
        readonly content: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>;
      }).content
        .map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "")
        .join("\n");
      expect(textContent).toContain('"name":"Read"');
      expect(textContent).toContain('"content":"source contents"');
      expect(textContent).toContain("Final visible output:\nFinal visible digest.");
      expect((result as { readonly content: ReadonlyArray<{ readonly text?: unknown }> }).content.every(
        (block) => typeof block.text !== "string" || block.text.length <= 10_000,
      )).toBe(true);

      const serialized = JSON.stringify(result);
      for (const forbidden of [
        "private chain of thought",
        "private phase reasoning",
        "more private reasoning",
        "private previous message",
        "private recalled memory",
        "private event user message",
        "private memory-context payload",
        "appended private memory",
        "private recalled list context",
        "nested-provider-session",
        "warning-provider-session",
        "summary-provider-session",
        "summary system prompt",
        "event system prompt",
        "/private/artifacts",
        "prior-detail.events.jsonl",
        "telegram:foreign",
        "raw-api-key",
        "tool-result-system-prompt",
        "tool-result-provider-session",
        "tool-result-private-reasoning",
        "role-system-private-prompt",
        "role-developer-private-prompt",
        "nested-tool-secret",
        "raw-tool-result-prompt",
        "opaque-tool-secret",
        "diagnostic-secret",
        "987654321",
      ]) expect(serialized).not.toContain(forbidden);
    } finally {
      await history.close();
    }
  });

  it("applies its extra key and prose sanitizers after shared observability redaction", async () => {
    const artifactDir = await tempDir();
    const conversationId = "webhook:run-history-redaction-split";
    await writeRun({
      artifactDir,
      runId: "redaction-split-run",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      events: [
        {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-redaction-split",
              name: "Inspect",
              input: {
                credential: 271828,
                private_key: 314159,
                bearer: 161803,
                apiKey: 101,
                token: 202,
                client_secret: 303,
                password: 404,
                authorization: 505,
                cookie: 606,
              },
            }],
          },
          timestamp: "2026-07-12T08:00:01.000Z",
        },
        {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "tool-redaction-split",
              content: [{ type: "text", text: "password=tool-prose-value" }],
            }],
          },
          timestamp: "2026-07-12T08:00:02.000Z",
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "password=free-text-value" }],
          },
          timestamp: "2026-07-12T08:00:03.000Z",
        },
      ],
    });

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const result = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "redaction-split-run" },
      });
      const body = structured<{
        readonly timeline: ReadonlyArray<Record<string, unknown>>;
        readonly finalOutput: string;
      }>(result);
      const tool = body.timeline.find((entry) => entry.kind === "tool") as {
        readonly input: Record<string, unknown>;
        readonly result: { readonly content: unknown };
      };

      expect(tool.input).toEqual({
        credential: 271828,
        private_key: 314159,
        bearer: 161803,
        apiKey: "[redacted]",
        token: "[redacted]",
        client_secret: "[redacted]",
        password: "[redacted]",
        authorization: "[redacted]",
        cookie: "[redacted]",
      });
      expect(tool.result.content).toBe(
        "[tool result omitted because it contained private run-artifact internals]",
      );
      expect(body.timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "assistant",
          text: "[diagnostic omitted because it contained private run-artifact internals]",
        }),
      ]));
      expect(body.finalOutput).toBe(
        "[diagnostic omitted because it contained private run-artifact internals]",
      );

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("tool-prose-value");
      expect(serialized).not.toContain("free-text-value");
    } finally {
      await history.close();
    }
  });

  it("only exempts a complete exact [redacted] assignment sentinel in real MCP projections", async () => {
    const artifactDir = await tempDir();
    const conversationId = "webhook:run-history-redacted-sentinel";
    await writeRun({
      artifactDir,
      runId: "redacted-sentinel-run",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      events: [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tool-tainted", name: "Inspect", input: {} },
              { type: "tool_use", id: "tool-sentinel-suffix", name: "Inspect", input: {} },
              { type: "tool_use", id: "tool-case-variant", name: "Inspect", input: {} },
              { type: "tool_use", id: "tool-exact", name: "Inspect", input: {} },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-tainted",
                content: [
                  { type: "text", text: "OPENAI_API_" },
                  { type: "image", data: "non-text-separator" },
                  { type: "text", text: "KEY=secret" },
                ],
              },
              {
                type: "tool_result",
                tool_use_id: "tool-sentinel-suffix",
                content: [
                  { type: "text", text: "status: password=[redacted]" },
                  { type: "image", data: "non-text-separator" },
                  { type: "text", text: "suffix" },
                ],
              },
              {
                type: "tool_result",
                tool_use_id: "tool-case-variant",
                content: [{ type: "text", text: "status: password=[REDACTED]" }],
              },
              {
                type: "tool_result",
                tool_use_id: "tool-exact",
                content: [{ type: "text", text: 'status: password="[redacted]"' }],
              },
            ],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "OPENAI_API_" }] },
        },
        {
          type: "runtime_warning",
          warning_kind: "separator",
          message: "A warning separates assistant text fragments.",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "KEY=secret" }] },
        },
      ],
    });

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const result = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "redacted-sentinel-run" },
      });
      const body = structured<{
        readonly timeline: ReadonlyArray<Record<string, unknown>>;
        readonly finalOutput: string;
      }>(result);
      const taintedTool = body.timeline.find((entry) => entry.toolUseId === "tool-tainted") as {
        readonly result: { readonly content: unknown };
      };
      const exactTool = body.timeline.find((entry) => entry.toolUseId === "tool-exact") as {
        readonly result: { readonly content: unknown };
      };
      const sentinelSuffixTool = body.timeline.find((entry) => entry.toolUseId === "tool-sentinel-suffix") as {
        readonly result: { readonly content: unknown };
      };
      const caseVariantTool = body.timeline.find((entry) => entry.toolUseId === "tool-case-variant") as {
        readonly result: { readonly content: unknown };
      };

      expect(taintedTool.result.content).toEqual([
        { type: "text", text: "[tool result omitted because it contained private run-artifact internals]" },
        { type: "image", data: "non-text-separator" },
        { type: "text", text: "[tool result omitted because it contained private run-artifact internals]" },
      ]);
      expect(sentinelSuffixTool.result.content).toEqual(taintedTool.result.content);
      expect(caseVariantTool.result.content).toBe(
        "[tool result omitted because it contained private run-artifact internals]",
      );
      expect(exactTool.result.content).toBe('status: password="[redacted]"');
      expect(body.timeline
        .filter((entry) => entry.kind === "assistant")
        .map((entry) => entry.text)).toEqual([
        "[diagnostic omitted because it contained private run-artifact internals]",
        "[diagnostic omitted because it contained private run-artifact internals]",
      ]);
      expect(body.finalOutput).toBe(
        "[diagnostic omitted because it contained private run-artifact internals]",
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("OPENAI_API_");
      expect(serialized).not.toContain("KEY=secret");
      expect(serialized).not.toContain("[redacted]suffix");
    } finally {
      await history.close();
    }
  });

  it("returns safe errors for invalid, missing, foreign, current, and running run ids", async () => {
    const artifactDir = await tempDir();
    const conversationId = "tui:one";
    await writeRun({
      artifactDir,
      runId: "foreign-run",
      conversationId: "tui:two",
      startedAt: "2026-07-12T08:00:00.000Z",
    });
    await writeRun({
      artifactDir,
      runId: "running-run",
      conversationId,
      startedAt: "2026-07-12T09:00:00.000Z",
      running: true,
    });

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const cases = [
        { runId: "../private/secret", code: "invalid_run_id" },
        { runId: "missing-run", code: "run_not_available" },
        { runId: "foreign-run", code: "run_not_available" },
        { runId: "current-run", code: "current_run" },
        { runId: "running-run", code: "run_incomplete" },
      ] as const;
      for (const testCase of cases) {
        const result = await history.client.callTool({
          name: RUN_HISTORY_TOOL_NAME,
          arguments: { action: "inspect", runId: testCase.runId },
        });
        expect(result.isError).toBe(true);
        expect(structured<{ readonly error: { readonly code: string } }>(result).error.code).toBe(testCase.code);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(artifactDir);
        expect(serialized).not.toContain("/private/secret");
      }
    } finally {
      await history.close();
    }
  });

  it("degrades safely for malformed summaries and missing or malformed event artifacts", async () => {
    const artifactDir = await tempDir();
    const conversationId = "webhook:fixture";
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "do-not-leak-this-name.summary.json"), "{not-json\n", "utf8");
    await writeFile(join(artifactDir, "missing-events.summary.json"), `${JSON.stringify({
      runId: "missing-events",
      conversationId,
      status: "succeeded",
      startedAt: "2026-07-12T08:00:00.000Z",
      endedAt: "2026-07-12T08:00:01.000Z",
      durationMs: 1_000,
      eventCount: 1,
      userInput: "Safe trigger",
      systemPrompt: "private prompt",
      providerSessionId: "private session",
      artifactPaths: ["/private/artifacts/missing-events.events.jsonl"],
    }, null, 2)}\n`, "utf8");
    await writeFile(join(artifactDir, "partial-events.summary.json"), `${JSON.stringify({
      runId: "partial-events",
      conversationId,
      status: "succeeded",
      startedAt: "2026-07-12T09:00:00.000Z",
      endedAt: "2026-07-12T09:00:01.000Z",
      durationMs: 1_000,
      eventCount: 2,
      artifactPaths: [],
    })}\n`, "utf8");
    await writeFile(join(artifactDir, "partial-events.events.jsonl"), `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Surviving output." }] },
      timestamp: "2026-07-12T09:00:00.500Z",
    })}\nnot-json\n`, "utf8");

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const listed = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "list" },
      });
      expect(structured<{ readonly runs: ReadonlyArray<{ readonly runId: string }>; readonly warnings: string[] }>(listed))
        .toMatchObject({
          runs: expect.arrayContaining([
            expect.objectContaining({ runId: "missing-events" }),
            expect.objectContaining({ runId: "partial-events" }),
          ]),
          warnings: ["Some recorded-run artifacts were unavailable or malformed."],
        });

      const missing = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "missing-events" },
      });
      expect(structured<{ readonly trigger: string; readonly warnings: string[] }>(missing)).toMatchObject({
        trigger: "Safe trigger",
        warnings: ["Some recorded-run artifacts were unavailable or malformed."],
      });

      const partial = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "partial-events" },
      });
      expect(structured<{ readonly finalOutput: string; readonly warnings: string[] }>(partial)).toMatchObject({
        finalOutput: "Surviving output.",
        warnings: ["Some recorded-run artifacts were unavailable or malformed."],
      });

      const serialized = JSON.stringify([listed, missing, partial]);
      expect(serialized).not.toContain("do-not-leak-this-name.summary.json");
      expect(serialized).not.toContain("missing-events.events.jsonl");
      expect(serialized).not.toContain("/private/artifacts");
      expect(serialized).not.toContain("private prompt");
      expect(serialized).not.toContain("private session");
    } finally {
      await history.close();
    }

    const missingDirHistory = await openHistoryClient(join(artifactDir, "absent"), conversationId);
    try {
      const empty = await missingDirHistory.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "list" },
      });
      expect(structured<{ readonly runs: unknown[]; readonly warnings: string[] }>(empty)).toMatchObject({
        runs: [],
        warnings: [],
      });
    } finally {
      await missingDirHistory.close();
    }
  });

  it("combines consecutive final assistant deltas after the last tool boundary", async () => {
    const artifactDir = await tempDir();
    const conversationId = "webhook:deltas";
    await writeRun({
      artifactDir,
      runId: "delta-run",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      events: [
        { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: " world." }] } },
      ],
    });

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const result = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "delta-run" },
      });
      expect(structured<{ readonly finalOutput: string }>(result).finalOutput).toBe("Hello world.");
    } finally {
      await history.close();
    }
  });

  it("scrubs opaque credentials without suppressing ordinary visible analysis prose", async () => {
    const artifactDir = await tempDir();
    const conversationId = "webhook:credential-scrub";
    await writeRun({
      artifactDir,
      runId: "credential-run",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      userInput: "password=987654321",
      events: [{
        type: "assistant",
        message: { content: [{ type: "text", text: "Analysis: revenue improved." }] },
      }],
      result: { model: "OPENAI_API_KEY=metadata-secret" },
    });
    await writeFile(join(artifactDir, "timestamp-secret.summary.json"), `${JSON.stringify({
      runId: "timestamp-secret-run",
      conversationId,
      status: "succeeded",
      startedAt: "OPENAI_API_KEY=started-at-secret",
      endedAt: "password=123456789",
      durationMs: 1_000,
      eventCount: 0,
      artifactPaths: [],
    })}\n`, "utf8");

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const listed = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "list" },
      });
      expect(JSON.stringify(listed)).not.toContain("987654321");
      expect(JSON.stringify(listed)).not.toContain("started-at-secret");
      expect(JSON.stringify(listed)).not.toContain("123456789");
      const inspected = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "credential-run" },
      });
      const body = structured<{ readonly trigger: string; readonly finalOutput: string }>(inspected);
      expect(body.trigger).toBe("[diagnostic omitted because it contained private run-artifact internals]");
      expect(body.finalOutput).toBe("Analysis: revenue improved.");
      expect(JSON.stringify(inspected)).not.toContain("987654321");
      expect(JSON.stringify(inspected)).not.toContain("metadata-secret");
    } finally {
      await history.close();
    }
  });

  it("scrubs quoted and cross-block credentials from visible assistant evidence", async () => {
    const artifactDir = await tempDir();
    const conversationId = "webhook:split-credentials";
    await writeRun({
      artifactDir,
      runId: "split-credential-run",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      events: [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: 'HTTP headers: {"Authorization":"Bearer quoted-secret"}' }] },
        },
        { type: "assistant", message: { content: [{ type: "text", text: " prefix OPENAI_API_" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "KEY=split-secret" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "https://service.test/?api_key=url-secret" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "FOO=x;OPENAI_API_KEY=semicolon-secret" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Human API key: prose-secret" }] } },
      ],
    });

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const result = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "split-credential-run" },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("quoted-secret");
      expect(serialized).not.toContain("split-secret");
      expect(serialized).not.toContain("url-secret");
      expect(serialized).not.toContain("semicolon-secret");
      expect(serialized).not.toContain("prose-secret");
      expect(structured<{ readonly finalOutput: string }>(result).finalOutput).toBe(
        "[diagnostic omitted because it contained private run-artifact internals]",
      );
    } finally {
      await history.close();
    }
  });

  it("retains the true tail and final output when a run exceeds the event read bound", async () => {
    const artifactDir = await tempDir();
    const conversationId = "cron:very-long";
    const events: RuntimeEventLike[] = Array.from({ length: 620 }, (_, index) => ({
      type: "assistant",
      message: {
        content: [{ type: "text", text: `delta-${String(index)}${index === 619 ? "-LAST" : ""}|` }],
      },
    }));
    await writeRun({
      artifactDir,
      runId: "very-long-run",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      userInput: "Inspect a long run",
      events,
    });

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const result = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "very-long-run" },
      });
      const body = structured<{
        readonly finalOutput: string;
        readonly warnings: readonly string[];
        readonly truncated: boolean;
      }>(result);
      expect(body.finalOutput).toMatch(/^delta-370\|/u);
      expect(body.finalOutput).toContain("delta-619-LAST|");
      expect(body.finalOutput).not.toContain("delta-0|");
      expect(body.truncated).toBe(true);
      expect(body.warnings).toEqual([
        "The recorded event input was bounded with first-and-last selection before projection.",
        expect.stringMatching(/^Timeline truncated: showing \d+ of 501 entries/u),
      ]);
      const textBlocks = (result as {
        readonly content: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>;
      }).content;
      expect(textBlocks.every((block) => typeof block.text !== "string" || block.text.length <= 10_000)).toBe(true);
      expect(textBlocks.some((block) => typeof block.text === "string" && block.text.includes("delta-619-LAST|")))
        .toBe(true);
    } finally {
      await history.close();
    }
  });

  it("caps large timelines by count and bytes while preserving useful first and last entries", async () => {
    const artifactDir = await tempDir();
    const conversationId = "cron:large";
    const events: RuntimeEventLike[] = Array.from({ length: 140 }, (_, index) => ({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: `entry-${String(index).padStart(3, "0")}${index === 139 ? "-LAST" : ""} ${"x".repeat(1_200)}`,
        }],
      },
      timestamp: new Date(Date.parse("2026-07-12T08:00:00.000Z") + index * 1_000).toISOString(),
    }));
    await writeRun({
      artifactDir,
      runId: "large-run",
      conversationId,
      startedAt: "2026-07-12T08:00:00.000Z",
      userInput: "FIRST trigger",
      events,
    });

    const history = await openHistoryClient(artifactDir, conversationId);
    try {
      const result = await history.client.callTool({
        name: RUN_HISTORY_TOOL_NAME,
        arguments: { action: "inspect", runId: "large-run" },
      });
      const body = structured<{
        readonly timeline: ReadonlyArray<Record<string, unknown>>;
        readonly warnings: readonly string[];
        readonly truncated: boolean;
      }>(result);
      expect(body.truncated).toBe(true);
      expect(body.timeline.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(body.timeline), "utf8")).toBeLessThanOrEqual(64 * 1_024);
      expect(body.timeline[0]).toMatchObject({ kind: "trigger", text: "FIRST trigger" });
      expect(JSON.stringify(body.timeline.at(-1))).toContain("entry-139-LAST");
      expect(body.warnings).toEqual([
        expect.stringMatching(/^Timeline truncated: showing \d+ of 141 entries; first and last entries were preserved\.$/u),
      ]);
    } finally {
      await history.close();
    }
  });
});
