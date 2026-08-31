import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolHistoryWriter } from "@mono-agent/agent-harness";

const processIdentity = vi.hoisted(() => ({
  schema: "mono-agent.process-incarnation.v1" as const,
  bootSessionId: "test-boot",
  processStartId: "vitest-sessions",
}));

vi.mock("../process-incarnation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-incarnation.js")>(),
  currentProcessIncarnation: async () => processIdentity,
  isSameProcessIncarnation: () => true,
}));

import { resolveAppSessionsRoot } from "../app-config.js";
import { acquireAgentRootOwnership, agentRootLeasePath } from "../agent-root-coordinator.js";
import {
  loadProcessJobsRootRegistryProtection,
  processJobsRootRegistryPaths,
  registerProcessJobsRoot,
} from "../process-jobs-root-registry.js";
import {
  assertClearSessionsRecoveryResolved,
  clearSessionsRegistryRoot,
  purgeAcpSessionAuthorizations,
  purgeConversationHistory,
  purgeConversationState,
  purgeSessions,
} from "../sessions.js";

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
    const configPath = await writeConfig({ runtime: { model: "x:y" } });
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
    const configPath = await writeConfig({ runtime: { model: "x:y" } });
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

describe("standalone purge process-root protection", () => {
  it.each([
    {
      name: "Pi sessions",
      config: { providers: { piNative: { piSessionsRoot: "./.state/sessions" } } },
      retainedRoot: ".state/sessions",
      invoke: async (configPath: string) => await purgeSessions(inputFor(configPath)),
    },
    {
      name: "conversation history",
      config: { artifacts: { dir: "./.state/artifacts" } },
      retainedRoot: ".state/history",
      invoke: async (configPath: string) => await purgeConversationHistory(inputFor(configPath)),
    },
    {
      name: "ACP authorizations",
      config: { artifacts: { dir: "./.state/artifacts" } },
      retainedRoot: ".state/acp-sessions",
      invoke: async (configPath: string) => await purgeAcpSessionAuthorizations(inputFor(configPath)),
    },
  ])("refuses a retained-root overlap before inspecting or deleting $name", async ({
    config,
    retainedRoot,
    invoke,
  }) => {
    const configPath = await writeConfig(config);
    const root = join(dir, retainedRoot);
    const ownership = await seedRetainedProcessJobRoots([root]);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "sentinel.txt"), "retained\n");

    try {
      await expect(invoke(configPath)).rejects.toThrow(
        "restart --clear-sessions overlaps retained process-job private state; nothing was deleted.",
      );
      await expect(readFile(join(root, "sentinel.txt"), "utf8")).resolves.toBe("retained\n");
      await expect(stat(processJobsRootRegistryPaths(dir).manifestPath)).resolves.toBeDefined();
    } finally {
      await releaseTestOwnership(ownership);
    }
  });
});

