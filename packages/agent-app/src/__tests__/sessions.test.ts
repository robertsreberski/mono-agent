import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolHistoryWriter } from "@mono-agent/agent-harness";

import { resolveAppSessionsRoot } from "../app-config.js";
import { purgeConversationHistory, purgeConversationState, purgeSessions } from "../sessions.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sessions-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: unknown): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(json));
  return configPath;
}

function inputFor(configPath: string, env: Record<string, string | undefined> = {}) {
  return { env, cwd: dir, configPath };
}

describe("resolveAppSessionsRoot", () => {
  it("returns undefined when no pi sessions root is configured (in-memory)", async () => {
    const configPath = await writeConfig({ runtime: { model: "pi:x:y" } });
    expect(await resolveAppSessionsRoot(inputFor(configPath))).toBeUndefined();
  });

  it("resolves providers.piNative.piSessionsRoot relative to cwd", async () => {
    const configPath = await writeConfig({ providers: { piNative: { piSessionsRoot: "./.mono-agent/sessions" } } });
    expect(await resolveAppSessionsRoot(inputFor(configPath))).toBe(join(dir, ".mono-agent", "sessions"));
  });

  it("prefers the MONO_AGENT_PI_SESSIONS_ROOT env override over the config file", async () => {
    const configPath = await writeConfig({ providers: { piNative: { piSessionsRoot: "./from-config" } } });
    const root = await resolveAppSessionsRoot(inputFor(configPath, { MONO_AGENT_PI_SESSIONS_ROOT: "./from-env" }));
    expect(root).toBe(join(dir, "from-env"));
  });

  it("returns undefined (does not throw) when the config file is malformed", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, "{ not valid json");
    expect(await resolveAppSessionsRoot(inputFor(configPath))).toBeUndefined();
  });
});

describe("purgeSessions", () => {
  it("is a no-op when sessions are in-memory (no root configured)", async () => {
    const configPath = await writeConfig({ runtime: { model: "pi:x:y" } });
    const result = await purgeSessions(inputFor(configPath));
    expect(result.removed).toBe(false);
    expect(result.files).toBe(0);
  });

  it("removes the sessions store and counts the nested jsonl files", async () => {
    const configPath = await writeConfig({ providers: { piNative: { piSessionsRoot: "./.mono-agent/sessions" } } });
    const root = join(dir, ".mono-agent", "sessions");
    // The runtime nests session files under a per-workspace subdirectory.
    const workspaceDir = join(root, "--workspace--");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "a.jsonl"), "{}\n");
    await writeFile(join(workspaceDir, "b.jsonl"), "{}\n");
    await writeFile(join(workspaceDir, "notes.txt"), "ignored — not a session file");

    const result = await purgeSessions(inputFor(configPath));

    expect(result.removed).toBe(true);
    expect(result.root).toBe(root);
    expect(result.files).toBe(2);
    await expect(stat(root)).rejects.toThrow();
  });

  it("is a no-op when the configured store does not exist on disk yet", async () => {
    const configPath = await writeConfig({ providers: { piNative: { piSessionsRoot: "./.mono-agent/sessions" } } });
    const result = await purgeSessions(inputFor(configPath));
    expect(result.removed).toBe(false);
    expect(result.files).toBe(0);
  });
});

