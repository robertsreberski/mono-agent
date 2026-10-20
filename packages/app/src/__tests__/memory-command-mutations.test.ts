import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as bujo from "@mono-agent/memory/bujo";
import type { EmbeddingProvider } from "@mono-agent/memory/search";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[], live: [] as boolean[], refuse: false, nativeFailure: false, packageFailure: false,
  failAfterMutation: false, model: vi.fn(),
}));
const privateCanary = "FICTIONAL_PRIVATE_MEMORY /fictional/private/record.md";
const embeddings: EmbeddingProvider = {
  id: "ollama:test-embed",
  async embed(texts) { return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]); },
};

vi.mock("../cli/commands/memory/context.js", async (original) => ({
  ...await original<typeof import("../cli/commands/memory/context.js")>(),
  memoryRegistryDirs: async () => { state.events.push("registry"); return []; },
  hasLiveConfiguredAgent: async () => { state.events.push("observe"); return state.live.shift() ?? false; },
  assertNoLiveConfiguredAgent: async () => {
    state.events.push("stopped-check");
    if (state.refuse) throw new Error("FICTIONAL_PRIVATE_MEMORY /fictional/private/record.md");
  },
}));
vi.mock("../cli/commands/memory/store-access.js", async (original) => ({
  ...await original<typeof import("../cli/commands/memory/store-access.js")>(),
  loadBujoModule: async () => {
    state.events.push("load-bujo");
    if (state.nativeFailure) throw new Error("FICTIONAL_PRIVATE_MEMORY native module /fictional/private/record.md");
    const actual = await import("@mono-agent/memory/bujo");
    return {
      ...actual,
      adoptLegacyReplayProjection: async () => {
        state.events.push("adopt");
        if (state.packageFailure) throw new Error("FICTIONAL_PRIVATE_MEMORY /fictional/private/record.md");
        return { backend: "bujo", mode: "bujo", status: "adopted", counts: { terminals: 1, supersedes: 2, threads: 3 },
          authorityDigest: "a".repeat(64), rebuildRequired: true, privateDetail: "FICTIONAL_PRIVATE_MEMORY" };
      },
      applyExplicitMemoryForget: async (options: bujo.ApplyExplicitMemoryForgetOptions) => {
        state.events.push("apply");
        return await actual.applyExplicitMemoryForget({ ...options, hooks: {
          afterBackupDurable: () => { state.events.push("backup-durable"); },
          afterTransactionDurable: () => { state.events.push("transaction-durable"); },
          afterMutation: () => {
            state.events.push("mutation");
            if (state.failAfterMutation) throw new Error("FICTIONAL_PRIVATE_MEMORY /fictional/private/record.md");
          },
          afterRootActivated: () => { state.events.push("restore-activated"); },
        } });
      },
    };
  },
  loadMemoryRecallModule: async () => {
    state.events.push("load-recall");
    return { createMemoryEmbeddingProvider: async () => { state.events.push("embedding"); return embeddings; } };
  },
}));
vi.mock("../composition/configured-memory.js", () => {
  state.model();
  throw new Error("model owner must not load for a deterministic pass");
});

import { runMemoryCommand } from "../cli/commands/memory-command.js";