describe("purgeConversationState", () => {
  it("refuses a dormant retained-root overlap before deleting any conversation state", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
    });
    const sessionsRoot = join(dir, ".state", "sessions");
    const historyRoot = join(dir, ".state", "history");
    const acpSessionsRoot = join(dir, ".state", "acp-sessions");
    const otherRetainedRoot = join(dir, ".private", "older-root");
    const ownership = await seedRetainedProcessJobRoots([otherRetainedRoot, historyRoot]);
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true, mode: 0o700 }),
      mkdir(acpSessionsRoot, { recursive: true }),
      mkdir(otherRetainedRoot, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
      writeFile(join(otherRetainedRoot, "record.json"), "older private state\n"),
    ]);

    try {
      await expect(purgeConversationState(inputFor(configPath))).rejects.toThrow(
        "restart --clear-sessions overlaps retained process-job private state; nothing was deleted.",
      );
      await expect(readFile(join(sessionsRoot, "session.jsonl"), "utf8")).resolves.toBe("session\n");
      await expect(readFile(join(historyRoot, "conversation.history.json"), "utf8")).resolves.toBe("history\n");
      await expect(readFile(join(acpSessionsRoot, "authorization.json"), "utf8")).resolves.toBe("authorization\n");
      await expect(readFile(join(otherRetainedRoot, "record.json"), "utf8")).resolves.toBe("older private state\n");
      await expect(stat(processJobsRootRegistryPaths(dir).manifestPath)).resolves.toBeDefined();
    } finally {
      await releaseTestOwnership(ownership);
    }
  });

  it("preserves every non-overlapping retained root and its registry while clearing sessions", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
    });
    const sessionsRoot = join(dir, ".state", "sessions");
    const historyRoot = join(dir, ".state", "history");
    const acpSessionsRoot = join(dir, ".state", "acp-sessions");
    const retainedRoots = [join(dir, ".private", "a"), join(dir, ".private", "b")];
    const ownership = await seedRetainedProcessJobRoots(retainedRoots);
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
      ...retainedRoots.map(async (root) => await mkdir(root, { recursive: true, mode: 0o700 })),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
      ...retainedRoots.map(async (root, index) =>
        await writeFile(join(root, "record.json"), `private-${index}\n`)),
    ]);

    try {
      const result = await purgeConversationState(inputFor(configPath));
      expect(result.sessions.removed).toBe(true);
      expect(result.history.removed).toBe(true);
      expect(result.acpSessions.removed).toBe(true);
      await Promise.all(retainedRoots.map(async (root, index) =>
        await expect(readFile(join(root, "record.json"), "utf8")).resolves.toBe(`private-${index}\n`)));
      await expect(stat(processJobsRootRegistryPaths(dir).manifestPath)).resolves.toBeDefined();
    } finally {
      await releaseTestOwnership(ownership);
    }
  });

  it.each([
    ["the agent state parent", "./.mono-agent"],
    ["the default process-job state root", "./.mono-agent/process-jobs"],
  ])("protects stale unconfigured process-job state when Pi sessions use %s", async (_name, piSessionsRoot) => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.mono-agent/artifacts" },
      providers: { piNative: { piSessionsRoot } },
    });
    const sessionsRoot = join(dir, piSessionsRoot);
    const historyRoot = join(dir, ".mono-agent", "history");
    const acpSessionsRoot = join(dir, ".mono-agent", "acp-sessions");
    const processJobsRoot = join(dir, ".mono-agent", "process-jobs");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
      mkdir(processJobsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
      writeFile(join(processJobsRoot, "record.json"), "process-job\n"),
    ]);

    await expect(purgeConversationState(inputFor(configPath))).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "processJobs.stateDir", purgeRootKind: "Pi provider sessions" },
    });
    await expect(readFile(join(sessionsRoot, "session.jsonl"), "utf8")).resolves.toBe("session\n");
    await expect(readFile(join(historyRoot, "conversation.history.json"), "utf8")).resolves.toBe("history\n");
    await expect(readFile(join(acpSessionsRoot, "authorization.json"), "utf8")).resolves.toBe("authorization\n");
    await expect(readFile(join(processJobsRoot, "record.json"), "utf8")).resolves.toBe("process-job\n");
  });

  it("rejects an overlapping process-job root before deleting any conversation state", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
      processJobs: { enabled: true, stateDir: "./.state/history" },
    });
    const sessionsRoot = join(dir, ".state", "sessions");
    const historyRoot = join(dir, ".state", "history");
    const acpSessionsRoot = join(dir, ".state", "acp-sessions");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "{}\n"),
      writeFile(join(historyRoot, "process-job-record.json"), "{}\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "{}\n"),
    ]);

    await expect(purgeConversationState(inputFor(configPath))).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "processJobs.stateDir", purgeRootKind: "durable session/tool history" },
    });
    await expect(readFile(join(sessionsRoot, "session.jsonl"), "utf8")).resolves.toBe("{}\n");
    await expect(readFile(join(historyRoot, "process-job-record.json"), "utf8")).resolves.toBe("{}\n");
    await expect(readFile(join(acpSessionsRoot, "authorization.json"), "utf8")).resolves.toBe("{}\n");
  });

  it("clears provider transcripts and active history while preserving long-term memory and run artifacts", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.mono-agent/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.mono-agent/sessions" } },
      memory: { mode: "lite", path: "./.mono-agent/memory", writeMode: "append-host-summary" },
      processJobs: { enabled: true, stateDir: "./.mono-agent/process-jobs" },
    });
    const sessionsRoot = join(dir, ".mono-agent", "sessions");
    const historyRoot = join(dir, ".mono-agent", "history");
    const acpSessionsRoot = join(dir, ".mono-agent", "acp-sessions");
    const memoryRoot = join(dir, ".mono-agent", "memory");
    const artifactsRoot = join(dir, ".mono-agent", "artifacts");
    const processJobsRoot = join(dir, ".mono-agent", "process-jobs");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
      mkdir(memoryRoot, { recursive: true }),
      mkdir(artifactsRoot, { recursive: true }),
      mkdir(processJobsRoot, { recursive: true }),
    ]);
    await writeFile(join(sessionsRoot, "session.jsonl"), "{}\n");
    await writeFile(join(historyRoot, "conversation.history.json"), "{}\n");
    await writeFile(join(acpSessionsRoot, "authorization.json"), "{}\n");
    await writeFile(join(memoryRoot, "memory.md"), "keep memory\n");
    await writeFile(join(artifactsRoot, "run.summary.json"), "{}\n");
    await writeFile(join(processJobsRoot, "record.json"), "{}\n");

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
    await expect(readFile(join(processJobsRoot, "record.json"), "utf8")).resolves.toBe("{}\n");
  });

  it.skipIf(process.platform === "win32")("rejects a target swap after validation without deleting any root or outside sentinel", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
    });
    const sessionsRoot = join(dir, ".state", "sessions");
    const movedSessionsRoot = join(dir, ".state", "sessions-original");
    const historyRoot = join(dir, ".state", "history");
    const acpSessionsRoot = join(dir, ".state", "acp-sessions");
    const outsideRoot = join(dir, "outside-target");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
      writeFile(join(outsideRoot, "sentinel.txt"), "outside\n"),
    ]);

    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterValidation: async () => {
          await rename(sessionsRoot, movedSessionsRoot);
          await symlink(outsideRoot, sessionsRoot, "dir");
        },
      },
    })).rejects.toThrow(/real directory|changed after validation/u);
    await expect(readFile(join(movedSessionsRoot, "session.jsonl"), "utf8")).resolves.toBe("session\n");
    await expect(readFile(join(historyRoot, "conversation.history.json"), "utf8")).resolves.toBe("history\n");
    await expect(readFile(join(acpSessionsRoot, "authorization.json"), "utf8")).resolves.toBe("authorization\n");
    await expect(readFile(join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside\n");
  });

  it.skipIf(process.platform === "win32")("rejects an ancestor swap after validation without partial deletion", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
    });
    const stateRoot = join(dir, ".state");
    const movedStateRoot = join(dir, ".state-original");
    const sessionsRoot = join(stateRoot, "sessions");
    const historyRoot = join(stateRoot, "history");
    const acpSessionsRoot = join(stateRoot, "acp-sessions");
    const outsideRoot = join(dir, "outside-ancestor");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
      mkdir(join(outsideRoot, "sessions"), { recursive: true }),
      mkdir(join(outsideRoot, "history"), { recursive: true }),
      mkdir(join(outsideRoot, "acp-sessions"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
      writeFile(join(outsideRoot, "sentinel.txt"), "outside\n"),
    ]);

    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterValidation: async () => {
          await rename(stateRoot, movedStateRoot);
          await symlink(outsideRoot, stateRoot, "dir");
        },
      },
    })).rejects.toThrow(/changed after validation/u);
    await expect(readFile(join(movedStateRoot, "sessions", "session.jsonl"), "utf8")).resolves.toBe("session\n");
    await expect(readFile(join(movedStateRoot, "history", "conversation.history.json"), "utf8")).resolves.toBe("history\n");
    await expect(readFile(join(movedStateRoot, "acp-sessions", "authorization.json"), "utf8")).resolves.toBe("authorization\n");
    await expect(readFile(join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside\n");
  });

  it("recovers an exact crash-after-rename quarantine on the next clear-sessions invocation", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
    });
    const sessionsRoot = join(dir, ".state", "sessions");
    const historyRoot = join(dir, ".state", "history");
    const acpSessionsRoot = join(dir, ".state", "acp-sessions");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
    ]);
    let quarantine = "";

    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterRootQuarantined: (path) => {
          quarantine = path;
          throw new Error("simulated crash after durable rename");
        },
      },
    })).rejects.toThrow(/simulated crash/u);
    await expect(readFile(join(quarantine, "session.jsonl"), "utf8")).resolves.toBe("session\n");
    await expect(assertClearSessionsRecoveryResolved(dir)).rejects.toThrow(/recovery is unresolved/u);

    const result = await purgeConversationState(inputFor(configPath));

    expect(result.sessions).toEqual({ root: sessionsRoot, removed: false, files: 0 });
    expect(result.history.removed).toBe(true);
    expect(result.acpSessions.removed).toBe(true);
    await expect(stat(quarantine)).rejects.toThrow();
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
    await expect(assertClearSessionsRecoveryResolved(dir)).resolves.toBeUndefined();
  });

  it("recovers a registered quarantine after the configured purge roots change", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.old/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.old/sessions" } },
    });
    const oldSessionsRoot = join(dir, ".old", "sessions");
    await mkdir(oldSessionsRoot, { recursive: true });
    await writeFile(join(oldSessionsRoot, "session.jsonl"), "old session\n");
    let quarantine = "";
    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterRootQuarantined: (path) => {
          quarantine = path;
          throw new Error("simulated old-root crash");
        },
      },
    })).rejects.toThrow(/simulated old-root crash/u);

    const newSessionsRoot = join(dir, ".new", "sessions");
    await mkdir(newSessionsRoot, { recursive: true });
    await writeFile(join(newSessionsRoot, "session.jsonl"), "new session\n");
    await writeFile(configPath, JSON.stringify({
      artifacts: { dir: "./.new/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.new/sessions" } },
    }));

    const result = await purgeConversationState(inputFor(configPath));

    expect(result.sessions).toEqual({ root: newSessionsRoot, removed: true, files: 1 });
    await expect(stat(quarantine)).rejects.toThrow();
    await expect(stat(newSessionsRoot)).rejects.toThrow();
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
  });

  it.each([
    {
      name: "combined purge",
      invoke: async (configPath: string) => await purgeConversationState(inputFor(configPath)),
    },
    {
      name: "standalone Pi sessions purge",
      invoke: async (configPath: string) => await purgeSessions(inputFor(configPath)),
    },
    {
      name: "standalone history purge",
      invoke: async (configPath: string) => await purgeConversationHistory(inputFor(configPath)),
    },
    {
      name: "standalone ACP authorization purge",
      invoke: async (configPath: string) => await purgeAcpSessionAuthorizations(inputFor(configPath)),
    },
  ])("$name reconciles an older quarantine before validating malformed current config", async ({ invoke }) => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.old/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.old/sessions" } },
    });
    const pending = await createPendingSessionsQuarantine(configPath, "malformed-current-config");
    await writeFile(configPath, "{ not valid json");

    await expect(invoke(configPath)).rejects.toThrow(/config is not valid JSON/u);

    await expect(stat(pending.quarantine)).rejects.toThrow();
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
    await expect(assertClearSessionsRecoveryResolved(dir)).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "combined purge",
      invoke: async (configPath: string) => await purgeConversationState(inputFor(configPath)),
    },
    {
      name: "standalone Pi sessions purge",
      invoke: async (configPath: string) => await purgeSessions(inputFor(configPath)),
    },
    {
      name: "standalone history purge",
      invoke: async (configPath: string) => await purgeConversationHistory(inputFor(configPath)),
    },
    {
      name: "standalone ACP authorization purge",
      invoke: async (configPath: string) => await purgeAcpSessionAuthorizations(inputFor(configPath)),
    },
  ])("$name refuses recovery when a pending path became a retained process root", async ({ invoke }) => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.old/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.old/sessions" } },
    });
    const pending = await createPendingSessionsQuarantine(configPath, "retained-recovery-path");
    const ownership = await seedRetainedProcessJobRoots([pending.originalRoot]);

    try {
      await expect(invoke(configPath)).rejects.toThrow(
        "restart --clear-sessions overlaps retained process-job private state; nothing was deleted.",
      );
      await expect(readFile(join(pending.quarantine, "session.jsonl"), "utf8")).resolves.toBe("old session\n");
      await expect(stat(pending.quarantine)).resolves.toBeDefined();
      await expect(assertClearSessionsRecoveryResolved(dir)).rejects.toThrow(/recovery is unresolved/u);
    } finally {
      await releaseTestOwnership(ownership);
    }
  });

  it.skipIf(process.platform === "win32")("standalone sessions recovery settles before rejecting an invalid replacement root", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.old/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.old/sessions" } },
    });
    const oldSessionsRoot = join(dir, ".old", "sessions");
    const outsideRoot = join(dir, "outside-standalone-sessions");
    const replacementRoot = join(dir, "replacement-sessions");
    await Promise.all([
      mkdir(oldSessionsRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(oldSessionsRoot, "session.jsonl"), "old session\n"),
      writeFile(join(outsideRoot, "sentinel.txt"), "outside\n"),
    ]);
    let quarantine = "";
    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterRootQuarantined: (path) => {
          quarantine = path;
          throw new Error("simulated standalone sessions crash");
        },
      },
    })).rejects.toThrow(/simulated standalone sessions crash/u);
    await symlink(outsideRoot, replacementRoot, "dir");
    await writeFile(configPath, JSON.stringify({
      providers: { piNative: { piSessionsRoot: "./replacement-sessions" } },
    }));

    await expect(purgeSessions(inputFor(configPath))).rejects.toThrow(/must be a real directory/u);

    await expect(stat(quarantine)).rejects.toThrow();
    await expect(readFile(join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside\n");
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("standalone history recovery settles before replacement-root attestation", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.old/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.old/sessions" } },
    });
    const oldSessionsRoot = join(dir, ".old", "sessions");
    const outsideRoot = join(dir, "outside-standalone-history");
    const newArtifactParent = join(dir, ".new");
    const replacementHistoryRoot = join(newArtifactParent, "history");
    await Promise.all([
      mkdir(oldSessionsRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
      mkdir(newArtifactParent, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(oldSessionsRoot, "session.jsonl"), "old session\n"),
      writeFile(join(outsideRoot, "sentinel.txt"), "outside\n"),
    ]);
    let quarantine = "";
    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterRootQuarantined: (path) => {
          quarantine = path;
          throw new Error("simulated standalone history crash");
        },
      },
    })).rejects.toThrow(/simulated standalone history crash/u);
    await symlink(outsideRoot, replacementHistoryRoot, "dir");
    await writeFile(configPath, JSON.stringify({ artifacts: { dir: "./.new/artifacts" } }));

    await expect(purgeConversationHistory(inputFor(configPath))).rejects.toThrow(/must be a real directory/u);

    await expect(stat(quarantine)).rejects.toThrow();
    await expect(readFile(join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside\n");
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
  });

  it("reconciles an old quarantine before rejecting a replacement root that contains the registry", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.old/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.old/sessions" } },
    });
    const oldSessionsRoot = join(dir, ".old", "sessions");
    const outsideRoot = join(dir, "outside-overlap-recovery");
    await Promise.all([
      mkdir(oldSessionsRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(oldSessionsRoot, "session.jsonl"), "old session\n"),
      writeFile(join(outsideRoot, "sentinel.txt"), "outside\n"),
    ]);
    let quarantine = "";
    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterRootQuarantined: (path) => {
          quarantine = path;
          throw new Error("simulated overlap-recovery crash");
        },
      },
    })).rejects.toThrow(/simulated overlap-recovery crash/u);
    await writeFile(configPath, JSON.stringify({
      artifacts: { dir: "./.mono-agent/clear-sessions-v1/artifacts" },
    }));

    await expect(purgeConversationState(inputFor(configPath))).rejects.toThrow(/registry must be disjoint/u);

    await expect(stat(quarantine)).rejects.toThrow();
    await expect(readFile(join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside\n");
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
    await expect(assertClearSessionsRecoveryResolved(dir)).resolves.toBeUndefined();
  });

  it("recovers a published manifest whose original root was never renamed", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.old/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.old/sessions" } },
    });
    const oldSessionsRoot = join(dir, ".old", "sessions");
    await mkdir(oldSessionsRoot, { recursive: true });
    await writeFile(join(oldSessionsRoot, "session.jsonl"), "old session\n");
    let manifest = "";
    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterManifestPublished: (path) => {
          manifest = path;
          throw new Error("simulated pre-rename crash");
        },
      },
    })).rejects.toThrow(/simulated pre-rename crash/u);
    await expect(stat(manifest)).resolves.toBeDefined();
    await expect(readFile(join(oldSessionsRoot, "session.jsonl"), "utf8")).resolves.toBe("old session\n");
    await writeFile(configPath, JSON.stringify({ artifacts: { dir: "./.new/artifacts" } }));

    await purgeSessions(inputFor(configPath));

    await expect(stat(manifest)).rejects.toThrow();
    await expect(readFile(join(oldSessionsRoot, "session.jsonl"), "utf8")).resolves.toBe("old session\n");
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
  });

  it("recovers a stale manifest after its quarantine was already deleted", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.old/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.old/sessions" } },
    });
    const oldSessionsRoot = join(dir, ".old", "sessions");
    await mkdir(oldSessionsRoot, { recursive: true });
    await writeFile(join(oldSessionsRoot, "session.jsonl"), "old session\n");
    let removedQuarantine = "";
    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterQuarantineRemoved: (path) => {
          removedQuarantine = path;
          throw new Error("simulated post-delete crash");
        },
      },
    })).rejects.toThrow(/simulated post-delete crash/u);
    await expect(stat(removedQuarantine)).rejects.toThrow();
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toHaveLength(1);
    await writeFile(configPath, JSON.stringify({ artifacts: { dir: "./.new/artifacts" } }));

    await purgeConversationState(inputFor(configPath));

    await expect(stat(oldSessionsRoot)).rejects.toThrow();
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("validates every pending manifest before deleting the first quarantine", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
    });
    const sessionsRoot = join(dir, ".state", "sessions");
    const historyRoot = join(dir, ".state", "history");
    const outsideRoot = join(dir, "outside-multi-recovery");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(outsideRoot, "sentinel.txt"), "outside\n"),
    ]);
    const quarantines: string[] = [];
    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterRootQuarantined: (path) => {
          quarantines.push(path);
          if (quarantines.length === 2) throw new Error("simulated two-manifest crash");
        },
      },
    })).rejects.toThrow(/simulated two-manifest crash/u);
    const [first, second] = quarantines as [string, string];
    const movedSecond = `${second}.attacker-moved`;
    await rename(second, movedSecond);
    await symlink(outsideRoot, second, "dir");

    await expect(purgeConversationState(inputFor(configPath))).rejects.toThrow(/non-directory or symbolic-link/u);

    await expect(readFile(join(first, "session.jsonl"), "utf8")).resolves.toBe("session\n");
    await expect(readFile(join(movedSecond, "conversation.history.json"), "utf8")).resolves.toBe("history\n");
    await expect(readFile(join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside\n");
    await expect(assertClearSessionsRecoveryResolved(dir)).rejects.toThrow(/recovery is unresolved/u);
  });

  it.skipIf(process.platform === "win32")("never follows or deletes a quarantine replacement symlink", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
    });
    const sessionsRoot = join(dir, ".state", "sessions");
    const historyRoot = join(dir, ".state", "history");
    const acpSessionsRoot = join(dir, ".state", "acp-sessions");
    const outsideRoot = join(dir, "outside-quarantine-swap");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
      writeFile(join(outsideRoot, "sentinel.txt"), "outside\n"),
    ]);
    let movedQuarantine = "";
    let swapped = false;

    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        beforeQuarantineRemoval: async (path) => {
          if (swapped) return;
          swapped = true;
          movedQuarantine = `${path}.attacker-moved`;
          await rename(path, movedQuarantine);
          await symlink(outsideRoot, path, "dir");
        },
      },
    })).rejects.toThrow(/changed|non-directory|symbolic-link/u);
    await expect(readFile(join(movedQuarantine, "session.jsonl"), "utf8")).resolves.toBe("session\n");
    await expect(readFile(join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside\n");
    await expect(assertClearSessionsRecoveryResolved(dir)).rejects.toThrow(/recovery is unresolved/u);
  });

  it("rejects an atomic config replacement after validation before deleting any root", async () => {
    const configPath = await writeConfig({
      artifacts: { dir: "./.state/artifacts" },
      providers: { piNative: { piSessionsRoot: "./.state/sessions" } },
    });
    const sessionsRoot = join(dir, ".state", "sessions");
    const historyRoot = join(dir, ".state", "history");
    const acpSessionsRoot = join(dir, ".state", "acp-sessions");
    await Promise.all([
      mkdir(sessionsRoot, { recursive: true }),
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sessionsRoot, "session.jsonl"), "session\n"),
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
    ]);
    const replacement = join(dir, "replacement.config.json");

    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterValidation: async () => {
          await writeFile(replacement, JSON.stringify({
            artifacts: { dir: "./replacement/artifacts" },
            providers: { piNative: { piSessionsRoot: "./replacement/sessions" } },
          }));
          await rename(replacement, configPath);
        },
      },
    })).rejects.toThrow(/config changed after validation/u);
    await expect(readFile(join(sessionsRoot, "session.jsonl"), "utf8")).resolves.toBe("session\n");
    await expect(readFile(join(historyRoot, "conversation.history.json"), "utf8")).resolves.toBe("history\n");
    await expect(readFile(join(acpSessionsRoot, "authorization.json"), "utf8")).resolves.toBe("authorization\n");
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
  });

  it("rejects a config that appears after its absence was validated", async () => {
    const configPath = join(dir, "missing.config.json");
    const historyRoot = join(dir, ".mono-agent", "history");
    const acpSessionsRoot = join(dir, ".mono-agent", "acp-sessions");
    await Promise.all([
      mkdir(historyRoot, { recursive: true }),
      mkdir(acpSessionsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(historyRoot, "conversation.history.json"), "history\n"),
      writeFile(join(acpSessionsRoot, "authorization.json"), "authorization\n"),
    ]);

    await expect(purgeConversationState(inputFor(configPath), {
      hooks: {
        afterValidation: async () => {
          await writeFile(configPath, JSON.stringify({
            artifacts: { dir: "./replacement/artifacts" },
          }));
        },
      },
    })).rejects.toThrow(/config changed after validation/u);
    await expect(readFile(join(historyRoot, "conversation.history.json"), "utf8")).resolves.toBe("history\n");
    await expect(readFile(join(acpSessionsRoot, "authorization.json"), "utf8")).resolves.toBe("authorization\n");
    await expect(readdir(clearSessionsRegistryRoot(dir))).resolves.toEqual([]);
  });
});