describe("purgeConversationHistory", () => {
  it("removes only the history root beside the env-selected artifact directory", async () => {
    const configPath = await writeConfig({ artifacts: { dir: "./ignored-artifacts" } });
    const artifactDir = join(dir, "env-artifacts");
    const root = join(dir, "history");
    const memoryRoot = join(dir, "memory");
    await mkdir(join(root, ".locks"), { recursive: true });
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(root, "a.history.json"), "{}\n");
    await writeFile(join(root, "b.history.json"), "{}\n");
    await writeFile(join(root, ".locks", "root.sqlite"), "lock");
    await writeFile(join(memoryRoot, "memory.md"), "durable fact\n");

    const result = await purgeConversationHistory(inputFor(configPath, {
      MONO_AGENT_ARTIFACT_DIR: artifactDir,
    }));

    expect(result).toEqual({
      root,
      removed: true,
      messageHistory: { files: 2, bytes: 6 },
      toolHistory: { files: 0, bytes: 0, countsKnown: true, calls: 0, records: 0, tombstones: 0 },
    });
    await expect(stat(root)).rejects.toThrow();
    await expect(readFile(join(memoryRoot, "memory.md"), "utf8")).resolves.toBe("durable fact\n");
  });

  it("is a no-op when the configured history store does not exist", async () => {
    const configPath = await writeConfig({ artifacts: { dir: "./.mono-agent/artifacts" } });
    const result = await purgeConversationHistory(inputFor(configPath));
    expect(result).toEqual({
      root: join(dir, ".mono-agent", "history"),
      removed: false,
      messageHistory: { files: 0, bytes: 0 },
      toolHistory: { files: 0, bytes: 0, countsKnown: true, calls: 0, records: 0, tombstones: 0 },
    });
  });

  it("reports message and tool-history counts and bytes separately before removing both stores", async () => {
    const configPath = await writeConfig({ artifacts: { dir: "./.mono-agent/artifacts" } });
    const root = join(dir, ".mono-agent", "history");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "conversation.history.json"), "{}\n");
    const writer = await ToolHistoryWriter.open({ root });
    await writer.persist({
      conversationId: "chat:42",
      logicalConversationId: "chat:42",
      runId: "prior-run",
      isolated: false,
    }, { phase: "invocation", toolCallId: "call-1", toolName: "Read", arguments: { path: "README.md" } });
    await writer.persist({
      conversationId: "chat:42",
      logicalConversationId: "chat:42",
      runId: "prior-run",
      isolated: false,
    }, { phase: "result", toolCallId: "call-1", state: "success", content: "ok" });
    await writer.close();

    const result = await purgeConversationHistory(inputFor(configPath));
    expect(result.messageHistory).toEqual({ files: 1, bytes: 3 });
    expect(result.toolHistory).toMatchObject({
      files: 2,
      bytes: expect.any(Number),
      countsKnown: true,
      calls: 1,
      records: 2,
      tombstones: 0,
    });
    expect(result.toolHistory.bytes).toBeGreaterThan(0);
    await expect(stat(root)).rejects.toThrow();
  });
});

describe("purgeConversationState", () => {
  it("clears provider transcripts and active history while preserving long-term memory and run artifacts", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.mono-agent/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.mono-agent/sessions" } },
      memory: { mode: "lite", path: "./.mono-agent/memory", writeMode: "append-host-summary" },
    });
    const sessionsRoot = join(dir, ".mono-agent", "sessions");
    const historyRoot = join(dir, ".mono-agent", "history");
    const acpSessionsRoot = join(dir, ".mono-agent", "acp-sessions");
    const memoryRoot = join(dir, ".mono-agent", "memory");
    const artifactsRoot = join(dir, ".mono-agent", "artifacts");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
      mkdir(memoryRoot, { recursive: true }),
      mkdir(artifactsRoot, { recursive: true }),
    ]);
    await writeFile(join(sessionsRoot, "session.jsonl"), "{}\n");
    await writeFile(join(historyRoot, "conversation.history.json"), "{}\n");
    await writeFile(join(acpSessionsRoot, "authorization.json"), "{}\n");
    await writeFile(join(memoryRoot, "memory.md"), "keep memory\n");
    await writeFile(join(artifactsRoot, "run.summary.json"), "{}\n");

    const result = await purgeConversationState(inputFor(configPath));

    expect(result.sessions).toMatchObject({ root: sessionsRoot, removed: true, files: 1 });
    expect(result.history).toEqual({
      root: historyRoot,
      removed: true,
      messageHistory: { files: 1, bytes: 3 },
      toolHistory: { files: 0, bytes: 0, countsKnown: true, calls: 0, records: 0, tombstones: 0 },
    });
    expect(result.acpSessions).toEqual({ root: acpSessionsRoot, removed: true, files: 1 });
    await expect(stat(sessionsRoot)).rejects.toThrow();
    await expect(stat(historyRoot)).rejects.toThrow();
    await expect(stat(acpSessionsRoot)).rejects.toThrow();
    await expect(readFile(join(memoryRoot, "memory.md"), "utf8")).resolves.toBe("keep memory\n");
    await expect(readFile(join(artifactsRoot, "run.summary.json"), "utf8")).resolves.toBe("{}\n");
  });
});
