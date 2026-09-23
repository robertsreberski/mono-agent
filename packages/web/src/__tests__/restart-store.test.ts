import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WEB_STORAGE_SCHEMA_VERSION } from "../store-migrations.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))); });
const requestedAt = "2026-09-23T10:00:00.000Z";
const deadline = "2026-09-23T10:02:00.000Z";
const input = { sourceId: "one", generation: "generation-1", requestedAt, deadline, approximateRunningTurns: 2 };

describe("durable restart operations", () => {
  it("upgrades retained schema 35 with a private per-part binding table", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    const old = await WebStore.open({ stateDir });
    const databasePath = old.paths.database;
    old.close();
    const raw = new DatabaseSync(databasePath);
    try { raw.exec("DROP TABLE restart_proposal_bindings; PRAGMA user_version = 35;"); }
    finally { raw.close(); }
    const upgraded = await WebStore.open({ stateDir });
    try {
      expect(upgraded.restartProposalBinding("missing-message", "part")).toBeUndefined();
      const db = new DatabaseSync(upgraded.paths.database);
      try { expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(WEB_STORAGE_SCHEMA_VERSION); }
      finally { db.close(); }
    } finally { upgraded.close(); }
  });
  it("atomically binds one sanitized reply part to its persisted thread source and originating process across reopen", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    const store = await WebStore.open({ stateDir });
    const agent = (sourceId: string) => ({
      sourceId, generation: "generation-1", label: sourceId, status: "online" as const,
      supportsAttachments: false, updatedAt: requestedAt,
      runSettings: { config: {}, override: null, effective: { modelSource: "config" as const, effortSource: "config" as const } },
    });
    store.replaceAgents([agent("one"), agent("other")]);
    const thread = store.createThread("one");
    const turn = store.beginTurn({ threadId: thread.id, text: "question", attachmentIds: [] });
    store.completeTurn(turn.turnId, "reply", {}, [{ type: "restart_proposal", id: "proposal-one", reason: "Short\nreason" },
      { type: "restart_proposal", id: "second", reason: "Another" }] as never,
    { replyProcessGeneration: "generation-1" });
    const part = store.getMessage(turn.assistantMessageId)?.parts.find((p) => p.type === "restart_proposal");
    expect(part).toEqual({ type: "restart_proposal", id: "proposal-one", reason: "Short reason" });
    expect(store.getMessage(turn.assistantMessageId)?.parts.filter((p) => p.type === "restart_proposal")).toHaveLength(1);
    expect(store.restartProposalBinding(turn.assistantMessageId, "proposal-one")).toMatchObject({
      sourceId: "one", threadId: thread.id, generation: "generation-1",
    });
    const forged = store.beginTurn({ threadId: thread.id, text: "next", attachmentIds: [] });
    store.completeTurn(forged.turnId, "reply", {}, [{ type: "restart_proposal", id: "forged",
      sourceId: "other", generation: "generation-other", url: "http://elsewhere" }] as never,
    { replyProcessGeneration: "generation-1" });
    expect(store.getMessage(forged.assistantMessageId)?.parts.some((p) => p.type === "restart_proposal")).toBe(false);
    expect(store.restartProposalBinding(forged.assistantMessageId, "forged")).toBeUndefined();
    const operation = store.createRestartOperation({ ...input, sourceId: "one" }).operation;
    expect(store.claimRestartProposalOperation(turn.assistantMessageId, "proposal-one", "other", "generation-1", operation.id)).toBe(false);
    expect(store.claimRestartProposalOperation(turn.assistantMessageId, "proposal-one", "one", "generation-1", operation.id)).toBe(true);
    expect(store.claimRestartProposalOperation(turn.assistantMessageId, "proposal-one", "one", "generation-1", operation.id)).toBe(false);
    store.close();
    const reopened = await WebStore.open({ stateDir });
    try {
      expect(reopened.restartProposalBinding(turn.assistantMessageId, "proposal-one"))
        .toMatchObject({ sourceId: "one", operationId: operation.id });
      expect(reopened.latestRestartOperation("one")?.id).toBe(operation.id);
      expect(reopened.getMessage(turn.assistantMessageId)?.parts).toContainEqual(part);
      expect(reopened.restartProposalBinding(turn.assistantMessageId, "second")).toBeUndefined();
    } finally { reopened.close(); }
  });

  it("writes before dispatch, deduplicates active requests and retains accepted state across reopen", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    const store = await WebStore.open({ stateDir });
    const first = store.createRestartOperation(input);
    expect(first.created).toBe(true);
    expect(first.operation).toMatchObject({ sourceId: "one", generation: "generation-1", stage: "requesting", approximateRunningTurns: 2 });
    expect(store.createRestartOperation(input)).toEqual({ operation: first.operation, created: false });
    store.updateRestartOperation(first.operation.id, { stage: "restarting", operationId: "agent-op" });
    store.close();
    const reopened = await WebStore.open({ stateDir });
    try {
      expect(reopened.restartOperation(first.operation.id)).toMatchObject({ stage: "restarting", operationId: "agent-op" });
      reopened.updateRestartOperation(first.operation.id, { stage: "back_online", outcome: "success" });
      expect(reopened.createRestartOperation(input).created).toBe(true);
    } finally { reopened.close(); }
  });

  it("recovers a crashed in-flight request as not confirmed without fabricating acceptance", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    const store = await WebStore.open({ stateDir });
    const first = store.createRestartOperation(input).operation;
    store.close();
    const reopened = await WebStore.open({ stateDir });
    try {
      expect(reopened.restartOperation(first.id)).toMatchObject({ stage: "requesting", outcome: "not_confirmed", uncertain: true });
      expect(reopened.activeRestartOperation("one")).toBeUndefined();
    } finally { reopened.close(); }
  });
});