async function createPendingSessionsQuarantine(
  configPath: string,
  tag: string,
): Promise<{ readonly originalRoot: string; readonly quarantine: string }> {
  const originalRoot = join(dir, ".old", "sessions");
  await mkdir(originalRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(originalRoot, "session.jsonl"), "old session\n");
  let quarantine = "";
  const failure = `simulated ${tag} crash`;
  await expect(purgeConversationState(inputFor(configPath), {
    hooks: {
      afterRootQuarantined: (path) => {
        quarantine = path;
        throw new Error(failure);
      },
    },
  })).rejects.toThrow(failure);
  if (quarantine.length === 0) throw new Error("test did not capture a quarantine path");
  return { originalRoot, quarantine };
}

async function seedRetainedProcessJobRoots(stateDirs: readonly string[]) {
  const homeDir = join(dir, ".test-home");
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const ownership = await acquireAgentRootOwnership(dir, { homeDir });
  const snapshot = await loadProcessJobsRootRegistryProtection(ownership.agentRoot, ownership.agentRoot);
  ownership.coordinator.synchronizeGeneration(snapshot.generation);
  for (const stateDir of stateDirs) {
    const canonicalStateDir = join(ownership.agentRoot, stateDir.slice(dir.length + 1));
    await registerProcessJobsRoot({
      agentRoot: ownership.agentRoot,
      workspace: ownership.agentRoot,
      stateDir: canonicalStateDir,
      coordinator: ownership.coordinator,
    });
  }
  return { ownership, leasePath: agentRootLeasePath(ownership.agentRoot, homeDir) };
}

async function releaseTestOwnership(
  held: Awaited<ReturnType<typeof seedRetainedProcessJobRoots>>,
): Promise<void> {
  held.ownership.release();
  await vi.waitFor(async () => {
    await expect(lstat(held.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, { timeout: 2_000, interval: 10 });
}