const roots: string[] = [];
beforeEach(() => {
  state.events.length = 0;
  state.live.length = 0;
  state.refuse = state.nativeFailure = state.packageFailure = state.failAfterMutation = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([false, true])("rechecks stopped state on each side of lazy adoption loading (json=%s)", async (json) => {
  const root = await fixture();
  state.live.push(false, true);
  expect(await invoke(root, { positionals: ["adopt-replay"], json })).toEqual(replayFailure(json, "replay_adoption_agent_running",
    "Replay adoption requires the configured agent to be stopped. Stop it and retry."));
  expect(state.events).toEqual(["registry", "observe", "load-bujo", "observe"]);
});

it.each(["native", "package", "config"] as const)("sanitizes exact %s adoption failures without effects leaking private prose", async (failure) => {
  const root = await fixture();
  if (failure === "config") await writeFile(join(root, "mono-agent.config.json"), privateCanary);
  state.nativeFailure = failure === "native";
  state.packageFailure = failure === "package";
  for (const json of [false, true]) {
    state.events.length = 0;
    const code = failure === "config" ? "replay_adoption_config_invalid" : "replay_adoption_failed";
    const message = failure === "config" ? "Replay adoption requires a valid mono-agent configuration."
      : "Replay adoption failed. Keep the agent stopped, inspect strict memory health, resolve the reported condition, and retry.";
    expect(await invoke(root, { positionals: ["adopt-replay"], json })).toEqual(replayFailure(json, code, message));
    expect(state.events).toEqual(failure === "config" ? [] : failure === "native"
      ? ["registry", "observe", "load-bujo"] : ["registry", "observe", "load-bujo", "observe", "adopt"]);
  }
});

it("projects only public adoption aggregates after both observations", async () => {
  const root = await fixture();
  expect(await invoke(root, { positionals: ["adopt-replay"], json: true })).toEqual({ code: 0, stderr: "", stdout: `${JSON.stringify({
    backend: "bujo", mode: "bujo", status: "adopted", counts: { terminals: 1, supersedes: 2, threads: 3 },
    authorityDigest: "a".repeat(64), rebuildRequired: true,
  }, null, 2)}\n` });
  expect(state.events).toEqual(["registry", "observe", "load-bujo", "observe", "adopt"]);
});

it.each([false, true])("refuses forget before embedding/model construction with exact sanitized streams (json=%s)", async (json) => {
  const root = await fixture();
  await prepareForget(root);
  const before = bujo.readBujoCanonicalSourceFingerprint(join(root, "memory"));
  state.events.length = 0;
  state.refuse = true;
  const result = await invoke(root, { positionals: ["forget", "apply"], planPath: "forget-plan.json", json });
  const message = "Forget-plan application failed before a recoverable backup was available.";
  const payload = { schemaVersion: 1, operation: "forget-apply", status: "failed", code: "forget_apply_failed", message };
  expect(result).toEqual({ code: 1, stdout: json ? `${JSON.stringify(payload, null, 2)}\n` : "",
    stderr: json ? "" : `✗ [forget_apply_failed] ${message}\n` });
  expect(state.events).toEqual(["load-bujo", "load-bujo", "registry", "stopped-check"]);
  expect(bujo.readBujoCanonicalSourceFingerprint(join(root, "memory"))).toBe(before);
  expect(state.model).not.toHaveBeenCalled();
});

it("orders a real durable backup, mutation and verified restore after an injected forget fault", async () => {
  const root = await fixture();
  await prepareForget(root);
  const memory = join(root, "memory");
  const before = bujo.readBujoCanonicalSourceFingerprint(memory);
  const source = await readFile(join(memory, "daily", "2026-04-03.md"));
  state.events.length = 0;
  state.failAfterMutation = true;
  const result = await invoke(root, { positionals: ["forget", "apply"], planPath: "forget-plan.json", json: true });
  const plan = JSON.parse(await readFile(join(root, "forget-plan.json"), "utf8")) as { planDigest: string };
  const backupPath = join(root, `.memory-forget-backup-${plan.planDigest.slice(0, 24)}`);
  expect(result).toEqual({ code: 1, stderr: "", stdout: `${JSON.stringify({ schemaVersion: 1, operation: "forget-apply", status: "failed",
    code: "forget_apply_failed_recovered", message: "Forget-plan application failed and the complete pre-apply backup was restored.",
    recovered: true, backupPath }, null, 2)}\n` });
  expect(state.events).toEqual(["load-bujo", "load-bujo", "registry", "stopped-check", "load-recall", "embedding", "apply",
    "backup-durable", "transaction-durable", "mutation", "restore-activated"]);
  expect(bujo.readBujoCanonicalSourceFingerprint(memory)).toBe(before);
  expect(await readFile(join(memory, "daily", "2026-04-03.md"))).toEqual(source);
  expect(JSON.parse(await readFile(join(backupPath, "manifest.json"), "utf8"))).toMatchObject({ status: "recovered" });
  expect(state.model).not.toHaveBeenCalled();
});

it("keeps limit-zero curation model-free through private-plan publication", async () => {
  const root = await fixture();
  const result = await invoke(root, { positionals: ["curate", "prepare"], planPath: "curate-plan.json", limit: 0, json: true });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ operation: "curate-prepare", status: "prepared" });
  expect(state.events).toEqual(["load-bujo"]);
  expect(state.model).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(root, "curate-plan.json"), "utf8"))).toMatchObject({ proposals: [] });
});

async function fixture(): Promise<string> {
  const lexical = await mkdtemp(join(tmpdir(), "memory-command-mutations-"));
  roots.push(lexical);
  const root = await realpath(lexical);
  await mkdir(join(root, "memory"), { mode: 0o700 });
  await writeFile(join(root, "IDENTITY.md"), "# Fictional agent\n");
  await writeFile(join(root, "mono-agent.config.json"), JSON.stringify({
    runtime: { model: "ollama:test-model" }, context: { identityPath: "./IDENTITY.md" },
    memory: { mode: "bujo", path: "./memory", writeMode: "capture",
      embeddings: { provider: "ollama", model: "test-embed", dim: 8 }, llm: { provider: "ollama", model: "fictional-model" } },
  }));
  bujo.appendBullet(join(root, "memory"), { id: "fictional-note", type: "note", status: "open", text: "Fictional sample for cleanup.",
    salience: 0.5, isInsight: false, createdAt: "2026-04-03T10:00:00.000Z", refs: [] }, new Date("2026-04-03T10:00:00.000Z"));
  await bujo.safeRebuildMemoryIndex({ root: join(root, "memory"), tier: "bujo", embeddings, dim: 8 });
  return root;
}

async function prepareForget(root: string): Promise<void> {
  await writeFile(join(root, "ids.txt"), "fictional-note\n");
  const result = await invoke(root, { positionals: ["forget", "prepare"], idsFile: "ids.txt", reason: "cleanup", planPath: "forget-plan.json", json: true });
  expect(result.code, result.stderr + result.stdout).toBe(0);
}

function replayFailure(json: boolean, code: string, message: string) {
  return { code: 1, stdout: json ? `${JSON.stringify({ schemaVersion: 1, operation: "adopt-replay", status: "failed", code, message }, null, 2)}\n` : "",
    stderr: json ? "" : `✗ [${code}] ${message}\n` };
}

async function invoke(cwd: string, input: Partial<Parameters<typeof runMemoryCommand>[0]>) {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
  try { return { code: await runMemoryCommand({ cwd, env: {}, positionals: [], json: false, strict: false, ...input }), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}
