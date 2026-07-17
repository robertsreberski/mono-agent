import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { WebAgentSummary } from "../contracts.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function agent(sourceId = "agent-one", supportsAttachments = true): WebAgentSummary {
  return {
    sourceId,
    label: sourceId,
    status: "online",
    health: "running",
    supportsAttachments,
    models: ["provider/default"],
    defaultModel: "provider/default",
    efforts: ["low", "high"],
    modelOptions: { "provider/default": { effortLevels: ["low", "high"] } },
    updatedAt: "2026-07-17T09:00:00.000Z",
  };
}

describe("WebStore", () => {
  it("persists agent pins independently of discovery and sorts pinned agents first", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent("alpha"), agent("zulu")]);

    expect(store.listAgents().map(({ sourceId, pinned }) => ({ sourceId, pinned }))).toEqual([
      { sourceId: "alpha", pinned: false },
      { sourceId: "zulu", pinned: false },
    ]);
    expect(store.setAgentPinned("zulu", true)).toMatchObject({ sourceId: "zulu", pinned: true });
    store.replaceAgents([agent("alpha")]);
    expect(store.listAgents()[0]).toMatchObject({
      sourceId: "zulu",
      pinned: true,
      status: "offline",
    });
    store.replaceAgents([agent("zulu"), agent("alpha")]);
    expect(store.listAgents().map(({ sourceId, pinned }) => ({ sourceId, pinned }))).toEqual([
      { sourceId: "zulu", pinned: true },
      { sourceId: "alpha", pinned: false },
    ]);
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.listAgents()[0]).toMatchObject({ sourceId: "zulu", pinned: true });
    expect(reopened.setAgentPinned("zulu", false)).toMatchObject({ sourceId: "zulu", pinned: false });
    expect(() => reopened.setAgentPinned("missing", true)).toThrowError(expect.objectContaining({ code: "agent_not_found" }));
    reopened.close();
  });

  it("persists permanently agent-bound threads, structured messages, and archive state", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const created = store.createThread("agent-one");

    const turn = store.beginTurn({
      threadId: created.id,
      text: "First prompt for the title",
      attachmentIds: [],
      model: "provider/default",
      effort: "high",
    });
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "Answer" },
      { kind: "event", event: { type: "assistant_thought", text: "Think" } },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: { q: "x" } } },
      { kind: "event", event: { type: "tool_call_completed", id: "tool-1", name: "Search", content: "done" } },
    ]);
    const detail = store.completeTurn(turn.turnId, "Final answer");

    expect(detail.thread.sourceId).toBe("agent-one");
    expect(detail.thread.title).toBe("First prompt for the title");
    expect(detail.thread.runState).toMatchObject({ status: "complete", model: "provider/default", effort: "high" });
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1]?.parts).toEqual([
      { type: "text", text: "Final answer" },
      { type: "reasoning", text: "Think" },
      { type: "tool-call", toolCallId: "tool-1", toolName: "Search", args: { q: "x" }, result: "done", status: "complete" },
    ]);

    const archived = store.patchThread(created.id, { archived: true });
    expect(archived.archivedAt).toMatch(/^\d{4}-/u);
    expect(() => store.beginTurn({ threadId: created.id, text: "no", attachmentIds: [] })).toThrowError(/Unarchive/u);
    expect(store.patchThread(created.id, { archived: false }).sourceId).toBe("agent-one");
    store.close();
  });

  it("enforces one active turn per thread while allowing parallel threads", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const one = store.createThread("agent-one");
    const two = store.createThread("agent-one");
    const first = store.beginTurn({ threadId: one.id, text: "one", attachmentIds: [] });
    expect(() => store.beginTurn({ threadId: one.id, text: "again", attachmentIds: [] })).toThrowError(/active turn/u);
    expect(store.beginTurn({ threadId: two.id, text: "parallel", attachmentIds: [] }).turnId).toBeTruthy();
    store.interruptTurn(first.turnId);
    store.close();
  });

  it("recovers running turns as interrupted after an unclean restart", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.beginTurn({ threadId: thread.id, text: "unfinished", attachmentIds: [] });
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThread(thread.id)?.runState).toMatchObject({ status: "interrupted", error: { code: "interrupted" } });
    expect(reopened.getThreadDetail(thread.id)?.messages.at(-1)?.status).toBe("interrupted");
    reopened.close();
  });

  it("commits ready staged attachments to the user message and never purges them", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const committed = store.createUpload({ name: "notes.txt", contentType: "text/plain", kind: "document", declaredSize: 5 });
    await writeFile(store.attachmentPath(committed), "hello", { mode: 0o600 });
    store.markUploadComplete(committed.id, 5);
    const staged = store.createUpload({ name: "stale.txt", contentType: "text/plain", kind: "document", declaredSize: 1 });

    const turn = store.beginTurn({ threadId: thread.id, text: "", attachmentIds: [committed.id] });
    expect(store.getThreadDetail(thread.id)?.messages[0]?.attachments[0]).toMatchObject({ name: "notes.txt", status: "committed", uploaded: true });
    expect(store.getStoredAttachment(committed.id)?.threadId).toBe(thread.id);
    expect(await store.purgeStagedAttachments("9999-01-01T00:00:00.000Z")).toBe(1);
    expect(store.getStoredAttachment(staged.id)).toBeUndefined();
    expect(store.getStoredAttachment(committed.id)).toBeDefined();
    store.interruptTurn(turn.turnId);
    store.close();
  });

  it("disables sends when the bound agent goes offline and uploads for legacy agents", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent("legacy", false)]);
    const thread = store.createThread("legacy");
    expect(store.getThread(thread.id)).toMatchObject({ canSend: true, canUpload: false });

    store.replaceAgents([]);
    expect(store.getThread(thread.id)).toMatchObject({ canSend: false, canUpload: false, sourceId: "legacy" });
    expect(() => store.beginTurn({ threadId: thread.id, text: "offline", attachmentIds: [] })).toThrowError(/offline/u);
    store.close();
  });

  it("keeps staged rows recoverable when file removal fails", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    const attachment = store.createUpload({ name: "keep.txt", contentType: "text/plain", kind: "document", declaredSize: 4 });
    await writeFile(store.attachmentPath(attachment), "keep", { mode: 0o600 });
    await chmod(store.paths.uploads, 0o500);
    try {
      await expect(store.removeStagedAttachment(attachment.id)).rejects.toBeDefined();
      expect(store.getStoredAttachment(attachment.id)).toBeDefined();
    } finally {
      await chmod(store.paths.uploads, 0o700);
    }
    await expect(store.removeStagedAttachment(attachment.id)).resolves.toBeUndefined();
    store.close();
  });

  it("maps warnings/failover/usage and keeps run_config model/effort", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "telemetry", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "runtime_warning", message: "fallback", warningKind: "provider" } },
      { kind: "event", event: { type: "provider_status", kind: "failover_started", from: "one", to: "two" } },
      { kind: "event", event: { type: "usage_update", model: "two", cumulativeUsd: 0.01 } },
      { kind: "event", event: { type: "runtime_telemetry", kind: "run_config", data: { model: "actual", effort: "xhigh" } } },
    ]);
    const detail = store.completeTurn(turn.turnId, "");
    expect(detail.thread.runState).toMatchObject({ model: "actual", effort: "xhigh" });
    expect(detail.messages.at(-1)?.parts.map((part) => part.type === "telemetry" ? part.event : part.type)).toEqual([
      "runtime_warning", "provider_status", "usage_update", "runtime_telemetry",
    ]);
    store.close();
  });

  it("reconciles a divergent replace frame across interleaved text without dropping tools", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "replace", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "a" },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: { q: "x" } } },
      { kind: "append", delta: "b" },
      { kind: "replace", text: "X" },
    ]);
    const detail = store.completeTurn(turn.turnId, "");
    const assistant = detail.messages.at(-1);
    expect(assistant?.parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "Search",
        args: { q: "x" },
        status: "running",
      },
      { type: "text", text: "X" },
    ]);
    store.close();
  });

  it("rejects a future schema without retaining the failed database handle", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    const databasePath = initial.paths.database;
    initial.close();

    const future = new DatabaseSync(databasePath);
    future.exec("PRAGMA user_version = 2");
    future.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "unsupported_storage_schema" });

    const restored = new DatabaseSync(databasePath);
    restored.exec("PRAGMA user_version = 1");
    restored.close();
    const reopened = await WebStore.open({ stateDir });
    reopened.close();
  });

  it("fails closed on malformed persisted message parts and recovers after external repair", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    initial.replaceAgents([agent()]);
    const thread = initial.createThread("agent-one");
    const turn = initial.beginTurn({ threadId: thread.id, text: "persist", attachmentIds: [] });
    initial.completeTurn(turn.turnId, "answer");
    const assistantId = initial.getThreadDetail(thread.id)?.messages.at(-1)?.id;
    if (assistantId === undefined) throw new Error("Expected a persisted assistant message.");
    const databasePath = initial.paths.database;
    initial.close();

    const corrupt = new DatabaseSync(databasePath);
    corrupt.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run("{not-json", assistantId);
    corrupt.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "storage_corrupt" });

    const repaired = new DatabaseSync(databasePath);
    repaired.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run("[]", assistantId);
    repaired.close();
    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThreadDetail(thread.id)?.messages.at(-1)?.parts).toEqual([]);
    reopened.close();
  });
});
