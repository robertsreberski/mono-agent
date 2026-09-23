import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))); });
const requestedAt = "2026-09-23T10:00:00.000Z";
const deadline = "2026-09-23T10:02:00.000Z";
const input = { sourceId: "one", generation: "generation-1", requestedAt, deadline, approximateRunningTurns: 2 };

describe("durable restart operations", () => {
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
