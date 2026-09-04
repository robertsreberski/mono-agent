import { spawn } from "node:child_process";
import { chmod, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_AGENT_REPLY_PARTS, type AgentReplyPart } from "@mono-agent/agent-contracts";

import type { WebAgentSummary } from "../contracts.js";
import {
  WEB_SEARCH_HIGHLIGHT_CLOSE,
  WEB_SEARCH_HIGHLIGHT_OPEN,
  WEB_THREAD_SEARCH_MAX,
  WEB_THREAD_SEARCH_MIN_QUERY,
  WebStore,
} from "../store.js";
import { fakeMonitor, fakeProcessJob, temporaryRoot } from "./helpers.js";

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
  it("broadcasts a replaced agent process without broadcasting its heartbeat", async () => {
    // The generation is what the browser watches to know its per-agent caches
    // -- the `/v1/models` pages above all -- describe a process that is gone.
    // It therefore has to reach the browser: a restart behind an otherwise
    // identical summary must still read as a notable change. The heartbeat
    // must not, or the whole agent list is rebroadcast every discovery pass.
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    const first = { ...agent(), generation: "gen-1" };

    expect(store.replaceAgents([first])).toBe(true);
    expect(store.listAgents()[0]?.generation).toBe("gen-1");
    expect(store.replaceAgents([first])).toBe(false);
    expect(store.replaceAgents([{ ...first, updatedAt: "2026-07-17T09:00:05.000Z" }])).toBe(false);

    const restarted = { ...first, generation: "gen-2", updatedAt: "2026-07-17T09:00:10.000Z" };
    expect(store.replaceAgents([restarted])).toBe(true);
    expect(store.listAgents()[0]?.generation).toBe("gen-2");
    expect(store.getAgent("agent-one")?.generation).toBe("gen-2");

    // Not a column: it describes the process behind a source id right now, and
    // a value read back from disk would be a claim about a process nobody
    // probed. A summary with none leaves the field absent rather than stale.
    expect(store.replaceAgents([agent()])).toBe(true);
    expect(store.listAgents()[0]?.generation).toBeUndefined();
    store.close();
  });

  it("does not advance an agent generation the transaction never persisted", async () => {
    // The generation is stitched onto every row read back, so advancing the map
    // BEFORE the write made a failed transaction permanent: the retry compared
    // the restarted summary against a prior that already carried the new
    // generation, saw only `updatedAt` differ, and reported `notable === false`.
    // No `agents.changed` frame was ever emitted for that restart and an open
    // console kept serving caches for a process that was gone.
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    const first = { ...agent(), generation: "gen-1" };
    expect(store.replaceAgents([first])).toBe(true);

    // One failed transaction. Injected on the instance rather than simulated
    // through a payload, so the repro is exactly "the write threw" and nothing
    // about the summary itself is special.
    const prototype = Object.getPrototypeOf(store) as Record<string, unknown>;
    const realTransaction = prototype.transaction as (this: unknown, run: () => unknown) => unknown;
    let failNext = true;
    Object.defineProperty(store, "transaction", {
      configurable: true,
      value: function transaction(this: unknown, run: () => unknown): unknown {
        if (failNext) {
          failNext = false;
          // A REAL transaction that does all of its work and then fails to
          // commit, rather than one that refuses to start. Both roll back to
          // the same place, but this one also runs the callback, so anything
          // the callback itself advances is caught here too.
          return realTransaction.call(this, () => {
            run();
            throw new Error("simulated agent write failure");
          });
        }
        return realTransaction.call(this, run);
      },
    });

    const restarted = { ...first, generation: "gen-2", updatedAt: "2026-07-17T09:00:05.000Z" };
    expect(() => store.replaceAgents([restarted])).toThrowError(/simulated agent write failure/u);
    // Nothing was written, so nothing may claim it was: the store must still
    // describe the process it last persisted.
    expect(store.listAgents()[0]?.generation).toBe("gen-1");
    expect(store.listAgents()[0]?.updatedAt).toBe("2026-07-17T09:00:00.000Z");

    // The retry carries the identical summary. It is still a restart.
    expect(store.replaceAgents([restarted])).toBe(true);
    expect(store.listAgents()[0]?.generation).toBe("gen-2");
    expect(store.listAgents()[0]?.updatedAt).toBe("2026-07-17T09:00:05.000Z");

    // And the heartbeat suppression this shares a function with still holds:
    // an idle fleet emits nothing.
    expect(store.replaceAgents([restarted])).toBe(false);
    expect(store.replaceAgents([{ ...restarted, updatedAt: "2026-07-17T09:00:10.000Z" }])).toBe(false);
    store.close();
  });

  it("applies a conditional run-config patch and its refusal in one transaction", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");

    expect(store.patchThreadIfRunConfigUnset(thread.id, { model: "anthropic:opus-5" }))
      .toMatchObject({ applied: true, thread: { runModel: "anthropic:opus-5", runEffort: null } });

    const held = store.getThread(thread.id)!;
    // The precondition covers BOTH fields. Reading only `runModel` let an
    // adoption overwrite a real effort-only choice made in another tab.
    store.patchThread(thread.id, { model: null });
    store.patchThread(thread.id, { effort: "low" });
    const contested = store.getThread(thread.id)!;
    const refused = store.patchThreadIfRunConfigUnset(thread.id, {
      model: "anthropic:sonnet-5",
      effort: "high",
    });
    expect(refused.applied).toBe(false);
    // A refusal writes nothing at all: same revision, same everything.
    expect(refused.thread).toEqual(contested);
    expect(store.getThread(thread.id)).toEqual(contested);
    expect(held.runModel).toBe("anthropic:opus-5");

    store.patchThread(thread.id, { effort: null });
    expect(store.patchThreadIfRunConfigUnset(thread.id, { effort: "high" }))
      .toMatchObject({ applied: true, thread: { runEffort: "high" } });
    expect(() => store.patchThreadIfRunConfigUnset("missing", { effort: "low" }))
      .toThrowError(/not found/iu);
    store.close();
  });

  it("holds the precondition read inside the same transaction as its write", async () => {
    // The sequential test above passes with the read moved OUTSIDE
    // `BEGIN IMMEDIATE`, so it does not prove what the method's comment claims.
    // This does, with a real second connection in a real second PROCESS: the
    // service lease is held on a different file, so it makes this process the
    // only *service* writing, not this statement the only writer.
    //
    // The other connection takes the write lock, updates the same row and
    // holds the transaction open. A compare-and-set whose read is inside its
    // own `BEGIN IMMEDIATE` cannot read until that commits, so it sees the
    // contested effort and REFUSES. A read outside would see the pre-commit
    // snapshot, find the run config unset, wait for the lock and then apply --
    // overwriting a choice made in another tab, which is the whole failure the
    // conditional exists to prevent.
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const databasePath = join(stateDir, "state.sqlite");

    const child = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE threads SET run_effort = 'low' WHERE id = ?").run(process.argv[2]);
      console.log("held");
      // Long enough that the parent is certainly blocked on the lock, short
      // enough to stay far inside the 5s busy timeout it waits with.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      db.exec("COMMIT");
      db.close();
    `, databasePath, thread.id], { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exited = new Promise<number | null>((resolve) => { child.on("exit", resolve); });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("held")) resolve();
      });
      child.on("exit", () => {
        reject(new Error(`the contending writer exited early: ${Buffer.concat(stderr).toString("utf8")}`));
      });
    });

    const result = store.patchThreadIfRunConfigUnset(thread.id, { model: "anthropic:opus-5" });
    expect(await exited).toBe(0);
    expect(result.applied).toBe(false);
    expect(result.thread.runEffort).toBe("low");
    expect(result.thread.runModel).toBeNull();
    expect(store.getThread(thread.id)?.runEffort).toBe("low");
    expect(store.getThread(thread.id)?.runModel).toBeNull();
    store.close();
  });

  it("applies agent titles idempotently until a manual rename permanently locks the thread", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");

    expect(store.canApplyAgentTitle(thread.id)).toBe(true);
    expect(store.applyAgentTitle(thread.id, "Semantic topic title")).toMatchObject({
      title: "Semantic topic title",
      revision: 2,
    });
    expect(store.applyAgentTitle(thread.id, "Semantic topic title")).toBeUndefined();
    expect(store.getThread(thread.id)?.revision).toBe(2);

    expect(store.patchThread(thread.id, { title: "My permanent title" })).toMatchObject({
      title: "My permanent title",
      revision: 3,
    });
    expect(store.canApplyAgentTitle(thread.id)).toBe(false);
    expect(store.applyAgentTitle(thread.id, "Agent overwrite")).toBeUndefined();
    expect(store.getThread(thread.id)).toMatchObject({ title: "My permanent title", revision: 3 });
    store.close();
  });

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

  it("round-trips durable reply attachments/apps and records invalid rich parts as per-part failures", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "show results", attachmentIds: [] });
    const detail = store.completeTurn(turn.turnId, "Done", undefined, [
      {
        type: "attachment",
        id: "attachment-part",
        reference: { scheme: "mono-agent-artifact", id: "artifact-one" },
        name: "report.txt",
        mediaType: "text/plain",
        sizeBytes: 12,
        integrityId: `sha256:${"a".repeat(64)}`,
        expiresAt: "2026-09-14T12:00:00.000Z",
      },
      {
        type: "mcp_app",
        id: "11111111-1111-4111-8111-111111111111",
        invocationId: "11111111-1111-4111-8111-111111111111",
        connectionId: "connection-one",
        serverName: "widgets",
        toolName: "show_chart",
        resourceUri: "ui://widgets/chart",
        mediaType: "text/html;profile=mcp-app",
        protocolVersion: "2026-01-26",
        title: "Chart",
        expiresAt: "2026-09-14T12:00:00.000Z",
      },
      {
        type: "attachment",
        id: "oversized",
        reference: { scheme: "mono-agent-artifact", id: "artifact-two" },
        name: "large.bin",
        mediaType: "application/octet-stream",
        sizeBytes: 20 * 1024 * 1024 + 1,
        integrityId: `sha256:${"b".repeat(64)}`,
      },
    ]);

    expect(detail.messages.at(-1)?.parts).toMatchObject([
      { type: "text", text: "Done" },
      { type: "attachment", artifactId: "artifact-one", name: "report.txt" },
      { type: "mcp_app", connectionId: "connection-one", title: "Chart" },
      { type: "failure", id: "oversized", code: "artifact_too_large" },
    ]);
    expect(JSON.stringify(detail.messages.at(-1)?.parts)).not.toContain("reference");

    const key = store.ensureReplyAccessKey(() => "a".repeat(43));
    store.close();
    const reopened = await WebStore.open({ stateDir });
    expect(reopened.ensureReplyAccessKey(() => "b".repeat(43))).toBe(key);
    expect(reopened.getMessage(detail.messages.at(-1)!.id)?.parts).toEqual(detail.messages.at(-1)?.parts);
    reopened.close();
  });

  it("bounds direct rich-part writes and keeps every decorated capability out of SQLite", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "bypass wire parser", attachmentIds: [] });
    const injected = Array.from({ length: MAX_AGENT_REPLY_PARTS + 5 }, (_, index) => {
      const decorated = index % 2 === 0
        ? {
            type: "attachment",
            id: `part-${index}`,
            reference: { scheme: "mono-agent-artifact", id: `artifact-${index}` },
            name: `report-${index}.txt`,
            mediaType: "text/plain",
            sizeBytes: index,
            integrityId: `sha256:${index.toString(16).padStart(64, "0")}`,
          }
        : {
            type: "mcp_app",
            id: `part-${index}`,
            invocationId: `part-${index}`,
            connectionId: `connection-${index}`,
            serverName: "widgets",
            toolName: "show_chart",
            resourceUri: `ui://widgets/chart-${index}`,
            mediaType: "text/html;profile=mcp-app",
            protocolVersion: "2026-01-26",
          };
      return {
        ...decorated,
        contentUrl: `/stolen/content?access=decorated-${index}&token=secret-${index}`,
        resourceUrl: `/stolen/resource?token=secret-${index}`,
        bridgeUrl: `/stolen/bridge?access_token=secret-${index}`,
        token: `secret-${index}`,
        tokens: [`secret-${index}`],
        access: { query: `token=secret-${index}` },
        accessQuery: `expires=9999999999&token=secret-${index}`,
      } as unknown as AgentReplyPart;
    });

    const detail = store.completeTurn(turn.turnId, "Bounded", undefined, injected);
    const outcomes = detail.messages.at(-1)!.parts.filter(
      (part) => part.type === "attachment" || part.type === "mcp_app" || part.type === "failure",
    );
    expect(outcomes).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(outcomes.slice(0, MAX_AGENT_REPLY_PARTS - 1).map((part) => "id" in part ? part.id : undefined))
      .toEqual(Array.from({ length: MAX_AGENT_REPLY_PARTS - 1 }, (_, index) => `part-${index}`));
    expect(outcomes.at(-1)).toEqual({
      type: "failure",
      id: "web-reply-parts-truncated",
      code: "reply_part_too_large",
      message: `The web console retained 0 existing and ${MAX_AGENT_REPLY_PARTS - 1} incoming rich reply parts, omitted 0 existing and 6 incoming parts, and used one diagnostic slot; before reserving it, ${MAX_AGENT_REPLY_PARTS} of ${MAX_AGENT_REPLY_PARTS} outcome slots were available to incoming parts.`,
    });

    const databasePath = store.paths.database;
    const raw = new DatabaseSync(databasePath);
    const row = raw.prepare("SELECT parts_json FROM messages WHERE id = ?")
      .get(detail.messages.at(-1)!.id) as unknown as { parts_json: string };
    raw.close();
    expect(row.parts_json).not.toMatch(/contentUrl|resourceUrl|bridgeUrl|accessQuery|access_token|secret-/u);
    expect(row.parts_json).not.toMatch(/"tokens?"|"access"/u);
    store.close();

    const corrupt = new DatabaseSync(databasePath);
    const parts = JSON.parse(row.parts_json) as Array<Record<string, unknown>>;
    const storedAttachment = parts.find((part) => part.type === "attachment")!;
    storedAttachment.contentUrl = "/api/v1/threads/durable-capability";
    corrupt.prepare("UPDATE messages SET parts_json = ? WHERE id = ?")
      .run(JSON.stringify(parts), detail.messages.at(-1)!.id);
    corrupt.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "storage_corrupt" });
  });

  it("allocates deterministic collision-free IDs across existing, omitted, sparse, invalid, and reopened parts", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const existing = {
      type: "failure" as const,
      id: "web-reply-parts-truncated",
      code: "unsupported_destination" as const,
      message: "Existing durable outcome.",
    };
    const incoming = Array.from({ length: MAX_AGENT_REPLY_PARTS + 3 }, (_, index): AgentReplyPart => ({
      type: "failure",
      id: index === 0
        ? "web-reply-parts-truncated-2"
        : index === MAX_AGENT_REPLY_PARTS + 2
          ? "web-reply-parts-truncated-3"
          : `incoming-${index}`,
      code: "artifact_missing",
      message: `Incoming outcome ${index}.`,
    }));
    const injectExisting = (messageId: string) => {
      const raw = new DatabaseSync(store.paths.database);
      raw.prepare("UPDATE messages SET parts_json = ? WHERE id = ?")
        .run(JSON.stringify([existing]), messageId);
      raw.close();
    };
    const completeCollidingTurn = () => {
      const thread = store.createThread("agent-one");
      const turn = store.beginTurn({ threadId: thread.id, text: "collision", attachmentIds: [] });
      injectExisting(turn.assistantMessageId);
      const detail = store.completeTurn(turn.turnId, "done", undefined, incoming);
      const message = detail.messages.at(-1)!;
      return {
        messageId: message.id,
        outcomes: message.parts.filter((part) => "id" in part),
      };
    };

    const first = completeCollidingTurn();
    const second = completeCollidingTurn();
    const generated = first.outcomes.slice(1);
    expect(first.outcomes).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(generated).toHaveLength(MAX_AGENT_REPLY_PARTS - 1);
    expect(generated.slice(0, MAX_AGENT_REPLY_PARTS - 2).map((part) => part.id))
      .toEqual(incoming.slice(0, MAX_AGENT_REPLY_PARTS - 2).map((part) => part.id));
    expect(generated.at(-1)).toMatchObject({
      type: "failure",
      id: "web-reply-parts-truncated-4",
      code: "reply_part_too_large",
      message: `The web console retained 1 existing and ${MAX_AGENT_REPLY_PARTS - 2} incoming rich reply parts, omitted 0 existing and 5 incoming parts, and used one diagnostic slot; before reserving it, ${MAX_AGENT_REPLY_PARTS - 1} of ${MAX_AGENT_REPLY_PARTS} outcome slots were available to incoming parts.`,
    });
    expect(new Set(first.outcomes.map((part) => part.id)).size).toBe(first.outcomes.length);
    expect(second.outcomes).toEqual(first.outcomes);

    const invalidThread = store.createThread("agent-one");
    const invalidTurn = store.beginTurn({ threadId: invalidThread.id, text: "invalid", attachmentIds: [] });
    injectExisting(invalidTurn.assistantMessageId);
    const invalidDetail = store.completeTurn(
      invalidTurn.turnId,
      "done",
      undefined,
      { id: "web-reply-parts-truncated-2", not: "an array" } as unknown as readonly AgentReplyPart[],
    );
    const invalidMessage = invalidDetail.messages.at(-1)!;
    const invalidOutcomes = invalidMessage.parts.filter((part) => "id" in part);
    expect(invalidOutcomes).toEqual([
      existing,
      {
        type: "failure",
        id: "web-reply-parts-truncated-3",
        code: "unsupported_destination",
        message: `The web console retained 1 existing rich reply parts, omitted 0 existing parts, and rejected an invalid incoming rich reply collection; ${MAX_AGENT_REPLY_PARTS - 1} of ${MAX_AGENT_REPLY_PARTS} outcome slots were available before this bounded diagnostic.`,
      },
    ]);

    const validCollisions = [
      {
        type: "failure",
        id: "web-reply-parts-truncated",
        code: "artifact_missing",
        message: "Collides with an existing outcome.",
      },
      {
        type: "failure",
        id: "duplicate-incoming",
        code: "artifact_missing",
        message: "First incoming outcome.",
      },
      {
        type: "failure",
        id: "duplicate-incoming",
        code: "artifact_missing",
        message: "Second incoming outcome.",
      },
    ] as const satisfies readonly AgentReplyPart[];
    const completeValidCollisionTurn = () => {
      const thread = store.createThread("agent-one");
      const turn = store.beginTurn({ threadId: thread.id, text: "valid collisions", attachmentIds: [] });
      injectExisting(turn.assistantMessageId);
      const detail = store.completeTurn(turn.turnId, "done", undefined, validCollisions);
      const message = detail.messages.at(-1)!;
      return {
        messageId: message.id,
        outcomes: message.parts.filter((part) => "id" in part),
      };
    };
    const firstValidCollisions = completeValidCollisionTurn();
    const secondValidCollisions = completeValidCollisionTurn();
    expect(firstValidCollisions.outcomes).toEqual([
      existing,
      {
        type: "failure",
        id: "invalid-rich-part",
        code: "unsupported_destination",
        message: "A rich reply part reused an existing identifier and could not be displayed.",
      },
      validCollisions[1],
      {
        type: "failure",
        id: "invalid-rich-part-2",
        code: "unsupported_destination",
        message: "A rich reply part reused an existing identifier and could not be displayed.",
      },
    ]);
    expect(new Set(firstValidCollisions.outcomes.map((part) => part.id)).size)
      .toBe(firstValidCollisions.outcomes.length);
    expect(secondValidCollisions.outcomes).toEqual(firstValidCollisions.outcomes);

    const sparse = new Array<AgentReplyPart>(5);
    sparse[1] = {
      type: "failure",
      id: "invalid-rich-part",
      code: "unknown_failure",
      message: "Invalid failure code.",
    } as unknown as AgentReplyPart;
    sparse[2] = {
      type: "failure",
      id: "invalid-rich-part-2",
      code: "artifact_missing",
      message: "Valid middle outcome.",
    };
    sparse[4] = {
      type: "failure",
      id: "invalid-rich-part",
      code: "artifact_missing",
      message: "Valid colliding suffix outcome.",
    };
    const completeSparseTurn = () => {
      const thread = store.createThread("agent-one");
      const turn = store.beginTurn({ threadId: thread.id, text: "sparse", attachmentIds: [] });
      injectExisting(turn.assistantMessageId);
      const detail = store.completeTurn(turn.turnId, "done", undefined, sparse);
      const message = detail.messages.at(-1)!;
      return {
        messageId: message.id,
        outcomes: message.parts.filter((part) => "id" in part),
      };
    };
    const firstSparse = completeSparseTurn();
    const secondSparse = completeSparseTurn();
    expect(firstSparse.outcomes.map((part) => part.id)).toEqual([
      "web-reply-parts-truncated",
      "invalid-rich-part-3",
      "invalid-rich-part-4",
      "invalid-rich-part-2",
      "invalid-rich-part-5",
      "invalid-rich-part",
    ]);
    expect(firstSparse.outcomes.slice(1).map((part) => part.type === "failure" ? part.code : part.type))
      .toEqual([
        "unsupported_destination",
        "unsupported_destination",
        "artifact_missing",
        "unsupported_destination",
        "artifact_missing",
      ]);
    expect(new Set(firstSparse.outcomes.map((part) => part.id)).size).toBe(firstSparse.outcomes.length);
    expect(secondSparse.outcomes).toEqual(firstSparse.outcomes);

    store.close();
    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getMessage(first.messageId)?.parts.filter((part) => "id" in part)).toEqual(first.outcomes);
    expect(reopened.getMessage(invalidMessage.id)?.parts.filter((part) => "id" in part)).toEqual(invalidOutcomes);
    expect(reopened.getMessage(firstValidCollisions.messageId)?.parts.filter((part) => "id" in part))
      .toEqual(firstValidCollisions.outcomes);
    expect(reopened.getMessage(firstSparse.messageId)?.parts.filter((part) => "id" in part))
      .toEqual(firstSparse.outcomes);
    reopened.close();
  });

  it("records deterministic diagnostics when full or legacy outcome state leaves no incoming slot", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const outcome = (id: string) => ({
      type: "failure" as const,
      id,
      code: "artifact_missing" as const,
      message: "Existing durable outcome.",
    });
    const inject = (messageId: string, parts: readonly ReturnType<typeof outcome>[]) => {
      const raw = new DatabaseSync(store.paths.database);
      raw.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run(JSON.stringify(parts), messageId);
      raw.close();
    };
    const complete = (
      existing: readonly ReturnType<typeof outcome>[],
      incoming: unknown,
      label: string,
    ) => {
      const thread = store.createThread("agent-one");
      const turn = store.beginTurn({ threadId: thread.id, text: label, attachmentIds: [] });
      inject(turn.assistantMessageId, existing);
      const detail = store.completeTurn(
        turn.turnId,
        "done",
        undefined,
        incoming as readonly AgentReplyPart[],
      );
      return detail.messages.at(-1)!.parts.filter(
        (part) => part.type === "attachment" || part.type === "mcp_app" || part.type === "failure",
      );
    };

    const full = Array.from({ length: MAX_AGENT_REPLY_PARTS }, (_, index) => outcome(`full-${index}`));
    const incoming = [outcome("incoming-0"), outcome("incoming-1")];
    const firstFull = complete(full, incoming, "full one");
    const secondFull = complete(full, incoming, "full two");
    expect(firstFull).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(firstFull.slice(0, -1)).toEqual(full.slice(0, -1));
    expect(firstFull.at(-1)).toEqual({
      type: "failure",
      id: "web-reply-parts-truncated",
      code: "reply_part_too_large",
      message: `The web console retained ${MAX_AGENT_REPLY_PARTS - 1} existing and 0 incoming rich reply parts, omitted 1 existing and 2 incoming parts, and used one diagnostic slot; before reserving it, 0 of ${MAX_AGENT_REPLY_PARTS} outcome slots were available to incoming parts.`,
    });
    expect(secondFull).toEqual(firstFull);

    const invalid = complete(full, {
      id: "attacker-controlled-id",
      detail: "/private/agent/result?token=must-not-leak",
    }, "full invalid");
    expect(invalid).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(invalid.slice(0, -1)).toEqual(full.slice(0, -1));
    expect(invalid.at(-1)).toEqual({
      type: "failure",
      id: "web-reply-parts-truncated",
      code: "unsupported_destination",
      message: `The web console retained ${MAX_AGENT_REPLY_PARTS - 1} existing rich reply parts, omitted 1 existing parts, and rejected an invalid incoming rich reply collection; 0 of ${MAX_AGENT_REPLY_PARTS} outcome slots were available before this bounded diagnostic.`,
    });
    expect(JSON.stringify(invalid)).not.toMatch(/private\/agent|must-not-leak|attacker-controlled-id/u);

    const legacy = Array.from(
      { length: MAX_AGENT_REPLY_PARTS + 3 },
      (_, index) => outcome(`legacy-${index}`),
    );
    const repaired = complete(legacy, [outcome("incoming-legacy")], "legacy over cap");
    expect(repaired).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(repaired.slice(0, -1)).toEqual(legacy.slice(0, MAX_AGENT_REPLY_PARTS - 1));
    expect(repaired.at(-1)).toEqual({
      type: "failure",
      id: "web-reply-parts-truncated",
      code: "reply_part_too_large",
      message: `The web console retained ${MAX_AGENT_REPLY_PARTS - 1} existing and 0 incoming rich reply parts, omitted 4 existing and 1 incoming parts, and used one diagnostic slot; before reserving it, 0 of ${MAX_AGENT_REPLY_PARTS} outcome slots were available to incoming parts.`,
    });
    store.close();
  });

  it("projects synthetic steering events as one completed Steered tool row", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "start", attachmentIds: [] });

    store.applyStreamFrames(turn.turnId, [
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: "live-input:follow-up-1",
          name: "↪️ Steered: “Use the API instead”",
          metadata: { liveInput: true, synthetic: true },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "live-input:follow-up-1",
          name: "↪️ Steered: “Use the API instead”",
          content: "Applied to current run",
          metadata: { liveInput: true, synthetic: true },
        },
      },
    ]);
    const detail = store.completeTurn(turn.turnId, "done");
    const tool = detail.messages.at(-1)?.parts.find((part) => part.type === "tool-call");

    expect(tool).toEqual({
      type: "tool-call",
      toolCallId: "live-input:follow-up-1",
      toolName: "↪️ Steered: “Use the API instead”",
      result: "Applied to current run",
      status: "complete",
    });
    store.close();
  });

  // An MCP tool's structuredContent is the only machine-readable record of its outcome:
  // `content` is the model-facing sentence. AskUser depends on this surviving the store —
  // the console reads interactionId/answered from the persisted part to re-render an
  // answered card after a reload, and without it every answered card degraded to
  // "Question unavailable".
  it("persists an MCP tool's structuredContent beside its text result", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.selectThread(thread.id);
    const turn = store.beginTurn({ threadId: thread.id, text: "ask me", attachmentIds: [] });

    const structuredContent = {
      ok: true,
      answered: true,
      interactionId: "ask-1-NH9j2kc1WkMl",
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    };
    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "tool_call_started", id: "t1", name: "AskUser", arguments: {} } },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "t1",
          name: "AskUser",
          content: "The user answered:\n- Delivery: Send",
          structuredContent,
        },
      },
    ]);
    const detail = store.completeTurn(turn.turnId, "done");
    const tool = detail.messages.at(-1)?.parts.find((part) => part.type === "tool-call");

    expect(tool).toMatchObject({
      type: "tool-call",
      toolCallId: "t1",
      toolName: "AskUser",
      result: "The user answered:\n- Delivery: Send",
      structuredResult: structuredContent,
      status: "complete",
    });
    store.close();
  });

  it("omits structuredResult when the tool returned no structured payload", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.selectThread(thread.id);
    const turn = store.beginTurn({ threadId: thread.id, text: "read it", attachmentIds: [] });

    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "tool_call_completed", id: "t1", name: "Read", content: "file body" } },
    ]);
    const detail = store.completeTurn(turn.turnId, "done");
    const tool = detail.messages.at(-1)?.parts.find((part) => part.type === "tool-call");

    expect(tool).toEqual({
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "file body",
      status: "complete",
    });
    store.close();
  });

  it("deletes only archived threads, removes attachment files, and sweeps crash orphans", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.selectThread(thread.id);
    await expect(store.deleteArchivedThread(thread.id)).rejects.toMatchObject({ code: "thread_not_archived" });

    const attachment = store.createUpload({
      name: "notes.txt",
      contentType: "text/plain",
      kind: "document",
      declaredSize: 5,
    });
    const attachmentPath = store.attachmentPath(attachment);
    await writeFile(attachmentPath, "hello", { mode: 0o600 });
    store.markUploadComplete(attachment.id, 5);
    const turn = store.beginTurn({ threadId: thread.id, text: "", attachmentIds: [attachment.id] });
    store.completeTurn(turn.turnId, "done");
    store.patchThread(thread.id, { archived: true });

    await expect(store.deleteArchivedThread(thread.id)).resolves.toEqual({ orphanedFiles: 0 });
    expect(store.getThread(thread.id)).toBeUndefined();
    expect(store.getStoredAttachment(attachment.id)).toBeUndefined();
    expect(store.currentThreadId()).toBeUndefined();
    await expect(lstat(attachmentPath)).rejects.toMatchObject({ code: "ENOENT" });

    const orphan = join(store.paths.uploads, "11111111-1111-4111-8111-111111111111.bin");
    await writeFile(orphan, "orphan", { mode: 0o600 });
    await expect(store.purgeUnreferencedAttachmentFiles()).resolves.toBe(1);
    await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("persists live follow-ups on the active turn and marks provider acknowledgement", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({
      threadId: thread.id,
      text: "Initial request",
      attachmentIds: [],
      model: "provider/default",
      effort: "high",
    });

    const reserved = store.reserveLiveInput(thread.id, "Use the second approach");
    expect(reserved).toMatchObject({
      offered: true,
      input: { status: "offered", text: "Use the second approach" },
      message: { turnId: turn.turnId, liveInputStatus: "pending" },
    });
    expect(store.markLiveInputApplied(reserved.input.id)).toMatchObject({
      id: reserved.message.id,
      liveInputStatus: "applied",
    });
    expect(store.queuedLiveInputThreadIds()).toEqual([]);
    store.completeTurn(turn.turnId, "Applied");

    const detail = store.getThreadDetail(thread.id);
    expect(detail?.messages.map((message) => [message.role, message.liveInputStatus])).toEqual([
      ["user", undefined],
      ["user", "applied"],
      ["assistant", undefined],
    ]);
    store.close();
  });

  it("promotes a queued follow-up into the next durable turn", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const reserved = store.reserveLiveInput(thread.id, "Run after the current work");
    expect(reserved).toMatchObject({ offered: false, message: { liveInputStatus: "queued" } });

    const promoted = store.promoteNextQueuedLiveInput(thread.id);
    expect(promoted).toMatchObject({ text: "Run after the current work", userMessageId: reserved.message.id });
    expect(store.getThreadDetail(thread.id)?.messages).toEqual([
      expect.objectContaining({
        id: reserved.message.id,
        role: "user",
        turnId: promoted?.turnId,
        parts: [{ type: "text", text: "Run after the current work" }],
      }),
      expect.objectContaining({ role: "assistant", status: "running" }),
    ]);
    if (promoted !== undefined) store.completeTurn(promoted.turnId, "Done");
    store.close();
  });

  it("recovers an unsettled live follow-up as queued after restart", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.beginTurn({ threadId: thread.id, text: "Still running", attachmentIds: [] });
    const live = store.reserveLiveInput(thread.id, "Do not lose this");
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThread(thread.id)?.runState.status).toBe("interrupted");
    expect(reopened.getThreadDetail(thread.id)?.messages.find((message) => message.id === live.message.id))
      .toMatchObject({ liveInputStatus: "queued", parts: [{ type: "text", text: "Do not lose this" }] });
    expect(reopened.queuedLiveInputThreadIds()).toEqual([thread.id]);
    reopened.close();
  });

  it("round-trips the canonical durable-history metadata on the same rendered tool record", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "run", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: "tool-history-1",
          name: "Bash",
          arguments: { command: "false" },
          history: {
            recordId: "sth1_start",
            sequence: 1,
            persistence: "persisted",
            originalBytes: 19,
            retainedBytes: 19,
            untrusted: true,
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "tool-history-1",
          name: "Bash",
          content: "exit 1",
          isError: true,
          history: {
            recordId: "sth1_result",
            sequence: 2,
            persistence: "persisted",
            terminalState: "exit_nonzero",
            artifactReferences: [{ id: "stha1_output", available: false }],
            untrusted: true,
          },
        },
      },
    ]);
    store.completeTurn(turn.turnId, "done");
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThreadDetail(thread.id)?.messages.at(-1)?.parts).toContainEqual({
      type: "tool-call",
      toolCallId: "tool-history-1",
      toolName: "Bash",
      args: { command: "false" },
      result: "exit 1",
      status: "failed",
      history: {
        recordId: "sth1_result",
        sequence: 2,
        persistence: "persisted",
        terminalState: "exit_nonzero",
        artifactReferences: [{ id: "stha1_output", available: false }],
        untrusted: true,
      },
    });
    reopened.close();
  });

  it("canonicalizes or drops adversarial started/completed history before reopen", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "run", attachmentIds: [] });
    const oversizedRecordId = "x".repeat(4_097);
    store.applyStreamFrames(turn.turnId, [
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: "stale-after-complete",
          name: "Bash",
          history: {
            recordId: "sth1_valid_start",
            sequence: 1,
            persistence: "persisted",
            untrusted: true,
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "stale-after-complete",
          name: "Bash",
          content: "done",
          history: {
            persistence: "persisted",
            terminalState: "future-terminal-state",
            untrusted: true,
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: "bad-start",
          name: "Read",
          history: { recordId: oversizedRecordId, persistence: "persisted", untrusted: true },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "bad-complete",
          name: "Write",
          content: "done",
          history: {
            persistence: "persisted",
            artifactReferences: [{ id: "artifact\ncontrol", available: true }],
            untrusted: true,
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "canonical-complete",
          name: "Search",
          content: "done",
          history: {
            recordId: "sth1_canonical",
            sequence: 9,
            persistence: "persisted",
            terminalState: "success",
            artifactReferences: [{ id: "stha1_output", available: true, staleLocation: "/private/tmp/out" }],
            untrusted: true,
            staleProducerField: "must not persist",
          },
        },
      },
    ] as never);
    store.completeTurn(turn.turnId, "done");
    const databasePath = store.paths.database;
    store.close();

    const inspected = new DatabaseSync(databasePath);
    const stored = inspected.prepare("SELECT parts_json FROM messages WHERE id = ?")
      .get(turn.assistantMessageId) as unknown as { parts_json: string };
    inspected.close();
    expect(stored.parts_json).not.toContain("future-terminal-state");
    expect(stored.parts_json).not.toContain("staleProducerField");
    expect(stored.parts_json).not.toContain("staleLocation");
    expect(stored.parts_json).not.toContain(oversizedRecordId);

    const reopened = await WebStore.open({ stateDir });
    const calls = reopened.getThreadDetail(thread.id)?.messages.at(-1)?.parts
      .filter((part) => part.type === "tool-call") ?? [];
    expect(calls.find((part) => part.toolCallId === "stale-after-complete")).not.toHaveProperty("history");
    expect(calls.find((part) => part.toolCallId === "bad-start")).not.toHaveProperty("history");
    expect(calls.find((part) => part.toolCallId === "bad-complete")).not.toHaveProperty("history");
    expect(calls.find((part) => part.toolCallId === "canonical-complete")).toMatchObject({
      history: {
        recordId: "sth1_canonical",
        sequence: 9,
        persistence: "persisted",
        terminalState: "success",
        artifactReferences: [{ id: "stha1_output", available: true }],
        untrusted: true,
      },
    });
    reopened.close();
  });

  it("persists quote metadata without exposing its storage telemetry as message content", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const otherThread = store.createThread("agent-one");
    const first = store.beginTurn({ threadId: thread.id, text: "Source prompt", attachmentIds: [] });
    store.completeTurn(first.turnId, "A source response");
    const other = store.beginTurn({ threadId: otherThread.id, text: "Other", attachmentIds: [] });
    store.completeTurn(other.turnId, "Other response");

    const quoted = store.beginTurn({
      threadId: thread.id,
      text: "Please expand on this.",
      attachmentIds: [],
      quote: { text: "source response", messageId: first.assistantMessageId },
    });
    const userMessage = store.getThreadDetail(thread.id)?.messages.at(-2);
    expect(quoted.quote).toEqual({
      text: "source response",
      messageId: first.assistantMessageId,
    });
    expect(userMessage).toMatchObject({
      quote: { text: "source response", messageId: first.assistantMessageId },
      parts: [{ type: "text", text: "Please expand on this." }],
    });
    expect(() => store.beginTurn({
      threadId: otherThread.id,
      text: "Cross-thread quote",
      attachmentIds: [],
      quote: { text: "source response", messageId: first.assistantMessageId },
    })).toThrowError(expect.objectContaining({ code: "invalid_quote" }));
    store.interruptTurn(quoted.turnId);
    store.close();

    const reopened = await WebStore.open({ stateDir: join(base, "state") });
    expect(reopened.getThreadDetail(thread.id)?.messages.at(-2)).toMatchObject({
      quote: { text: "source response", messageId: first.assistantMessageId },
      parts: [{ type: "text", text: "Please expand on this." }],
    });
    reopened.close();
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

  it("maps warnings/failover/usage and persists runtime telemetry payloads", async () => {
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
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_usage",
          data: { contextWindow: 372_000, tokens: { total: 12_345 } },
        },
      },
    ]);
    const detail = store.completeTurn(turn.turnId, "");
    expect(detail.thread.runState).toMatchObject({ model: "actual", effort: "xhigh" });
    expect(detail.messages.at(-1)?.parts.map((part) => part.type === "telemetry" ? part.event : part.type)).toEqual([
      "runtime_warning", "provider_status", "usage_update", "runtime_telemetry", "runtime_telemetry",
    ]);
    expect(detail.messages.at(-1)?.parts.at(-1)).toEqual({
      type: "telemetry",
      event: "runtime_telemetry",
      data: {
        type: "runtime_telemetry",
        kind: "context_usage",
        data: { contextWindow: 372_000, tokens: { total: 12_345 } },
      },
    });
    store.close();
  });

  it("updates a compaction lifecycle in place while keeping distinct operations", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "compact", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: { operationId: "compact-1", status: "running", sdk: "pi", trigger: "proactive" },
        },
      },
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: {
            operationId: "compact-1",
            status: "succeeded",
            sdk: "pi",
            trigger: "proactive",
            tokensBefore: 80_000,
            tokensAfter: 20_000,
            tokenCountsExact: false,
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: { operationId: "compact-2", status: "skipped", sdk: "pi", trigger: "manual" },
        },
      },
    ]);

    const assistant = store.getThreadDetail(thread.id)?.messages.at(-1);
    expect(assistant?.parts).toEqual([
      {
        type: "telemetry",
        event: "runtime_telemetry",
        data: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: {
            operationId: "compact-1",
            status: "succeeded",
            sdk: "pi",
            trigger: "proactive",
            tokensBefore: 80_000,
            tokensAfter: 20_000,
            tokenCountsExact: false,
          },
        },
      },
      {
        type: "telemetry",
        event: "runtime_telemetry",
        data: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: { operationId: "compact-2", status: "skipped", sdk: "pi", trigger: "manual" },
        },
      },
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

  it("keeps prose in one part when invisible telemetry lands between two deltas", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "help", attachmentIds: [] });
    // Deltas do not respect word boundaries, so a part started behind a status
    // frame or an unmapped event renders as a sentence broken in half.
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "I'm re" },
      { kind: "status", text: "Thinking" },
      { kind: "event", event: { type: "usage_update", cumulativeUsd: 0.01 } },
      { kind: "append", delta: "ally sorry" },
    ]);
    const detail = store.completeTurn(turn.turnId, "");
    const assistant = detail.messages.at(-1);

    expect(assistant?.parts.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "I'm really sorry" },
    ]);
    // The telemetry itself still has to survive; the context display reads it.
    expect(assistant?.parts.some((part) => part.type === "telemetry" && part.event === "status")).toBe(true);
    store.close();
  });

  it("still separates the text either side of a rendered part", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "check", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "Let me check. " },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: { q: "x" } } },
      { kind: "append", delta: "You have 12 tasks." },
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: { operationId: "compact-1", status: "succeeded", sdk: "pi", trigger: "proactive" },
        },
      },
      { kind: "append", delta: "Anything else?" },
    ]);
    const detail = store.completeTurn(turn.turnId, "");
    const assistant = detail.messages.at(-1);

    expect(assistant?.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "telemetry",
      "text",
    ]);
    store.close();
  });

  it("leaves narration between tool calls alone when the answer is reconciled", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "clean up", attachmentIds: [] });
    // `finalText` is only the LAST assistant message's text, while every block the
    // model wrote — narration included — was streamed as a delta. Reconciling by
    // character length therefore re-sliced the answer across the narration slots:
    // each slot kept its length and received a contiguous piece of the answer,
    // frequently cut mid-word, and the narration itself was overwritten.
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "I'll load the journal." },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "ReadSkill", arguments: {} } },
      { kind: "append", delta: "Batch 1 committed." },
      { kind: "event", event: { type: "tool_call_started", id: "tool-2", name: "Bash", arguments: {} } },
      { kind: "append", delta: "Both done. Every entry now carries its real date." },
    ]);
    const detail = store.completeTurn(turn.turnId, "Both done. Every entry now carries its real date.");
    const assistant = detail.messages.at(-1);

    expect(assistant?.parts.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "I'll load the journal." },
      { type: "text", text: "Batch 1 committed." },
      { type: "text", text: "Both done. Every entry now carries its real date." },
    ]);
    expect(assistant?.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "tool-call",
      "text",
    ]);
    store.close();
  });

  it("appends only the text the runtime added after the stream closed", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "check", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "Working." },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: {} } },
      { kind: "append", delta: " Done." },
    ]);
    // The harness appends the failover attribution after the stream has closed,
    // so it reaches the store only on the finish frame.
    const detail = store.completeTurn(
      turn.turnId,
      "Working. Done.\n\n⚠️ Answered by fallback/model, not the configured primary/model.",
    );

    expect(detail.messages.at(-1)?.parts.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "Working." },
      { type: "text", text: " Done.\n\n⚠️ Answered by fallback/model, not the configured primary/model." },
    ]);
    store.close();
  });

  it("collapses the prose a reasoning block split back into one answer", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "check", attachmentIds: [] });
    // One assistant message can carry `thinking, text, thinking, text`, and the
    // provider reports every text block of it as the same answer.
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "Looking." },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: {} } },
      { kind: "append", delta: "First half. " },
      { kind: "event", event: { type: "assistant_thought", text: "hmm" } },
      { kind: "append", delta: "Second half." },
    ]);
    const detail = store.completeTurn(turn.turnId, "First half. Second half.");

    expect(detail.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "Looking." },
      { type: "tool-call", toolCallId: "tool-1", toolName: "Search", args: {}, status: "running" },
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "First half. Second half." },
    ]);
    store.close();
  });

  it("replaces only the last text part when the final answer diverges from everything streamed", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "check", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "Draft one." },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: {} } },
      { kind: "append", delta: "Draft two." },
    ]);
    const detail = store.completeTurn(turn.turnId, "Completely different answer.");

    // Never a new part: the webapp joins adjacent text before folding, so one
    // pushed here would render glued to the prose in front of it.
    expect(detail.messages.at(-1)?.parts.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "Draft one." },
      { type: "text", text: "Completely different answer." },
    ]);
    store.close();
  });

  it("keeps the whole stream when the final text repeats it", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "check", attachmentIds: [] });
    // The runtime falls back to the whole run's concatenation when the last
    // assistant message carried no text of its own.
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "a" },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: {} } },
      { kind: "append", delta: "b" },
    ]);
    const detail = store.completeTurn(turn.turnId, "ab");

    expect(detail.messages.at(-1)?.parts.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    store.close();
  });

  it("records the answer as its own part when the turn streamed no prose", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "check", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: {} } },
    ]);
    const detail = store.completeTurn(turn.turnId, "Answer");

    expect(detail.messages.at(-1)?.parts).toEqual([
      { type: "tool-call", toolCallId: "tool-1", toolName: "Search", args: {}, status: "running" },
      { type: "text", text: "Answer" },
    ]);
    store.close();
  });

  it("exposes a marked assistant-only notification only after durable-history completion", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const selected = store.createThread("agent-one");
    const reservation = store.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: "cron:daily:2026-07-21T09:00:00.000Z:success",
      text: "Morning brief",
    });
    expect(reservation.threadId).toBeDefined();
    const notificationThreadId = reservation.threadId!;

    expect(store.getThread(notificationThreadId)).toBeUndefined();
    expect(store.currentThreadId()).toBe(selected.id);
    const completed = store.completeNotification(reservation);
    expect(completed).toMatchObject({
      duplicate: false,
      thread: {
        id: notificationThreadId,
        title: "Cron notification",
        trigger: { kind: "cron" },
        messageCount: 1,
        runState: { status: "complete" },
      },
    });
    expect(store.getThreadDetail(notificationThreadId)?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        status: "complete",
        parts: [{ type: "text", text: "Morning brief" }],
      }),
    ]);
    expect(store.currentThreadId()).toBe(selected.id);
    expect(store.completeNotification(reservation)).toMatchObject({ duplicate: true });
    expect(() => store.reserveNotification({
      ...reservation,
      text: "Conflicting brief",
    })).toThrowError(expect.objectContaining({ code: "notification_idempotency_conflict" }));
    store.close();

    const reopened = await WebStore.open({ stateDir });
    reopened.replaceAgents([agent()]);
    const duplicate = reopened.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: reservation.deliveryKey,
      text: "Morning brief",
    });
    expect(duplicate.duplicate).toBe(true);
    expect(reopened.completeNotification(duplicate)).toMatchObject({ duplicate: true });
    reopened.close();
  });

  it("retains one evolving process-job card without synthesizing a web turn", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const running = fakeProcessJob({ conversationId: `web:${thread.id}` });

    expect(store.upsertProcessJobCard({
      sourceId: "agent-one",
      threadId: thread.id,
      deliveryKey: running.wake.deliveryKey,
      processJob: running,
    })).toMatchObject({ duplicate: false, thread: { messageCount: 1 } });
    const runningDetail = store.getThreadDetail(thread.id);
    expect(runningDetail?.thread.runState).toEqual({ status: "idle" });
    expect(runningDetail?.messages).toHaveLength(1);
    expect(runningDetail?.messages[0]).toMatchObject({
      role: "assistant",
      status: "running",
      parts: [{ type: "process-job", job: { state: "running" } }],
    });

    const terminal = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      state: "succeeded",
    });
    const replyParts = [
      {
        type: "attachment",
        id: "job-attachment",
        reference: { scheme: "mono-agent-artifact", id: "job-artifact" },
        name: "report.txt",
        mediaType: "text/plain",
        sizeBytes: 12,
        integrityId: `sha256:${"a".repeat(64)}`,
      },
      {
        type: "mcp_app",
        id: "11111111-1111-4111-8111-111111111111",
        invocationId: "11111111-1111-4111-8111-111111111111",
        connectionId: "job-connection",
        serverName: "widgets",
        toolName: "show_chart",
        resourceUri: "ui://widgets/chart",
        mediaType: "text/html;profile=mcp-app",
        protocolVersion: "2026-01-26",
        title: "Job chart",
      },
      {
        type: "failure",
        id: "job-failure",
        code: "artifact_missing",
        message: "One optional artifact expired.",
      },
    ] as const satisfies readonly AgentReplyPart[];
    expect(store.upsertProcessJobCard({
      sourceId: "agent-one",
      threadId: thread.id,
      deliveryKey: terminal.wake.deliveryKey,
      processJob: terminal,
      responseText: "The worker completed safely.",
      replyParts,
    })).toMatchObject({ duplicate: false, thread: { messageCount: 1 } });
    const terminalDetail = store.getThreadDetail(thread.id);
    expect(terminalDetail?.messages).toHaveLength(1);
    expect(terminalDetail?.messages[0]).toMatchObject({
      id: runningDetail?.messages[0]?.id,
      status: "complete",
      parts: [
        {
          type: "process-job",
          job: { state: "succeeded", wake: { state: "pending" } },
          responseText: "The worker completed safely.",
        },
        { type: "attachment", id: "job-attachment", artifactId: "job-artifact", name: "report.txt" },
        { type: "mcp_app", id: "11111111-1111-4111-8111-111111111111", connectionId: "job-connection" },
        replyParts[2],
      ],
    });
    expect(store.upsertProcessJobCard({
      sourceId: "agent-one",
      threadId: thread.id,
      deliveryKey: terminal.wake.deliveryKey,
      processJob: terminal,
      responseText: "The worker completed safely.",
      replyParts,
    })).toMatchObject({ duplicate: true });
    expect(() => store.upsertProcessJobCard({
      sourceId: "agent-one",
      threadId: thread.id,
      deliveryKey: terminal.wake.deliveryKey,
      processJob: terminal,
      responseText: "The worker completed safely.",
      replyParts: [{ ...replyParts[2], message: "A conflicting second outcome." }],
    })).toThrowError(expect.objectContaining({ code: "notification_idempotency_conflict" }));
    expect(() => store.upsertProcessJobCard({
      sourceId: "agent-one",
      threadId: thread.id,
      deliveryKey: terminal.wake.deliveryKey,
      processJob: terminal,
      responseText: "A conflicting second answer.",
      replyParts,
    })).toThrowError(expect.objectContaining({ code: "notification_idempotency_conflict" }));

    const settled = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      state: "succeeded",
      wakeState: "delivered",
    });
    expect(store.upsertProcessJobCard({
      sourceId: "agent-one",
      threadId: thread.id,
      deliveryKey: settled.wake.deliveryKey,
      processJob: settled,
    })).toMatchObject({ duplicate: false });
    const settledParts = store.getThreadDetail(thread.id)?.messages[0]?.parts;
    expect(settledParts).toMatchObject([
      { type: "process-job", job: { wake: { state: "delivered" } }, responseText: "The worker completed safely." },
      { type: "attachment", id: "job-attachment", artifactId: "job-artifact" },
      { type: "mcp_app", id: "11111111-1111-4111-8111-111111111111" },
      replyParts[2],
    ]);
    expect(() => store.upsertProcessJobCard({
      sourceId: "agent-one",
      threadId: thread.id,
      deliveryKey: running.wake.deliveryKey,
      processJob: running,
    })).toThrowError(expect.objectContaining({ code: "notification_idempotency_conflict" }));

    const raw = new DatabaseSync(store.paths.database);
    const row = raw.prepare("SELECT parts_json FROM messages WHERE id = ?")
      .get(runningDetail!.messages[0]!.id) as unknown as { parts_json: string };
    raw.close();
    expect(row.parts_json).not.toMatch(/mono-agent-artifact|contentUrl|resourceUrl|bridgeUrl|token/u);
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThreadDetail(thread.id)?.messages[0]?.parts).toEqual(settledParts);
    reopened.close();
  });

  it("creates an assistant-only wake turn without a fake user row", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");

    const started = store.beginAssistantTurn({ threadId: thread.id, prompt: "Process the worker result" });
    expect(started.text).toBe("Process the worker result");
    expect(store.getThreadDetail(thread.id)?.messages).toEqual([
      expect.objectContaining({
        id: started.assistantMessageId,
        role: "assistant",
        status: "running",
        parts: [],
      }),
    ]);
    expect(store.getThreadDetail(thread.id)?.messages.some((message) => message.role === "user")).toBe(false);
    store.close();
  });

  it("can keep an assistant-only Monitor prompt out of durable web state", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const secretPrompt = "monitor output contains credential-shape-value";

    const started = store.beginAssistantTurn({
      threadId: thread.id,
      prompt: secretPrompt,
      storedPrompt: "[Monitor wake]",
    });
    expect(started.text).toBe(secretPrompt);
    const raw = new DatabaseSync(store.paths.database, { readOnly: true });
    const row = raw.prepare("SELECT text FROM turns WHERE id = ?").get(started.turnId) as { text: string };
    raw.close();
    expect(row.text).toBe("[Monitor wake]");
    expect(row.text).not.toContain("credential-shape-value");
    store.close();
  });

  it("persists completed and ambiguous Monitor wake claims without raw event text", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent(), agent("agent-two")]);
    const thread = store.createThread("agent-one");
    const otherThread = store.createThread("agent-two");
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}`, seq: 3 });
    const deliveryKey = `monitor:${monitor.monitorId}:3`;

    expect(store.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: thread.id,
      monitorId: monitor.monitorId,
      deliveryKey,
      payloadSha256: "a".repeat(64),
    })).toEqual({ kind: "new" });
    store.completeMonitorWake({
      sourceId: "agent-one",
      monitorId: monitor.monitorId,
      deliveryKey,
      disposition: "steered",
    });
    expect(store.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: thread.id,
      monitorId: monitor.monitorId,
      deliveryKey,
      payloadSha256: "a".repeat(64),
    })).toEqual({ kind: "completed", disposition: "steered" });
    expect(() => store.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: thread.id,
      monitorId: monitor.monitorId,
      deliveryKey,
      payloadSha256: "b".repeat(64),
    })).toThrowError(expect.objectContaining({ code: "notification_idempotency_conflict" }));
    expect(() => store.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: otherThread.id,
      monitorId: "other-monitor",
      deliveryKey: "monitor:other-monitor:1",
      payloadSha256: "c".repeat(64),
    })).toThrowError(expect.objectContaining({ code: "invalid_notification" }));

    const pendingKey = `monitor:${monitor.monitorId}:4`;
    expect(store.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: thread.id,
      monitorId: monitor.monitorId,
      deliveryKey: pendingKey,
      payloadSha256: "d".repeat(64),
    })).toEqual({ kind: "new" });
    const raw = new DatabaseSync(store.paths.database, { readOnly: true });
    const rows = raw.prepare("SELECT * FROM monitor_wake_deliveries ORDER BY delivery_key").all();
    raw.close();
    expect(JSON.stringify(rows)).not.toContain("credential-shape-value");
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: thread.id,
      monitorId: monitor.monitorId,
      deliveryKey: pendingKey,
      payloadSha256: "d".repeat(64),
    })).toEqual({ kind: "uncertain" });
    reopened.close();
  });

  it("retains Monitor delivery tombstones after their conversation is deleted", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}`, seq: 7 });
    const deliveryKey = `monitor:${monitor.monitorId}:7`;
    const payloadSha256 = "e".repeat(64);

    expect(store.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: thread.id,
      monitorId: monitor.monitorId,
      deliveryKey,
      payloadSha256,
    })).toEqual({ kind: "new" });
    store.completeMonitorWake({
      sourceId: "agent-one",
      monitorId: monitor.monitorId,
      deliveryKey,
      disposition: "follow_up",
    });
    store.patchThread(thread.id, { archived: true });
    await store.deleteArchivedThread(thread.id);

    const raw = new DatabaseSync(store.paths.database, { readOnly: true });
    const retained = raw.prepare(`
      SELECT thread_id, state, disposition
      FROM monitor_wake_deliveries WHERE source_id = ? AND delivery_key = ?
    `).get("agent-one", deliveryKey);
    raw.close();
    expect(retained).toEqual({ thread_id: null, state: "completed", disposition: "follow_up" });

    const replacement = store.createThread("agent-one");
    expect(() => store.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: replacement.id,
      monitorId: monitor.monitorId,
      deliveryKey,
      payloadSha256,
    })).toThrowError(expect.objectContaining({ code: "notification_idempotency_conflict" }));
    store.close();
  });

  it("persists completed and ambiguous process-job wake claims across reopen", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const completed = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      jobId: "11111111-1111-4111-8111-111111111111",
    });
    const uncertain = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      jobId: "22222222-2222-4222-8222-222222222222",
    });
    for (const processJob of [completed, uncertain]) {
      store.upsertProcessJobCard({
        sourceId: "agent-one",
        threadId: thread.id,
        deliveryKey: processJob.wake.deliveryKey,
        processJob,
      });
      expect(store.reserveProcessJobWake({
        sourceId: "agent-one",
        threadId: thread.id,
        jobId: processJob.jobId,
        deliveryKey: processJob.wake.deliveryKey,
      })).toEqual({ kind: "new" });
    }
    store.completeProcessJobWake({
      sourceId: "agent-one",
      jobId: completed.jobId,
      deliveryKey: completed.wake.deliveryKey,
      disposition: "follow_up",
    });
    store.close();

    const reopened = await WebStore.open({ stateDir });
    reopened.replaceAgents([agent()]);
    expect(reopened.reserveProcessJobWake({
      sourceId: "agent-one",
      threadId: thread.id,
      jobId: completed.jobId,
      deliveryKey: completed.wake.deliveryKey,
    })).toEqual({ kind: "completed", disposition: "follow_up" });
    expect(reopened.reserveProcessJobWake({
      sourceId: "agent-one",
      threadId: thread.id,
      jobId: uncertain.jobId,
      deliveryKey: uncertain.wake.deliveryKey,
    })).toEqual({ kind: "uncertain" });
    reopened.abandonProcessJobWake({
      sourceId: "agent-one",
      jobId: uncertain.jobId,
      deliveryKey: uncertain.wake.deliveryKey,
    });
    expect(reopened.reserveProcessJobWake({
      sourceId: "agent-one",
      threadId: thread.id,
      jobId: uncertain.jobId,
      deliveryKey: uncertain.wake.deliveryKey,
    })).toEqual({ kind: "new" });
    reopened.close();
  });

  it("migrates a seeded schema v10 database to v14 keeping its thread rows", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const seeded = await WebStore.open({ stateDir });
    seeded.replaceAgents([agent()]);
    const thread = seeded.createThread("agent-one");
    seeded.patchThread(thread.id, { title: "kept title" });
    const databasePath = seeded.paths.database;
    seeded.close();

    // Wind the file back to schema 10 by removing the v11 columns, so the
    // guarded ALTER has to re-add them while the seeded row stays untouched.
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE threads DROP COLUMN run_model;
      ALTER TABLE threads DROP COLUMN run_effort;
      PRAGMA user_version = 10;
    `);
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    const threads = migrated.listThreads().filter((entry) => entry.sourceId === "agent-one");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ title: "kept title", runModel: null, runEffort: null });
    migrated.close();

    const inspected = new DatabaseSync(databasePath);
    const version = inspected.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    const columns = inspected.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{ name: string }>;
    // v12 adds the agent provider summary. `agentSelectSql` uses `a.*`, so the
    // column is readable the moment it exists -- but only if the ALTER ran.
    const agentColumns = new Set((inspected.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    inspected.close();
    expect(version.user_version).toBe(14);
    expect(agentColumns.has("providers_json")).toBe(true);
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["run_model", "run_effort"]));
  });

  it("re-runs the v11-v14 migrations without failing when current columns and tables already exist", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const seeded = await WebStore.open({ stateDir });
    seeded.replaceAgents([agent()]);
    const thread = seeded.createThread("agent-one");
    const databasePath = seeded.paths.database;
    seeded.close();

    // Columns already exist at the current schema; winding back only the
    // version stamp forces initialize() to replay the < 11 block against them.
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA user_version = 10");
    legacy.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThread(thread.id)).toMatchObject({ id: thread.id, runModel: null, runEffort: null });
    reopened.close();
    expect(
      new DatabaseSync(databasePath, { readOnly: true }).prepare("PRAGMA user_version").get(),
    ).toMatchObject({ user_version: 14 });
  });

  it("migrates schema v12 by creating the Monitor wake ledger", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    const databasePath = initial.paths.database;
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE monitor_wake_deliveries; PRAGMA user_version = 12");
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    migrated.close();
    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 14 });
    expect(inspected.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monitor_wake_deliveries'",
    ).get()).toBeDefined();
    inspected.close();
  });

  it("migrates schema v13 Monitor receipts from cascading deletion to retained tombstones", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const seeded = await WebStore.open({ stateDir });
    seeded.replaceAgents([agent()]);
    const thread = seeded.createThread("agent-one");
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}`, seq: 9 });
    const deliveryKey = `monitor:${monitor.monitorId}:9`;
    expect(seeded.reserveMonitorWake({
      sourceId: "agent-one",
      threadId: thread.id,
      monitorId: monitor.monitorId,
      deliveryKey,
      payloadSha256: "f".repeat(64),
    })).toEqual({ kind: "new" });
    seeded.completeMonitorWake({
      sourceId: "agent-one",
      monitorId: monitor.monitorId,
      deliveryKey,
      disposition: "steered",
    });
    seeded.close();

    const databasePath = join(stateDir, "state.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE monitor_wake_deliveries RENAME TO monitor_wake_deliveries_v14_source;
      CREATE TABLE monitor_wake_deliveries (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        monitor_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        payload_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'completed')),
        disposition TEXT CHECK (disposition IN ('steered', 'follow_up')),
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (source_id, delivery_key)
      );
      INSERT INTO monitor_wake_deliveries
      SELECT * FROM monitor_wake_deliveries_v14_source;
      DROP TABLE monitor_wake_deliveries_v14_source;
      PRAGMA user_version = 13;
    `);
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 14 });
    const threadForeignKey = (inspected.prepare("PRAGMA foreign_key_list(monitor_wake_deliveries)").all() as Array<{
      from: string;
      on_delete: string;
    }>).find((foreignKey) => foreignKey.from === "thread_id");
    expect(threadForeignKey?.on_delete).toBe("SET NULL");
    inspected.close();

    migrated.patchThread(thread.id, { archived: true });
    await migrated.deleteArchivedThread(thread.id);
    const retained = new DatabaseSync(databasePath, { readOnly: true });
    expect(retained.prepare(`
      SELECT thread_id, state, disposition
      FROM monitor_wake_deliveries WHERE source_id = ? AND delivery_key = ?
    `).get("agent-one", deliveryKey)).toEqual({
      thread_id: null,
      state: "completed",
      disposition: "steered",
    });
    retained.close();
    migrated.close();
  });

  it("sets, merges, and clears per-thread model and effort overrides", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state"), clock: () => new Date(0) });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");

    const withModel = store.patchThread(thread.id, { model: "anthropic:claude-sonnet-5" });
    expect(withModel).toMatchObject({ runModel: "anthropic:claude-sonnet-5", runEffort: null });

    const withEffort = store.patchThread(thread.id, { effort: "high" });
    expect(withEffort).toMatchObject({ runModel: "anthropic:claude-sonnet-5", runEffort: "high" });

    const clearedModel = store.patchThread(thread.id, { model: null });
    expect(clearedModel).toMatchObject({ runModel: null, runEffort: "high" });

    const clearedEffort = store.patchThread(thread.id, { effort: null });
    expect(clearedEffort).toMatchObject({ runModel: null, runEffort: null });
  });

  it("keeps updated_at stable and records run_config_changed for a model-only patch", async () => {
    let clockMs = 3_000_000;
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state"), clock: () => new Date(clockMs) });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const createdAt = store.getThread(thread.id)!.updatedAt;

    clockMs += 60_000;
    const patched = store.patchThread(thread.id, { model: "anthropic:claude-sonnet-5" });
    expect(patched.updatedAt).toBe(createdAt);
    expect(patched.revision).toBe(2);
    const cleared = store.patchThread(thread.id, { effort: null });
    expect(cleared.updatedAt).toBe(createdAt);

    const database = new DatabaseSync(store.paths.database, { readOnly: true });
    const lastEvent = database.prepare(`
      SELECT event FROM revisions
      WHERE entity_kind = 'thread' AND entity_id = ?
      ORDER BY revision DESC, id DESC LIMIT 1
    `).get(thread.id) as unknown as { event: string };
    database.close();
    expect(lastEvent.event).toBe("run_config_changed");
  });

  it("keeps updated_at advancing for title/archive patches and emits title_changed then archived", async () => {
    let clockMs = 4_000_000;
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state"), clock: () => new Date(clockMs) });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const createdAt = store.getThread(thread.id)!.updatedAt;

    clockMs += 60_000;
    const renamed = store.patchThread(thread.id, { title: "renamed" });
    expect(renamed.updatedAt).not.toBe(createdAt);
    clockMs += 60_000;
    const archived = store.patchThread(thread.id, { archived: true });
    expect(archived.updatedAt).not.toBe(renamed.updatedAt);
    expect(archived.archivedAt).not.toBeNull();

    const database = new DatabaseSync(store.paths.database, { readOnly: true });
    const events = (database.prepare(`
      SELECT event FROM revisions
      WHERE entity_kind = 'thread' AND entity_id = ?
      ORDER BY revision
    `).all(thread.id) as unknown as Array<{ event: string }>).map((entry) => entry.event);
    database.close();
    expect(events.filter((event) => event !== "created")).toEqual(["title_changed", "archived"]);
  });

  it("migrates schema v1 state through notification, live-input, and search storage", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    const databasePath = initial.paths.database;
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE live_inputs;
      DROP TABLE notification_deliveries;
      DROP TABLE process_job_cards;
      ALTER TABLE threads DROP COLUMN trigger_kind;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    migrated.close();
    const inspected = new DatabaseSync(databasePath);
    const version = inspected.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    const columns = inspected.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{ name: string }>;
    const ledger = inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_deliveries'").get();
    const liveInputs = inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_inputs'").get();
    const processJobCards = inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'process_job_cards'").get();
    inspected.close();
    expect(version.user_version).toBe(14);
    expect(columns.map((column) => column.name)).toContain("trigger_kind");
    expect(ledger).toBeDefined();
    expect(liveInputs).toBeDefined();
    expect(processJobCards).toBeDefined();
  });

  it("migrates schema v6 state through v9 process-job wake delivery and search", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    const databasePath = initial.paths.database;
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE process_job_cards; PRAGMA user_version = 6");
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    migrated.close();
    const inspected = new DatabaseSync(databasePath);
    const version = inspected.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    const processJobCards = inspected.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'process_job_cards'",
    ).get();
    inspected.close();
    expect(version.user_version).toBe(14);
    expect(processJobCards).toBeDefined();
  });

  it("rejects a future schema without retaining the failed database handle", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    const databasePath = initial.paths.database;
    initial.close();

    const future = new DatabaseSync(databasePath);
    future.exec("PRAGMA user_version = 15");
    future.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "unsupported_storage_schema" });

    const restored = new DatabaseSync(databasePath);
    restored.exec("PRAGMA user_version = 3");
    restored.close();
    const reopened = await WebStore.open({ stateDir });
    reopened.close();
  });

  it("salvages legacy messages whose optional history metadata is malformed", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    initial.replaceAgents([agent()]);
    const thread = initial.createThread("agent-one");
    const turn = initial.beginTurn({ threadId: thread.id, text: "persist", attachmentIds: [] });
    initial.completeTurn(turn.turnId, "answer");
    const databasePath = initial.paths.database;
    initial.close();

    const legacyParts = [
      { type: "text", text: "before" },
      {
        type: "tool-call",
        toolCallId: "legacy-tool",
        toolName: "Read",
        status: "complete",
        history: { persistence: "persisted", sequence: 0, untrusted: true },
      },
      {
        type: "subagent",
        toolCallId: "legacy-agent",
        name: "researcher",
        status: "complete",
        history: null,
        calls: [{
          toolCallId: "legacy-child",
          toolName: "Search",
          status: "complete",
          history: { persistence: "persisted", errorCode: "bad\ncode", untrusted: true },
        }],
      },
      { type: "text", text: "after" },
    ];
    const legacy = new DatabaseSync(databasePath);
    legacy.prepare("UPDATE messages SET parts_json = ? WHERE id = ?")
      .run(JSON.stringify(legacyParts), turn.assistantMessageId);
    legacy.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThreadDetail(thread.id)?.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "before" },
      {
        type: "tool-call",
        toolCallId: "legacy-tool",
        toolName: "Read",
        status: "complete",
      },
      {
        type: "subagent",
        toolCallId: "legacy-agent",
        name: "researcher",
        status: "complete",
        calls: [{ toolCallId: "legacy-child", toolName: "Search", status: "complete" }],
      },
      { type: "text", text: "after" },
    ]);
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

describe("WebStore subagent parts", () => {
  const subagent = (id: string, name: string, label?: string) => ({
    subagent: { id, name, callIndex: 0, ...(label === undefined ? {} : { label }) },
    synthetic: true,
  });
  const launch = (id: string, name: string) => ({
    kind: "event" as const,
    event: {
      type: "tool_call_started" as const,
      id,
      name: "Agent",
      arguments: { name, prompt: "find X", description: "read the router" },
    },
  });
  const bookend = (id: string, name: string, label?: string) => ({
    kind: "event" as const,
    event: {
      type: "tool_call_started" as const,
      id: `agent:${id}`,
      name: `Agent(${name})`,
      metadata: { ...subagent(id, name, label), subagentLifecycle: true },
    },
  });
  const childCall = (id: string, name: string, toolId: string, tool: string, args: unknown) => ({
    kind: "event" as const,
    event: {
      type: "tool_call_started" as const,
      id: `agent:${id}:${toolId}`,
      name: `${name}▸${tool}`,
      arguments: args,
      metadata: subagent(id, name),
    },
  });

  async function turnWith(frames: readonly { kind: "event"; event: unknown }[]) {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "start", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, frames as never);
    const detail = store.completeTurn(turn.turnId, "done");
    store.close();
    return detail.messages.at(-1)?.parts ?? [];
  }

  it("converts the parent Agent tool call in place and owns its subagent's calls", async () => {
    const parts = await turnWith([
      { kind: "event", event: { type: "tool_call_started", id: "own", name: "Search", arguments: { q: "x" } } },
      launch("call-1", "researcher"),
      bookend("call-1", "researcher", "read the router"),
      childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }),
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "agent:call-1:t1",
          name: "researcher▸Read",
          content: "file body",
          metadata: subagent("call-1", "researcher"),
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "agent:call-1",
          name: "Agent(researcher)",
          executionMs: 12_400,
          metadata: { ...subagent("call-1", "researcher"), subagentLifecycle: true },
        },
      },
      {
        kind: "event",
        event: { type: "tool_call_completed", id: "call-1", name: "Agent", content: "<subagent: researcher · ok>" },
      },
    ]);

    // The delegation keeps the position its tool-call part held, after the
    // agent's own earlier call.
    expect(parts.map((part) => part.type)).toEqual(["tool-call", "subagent", "text"]);
    expect(parts.find((part) => part.type === "subagent")).toEqual({
      type: "subagent",
      toolCallId: "call-1",
      name: "researcher",
      label: "read the router",
      args: { name: "researcher", prompt: "find X", description: "read the router" },
      result: "<subagent: researcher · ok>",
      executionMs: 12_400,
      status: "complete",
      calls: [{
        toolCallId: "agent:call-1:t1",
        // The group header names the profile, so the `researcher▸` prefix goes.
        toolName: "Read",
        args: { file_path: "/repo/a.ts" },
        result: "file body",
        status: "complete",
      }],
    });
  });

  it("keeps durable metadata on the parent Agent record while child activity stays presentation-only", async () => {
    const frames = [
      {
        ...launch("call-history", "researcher"),
        event: {
          ...launch("call-history", "researcher").event,
          history: { recordId: "sth1_parent_start", sequence: 1, persistence: "persisted", untrusted: true },
        },
      },
      bookend("call-history", "researcher"),
      childCall("call-history", "researcher", "child-read", "Read", { file_path: "/repo/a.ts" }),
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "call-history",
          name: "Agent",
          content: "child summary",
          history: {
            recordId: "sth1_parent_result",
            sequence: 2,
            persistence: "persisted",
            terminalState: "success",
            untrusted: true,
          },
        },
      },
    ] as const;
    expect((await turnWith(frames.slice(0, 2))).find((part) => part.type === "subagent")).toMatchObject({
      type: "subagent",
      history: {
        recordId: "sth1_parent_start",
        sequence: 1,
        persistence: "persisted",
        untrusted: true,
      },
    });
    const parts = await turnWith(frames);
    const group = parts.find((part) => part.type === "subagent");
    expect(group).toMatchObject({
      type: "subagent",
      history: {
        recordId: "sth1_parent_result",
        sequence: 2,
        persistence: "persisted",
        terminalState: "success",
        untrusted: true,
      },
      calls: [{ toolName: "Read" }],
    });
    if (group?.type === "subagent") expect(group.calls[0]).not.toHaveProperty("history");
  });

  it("keeps canonical history from a started nested subagent call", async () => {
    const started = childCall(
      "call-started-history",
      "researcher",
      "child-read",
      "Read",
      { file_path: "/repo/a.ts" },
    );
    const parts = await turnWith([
      launch("call-started-history", "researcher"),
      bookend("call-started-history", "researcher"),
      {
        ...started,
        event: {
          ...started.event,
          history: {
            recordId: "sth1_child_start",
            sequence: 3,
            persistence: "persisted",
            artifactReferences: [{ id: "stha1_child", available: true, staleLocation: "/private/tmp/out" }],
            untrusted: true,
            staleProducerField: "must not persist",
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "agent:call-started-history:child-read",
          name: "researcher▸Read",
          content: "file body",
          metadata: subagent("call-started-history", "researcher"),
        },
      },
    ] as never);

    const group = parts.find((part) => part.type === "subagent");
    expect(group).toMatchObject({
      type: "subagent",
      calls: [{
        toolCallId: "agent:call-started-history:child-read",
        status: "complete",
        history: {
          recordId: "sth1_child_start",
          sequence: 3,
          persistence: "persisted",
          artifactReferences: [{ id: "stha1_child", available: true }],
          untrusted: true,
        },
      }],
    });
    if (group?.type === "subagent") {
      expect(group.calls[0]?.history).not.toHaveProperty("staleProducerField");
    }
  });

  it("drops adversarial subagent history on lifecycle and child paths before reopen", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "start", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      {
        ...launch("call-adversarial", "researcher"),
        event: {
          ...launch("call-adversarial", "researcher").event,
          history: { recordId: "sth1_parent_start", sequence: 1, persistence: "persisted", untrusted: true },
        },
      },
      {
        ...bookend("call-adversarial", "researcher"),
        event: {
          ...bookend("call-adversarial", "researcher").event,
          history: { persistence: "persisted", sequence: -1, untrusted: true },
        },
      },
      {
        ...childCall("call-adversarial", "researcher", "child-read", "Read", { file_path: "/repo/a.ts" }),
        event: {
          ...childCall("call-adversarial", "researcher", "child-read", "Read", { file_path: "/repo/a.ts" }).event,
          history: { persistence: "persisted", recordId: "bad\u0000child", untrusted: true },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "agent:call-adversarial:child-read",
          name: "researcher▸Read",
          content: "file body",
          metadata: subagent("call-adversarial", "researcher"),
          history: { persistence: "failed", errorCode: "x".repeat(257), untrusted: true },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "agent:call-adversarial",
          name: "Agent(researcher)",
          metadata: { ...subagent("call-adversarial", "researcher"), subagentLifecycle: true },
          history: { persistence: "persisted", truncated: "yes", untrusted: true },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "call-adversarial",
          name: "Agent",
          content: "child summary",
          history: { persistence: "unknown", untrusted: true },
        },
      },
    ] as never);
    store.completeTurn(turn.turnId, "done");
    store.close();

    const reopened = await WebStore.open({ stateDir });
    const group = reopened.getThreadDetail(thread.id)?.messages.at(-1)?.parts.find(
      (part) => part.type === "subagent",
    );
    expect(group).toMatchObject({
      type: "subagent",
      toolCallId: "call-adversarial",
      result: "child summary",
      status: "complete",
      calls: [{ toolCallId: "agent:call-adversarial:child-read", result: "file body", status: "complete" }],
    });
    expect(group).not.toHaveProperty("history");
    if (group?.type === "subagent") expect(group.calls[0]).not.toHaveProperty("history");
    reopened.close();
  });

  it("keeps a background group running until its lifecycle terminal arrives", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "start", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      launch("call-1", "researcher"),
      bookend("call-1", "researcher", "read the router"),
      childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }),
    ] as never);

    expect(store.getThreadDetail(thread.id)?.messages.at(-1)?.parts.find(
      (part) => part.type === "subagent",
    )).toMatchObject({
      type: "subagent",
      toolCallId: "call-1",
      status: "running",
      calls: [{ toolName: "Read", status: "running" }],
    });

    store.applyStreamFrames(turn.turnId, [{
      kind: "event",
      event: {
        type: "tool_call_completed",
        id: "agent:call-1",
        name: "Agent(researcher)",
        content: "Review complete",
        metadata: { ...subagent("call-1", "researcher"), subagentLifecycle: true },
      },
    }] as never);
    expect(store.getThreadDetail(thread.id)?.messages.at(-1)?.parts.find(
      (part) => part.type === "subagent",
    )).toMatchObject({
      type: "subagent",
      toolCallId: "call-1",
      status: "complete",
    });

    store.completeTurn(turn.turnId, "done");
    store.close();
  });

  it("groups native activity by the parent tool id when the provider task id differs", async () => {
    const canonicalId = "toolu_parent";
    const nativeId = "provider-task-42";
    const nativeMetadata = {
      subagent: {
        id: canonicalId,
        nativeId,
        name: "researcher",
        callIndex: 0,
        agentPath: "root/researcher",
      },
      synthetic: true,
    };
    const parts = await turnWith([
      launch(canonicalId, "researcher"),
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: `agent:${canonicalId}`,
          name: "Agent(researcher)",
          metadata: { ...nativeMetadata, subagentLifecycle: true },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: `agent:${canonicalId}:read-1`,
          name: "researcher▸Read",
          arguments: { file_path: "/repo/a.ts" },
          metadata: nativeMetadata,
        },
      },
    ]);

    const groups = parts.filter((part) => part.type === "subagent");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      type: "subagent",
      toolCallId: canonicalId,
      calls: [{ toolCallId: `agent:${canonicalId}:read-1`, toolName: "Read" }],
    });
    expect(parts.some((part) => "toolCallId" in part && part.toolCallId === nativeId)).toBe(false);
  });

  it("keeps concurrent subagents in separate groups as their events interleave", async () => {
    const parts = await turnWith([
      launch("a", "researcher"),
      launch("b", "reviewer"),
      childCall("a", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }),
      childCall("b", "reviewer", "t2", "Grep", { pattern: "x" }),
      childCall("a", "researcher", "t3", "Glob", { pattern: "*.ts" }),
    ]);

    const groups = parts.filter((part) => part.type === "subagent");
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.type === "subagent" ? group.calls.map((call) => call.toolName) : []))
      .toEqual([["Read", "Glob"], ["Grep"]]);
  });

  it("marks a failed delegation and keeps the activity it managed to record", async () => {
    const parts = await turnWith([
      launch("call-1", "researcher"),
      childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }),
      {
        kind: "event",
        event: { type: "tool_call_completed", id: "call-1", name: "Agent", isError: true, content: "timed out" },
      },
    ]);

    expect(parts.find((part) => part.type === "subagent")).toMatchObject({
      type: "subagent",
      status: "failed",
      result: "timed out",
      calls: [{ toolName: "Read", status: "running" }],
    });
  });

  it("opens a group from child activity alone when the launch was never observed", async () => {
    const parts = await turnWith([childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" })]);

    expect(parts.find((part) => part.type === "subagent")).toMatchObject({
      type: "subagent",
      toolCallId: "call-1",
      name: "researcher",
      status: "running",
      calls: [{ toolName: "Read" }],
    });
  });

  it("falls back to a plain tool-call part when subagent metadata is malformed", async () => {
    const parts = await turnWith([
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: "t1",
          name: "Read",
          arguments: { file_path: "/repo/a.ts" },
          // An open wire record: a non-string id must never key a group.
          metadata: { subagent: { id: 42, name: "researcher" }, synthetic: true },
        },
      },
    ]);

    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({ type: "tool-call", toolCallId: "t1", toolName: "Read" });
  });

  it("records what a delegation cost from its closing bookend", async () => {
    const parts = await turnWith([
      launch("call-1", "researcher"),
      bookend("call-1", "researcher"),
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "agent:call-1",
          name: "Agent(researcher)",
          executionMs: 4_200,
          metadata: {
            subagent: { id: "call-1", name: "researcher", callIndex: 0, costUsd: 0.0042 },
            synthetic: true,
            subagentLifecycle: true,
          },
        },
      },
    ]);

    expect(parts.find((part) => part.type === "subagent")).toMatchObject({
      executionMs: 4_200,
      costUsd: 0.0042,
      status: "complete",
    });
  });

  it("leaves the cost off a delegation the runtime never priced", async () => {
    const parts = await turnWith([
      launch("call-1", "researcher"),
      bookend("call-1", "researcher"),
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "agent:call-1",
          name: "Agent(researcher)",
          metadata: { ...subagent("call-1", "researcher"), subagentLifecycle: true },
        },
      },
    ]);

    expect(parts.find((part) => part.type === "subagent")).not.toHaveProperty("costUsd");
  });

  it("round-trips a persisted subagent part through validation", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "start", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      launch("call-1", "researcher"),
      childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }),
    ] as never);
    store.completeTurn(turn.turnId, "done");
    store.close();

    const reopened = await WebStore.open({ stateDir });
    const parts = reopened.getThreadDetail(thread.id)?.messages.at(-1)?.parts ?? [];
    expect(parts.find((part) => part.type === "subagent")).toMatchObject({ type: "subagent", calls: [{ toolName: "Read" }] });
    reopened.close();
  });
});

describe("WebStore tool durations", () => {
  it("preserves the runtime's reported duration on plain and subagent calls", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "time it", attachmentIds: [] });

    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: { q: "x" } } },
      { kind: "event", event: { type: "tool_call_completed", id: "tool-1", name: "Search", content: "done", executionMs: 450 } },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "child-1",
          name: "Read",
          content: "body",
          executionMs: 120,
          metadata: { subagent: { id: "agent-call", name: "researcher" } },
        },
      },
    ] as never);
    const detail = store.completeTurn(turn.turnId, "Final answer");

    expect(detail.messages[1]?.parts).toContainEqual({
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "Search",
      args: { q: "x" },
      result: "done",
      executionMs: 450,
      status: "complete",
    });
    expect(detail.messages[1]?.parts.find((part) => part.type === "subagent"))
      .toMatchObject({ calls: [expect.objectContaining({ executionMs: 120 })] });
    store.close();

    // A duration recorded once has to survive the reload the console does on
    // resume, which re-validates every persisted part.
    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThreadDetail(thread.id)?.messages[1]?.parts).toContainEqual(
      expect.objectContaining({ toolCallId: "tool-1", executionMs: 450 }),
    );
    reopened.close();
  });

  it("opens a database whose durations were serialized as null", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "legacy", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "tool_call_completed", id: "t1", name: "Search", content: "ok", executionMs: 12 } },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "child",
          name: "Read",
          content: "ok",
          executionMs: 12,
          metadata: { subagent: { id: "agent-call", name: "researcher" } },
        },
      },
    ] as never);
    store.completeTurn(turn.turnId, "Final answer");
    const databasePath = store.paths.database;
    store.close();

    // `JSON.stringify` writes NaN and Infinity as `null`, and releases before
    // durations were canonicalized persisted them unchecked. `validateStorage()`
    // re-parses every message at open, so a strict guard here would refuse the
    // whole store over a value nothing renders.
    const legacy = new DatabaseSync(databasePath);
    const row = legacy.prepare("SELECT id, parts_json FROM messages WHERE role = 'assistant'")
      .get() as unknown as { id: string; parts_json: string };
    legacy.prepare("UPDATE messages SET parts_json = ? WHERE id = ?")
      .run(row.parts_json.replaceAll('"executionMs":12', '"executionMs":null'), row.id);
    legacy.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThreadDetail(thread.id)?.messages).toHaveLength(2);
    reopened.close();
  });

  it("drops a hostile duration at the write boundary instead of refusing to reopen", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "bad clocks", attachmentIds: [] });

    // The stream wire validates `type` and nothing else, and providers derive
    // this from raw wall-clock subtraction, so a backward clock step really can
    // produce these. None may reach SQLite: `validateStorage()` re-parses every
    // message at open, so one poisoned row would refuse the entire store.
    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "tool_call_completed", id: "neg", name: "Search", content: "a", executionMs: -1 } },
      { kind: "event", event: { type: "tool_call_completed", id: "nan", name: "Search", content: "b", executionMs: Number.NaN } },
      { kind: "event", event: { type: "tool_call_completed", id: "inf", name: "Search", content: "c", executionMs: Number.POSITIVE_INFINITY } },
      { kind: "event", event: { type: "tool_call_completed", id: "str", name: "Search", content: "d", executionMs: "500" } },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "child",
          name: "Read",
          content: "e",
          executionMs: -7,
          metadata: { subagent: { id: "agent-call", name: "researcher" } },
        },
      },
    ] as never);
    const detail = store.completeTurn(turn.turnId, "Final answer");

    for (const part of detail.messages[1]?.parts ?? []) {
      if (part.type === "tool-call") expect(part).not.toHaveProperty("executionMs");
      if (part.type === "subagent") {
        for (const call of part.calls) expect(call).not.toHaveProperty("executionMs");
      }
    }
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThreadDetail(thread.id)?.messages).toHaveLength(2);
    reopened.close();
  });

  it("omits the duration entirely when the runtime reported none", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "no timing", attachmentIds: [] });

    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "tool_call_completed", id: "tool-1", name: "Search", content: "done" } },
    ] as never);
    const detail = store.completeTurn(turn.turnId, "Final answer");

    expect(detail.messages[1]?.parts.find((part) => part.type === "tool-call"))
      .not.toHaveProperty("executionMs");
    store.close();
  });
});

describe("WebStore conversation search", () => {
  // Duplicated in `webapp/src/thread-search.ts`, which cannot import this
  // package. Both sides pin the literals so a change to one is a red test
  // rather than silently broken highlighting in the browser.
  it("pins the highlight sentinels the webapp mirrors", () => {
    expect(WEB_SEARCH_HIGHLIGHT_OPEN).toBe("\u0002");
    expect(WEB_SEARCH_HIGHLIGHT_CLOSE).toBe("\u0003");
    expect(WEB_THREAD_SEARCH_MIN_QUERY).toBe(2);
  });

  const openSearchStore = async (): Promise<{
    readonly store: WebStore;
    readonly stateDir: string;
    readonly threadId: string;
  }> => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent(), agent("agent-two")]);
    return { store, stateDir, threadId: store.createThread("agent-one").id };
  };

  const say = (store: WebStore, threadId: string, prompt: string, answer: string): void => {
    const turn = store.beginTurn({ threadId, text: prompt, attachmentIds: [] });
    store.completeTurn(turn.turnId, answer);
  };

  it("finds a conversation by words only its messages contain", async () => {
    const { store, threadId } = await openSearchStore();
    store.patchThread(threadId, { title: "Unrelated title" });
    say(store, threadId, "how do I reach the exporter", "Point it at the Tailscale address.");

    const page = store.searchThreads({ sourceId: "agent-one", query: "tailscale" });

    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]?.thread.id).toBe(threadId);
    expect(page.hits[0]).toMatchObject({ titleMatch: false, messageMatches: 1 });
    expect(page.hits[0]?.snippet).toContain("Tailscale");
    expect(page.truncated).toBe(false);
    store.close();
  });

  it("wraps each match in the highlight sentinels", async () => {
    const { store, threadId } = await openSearchStore();
    say(store, threadId, "reach the exporter", "Point it at the Tailscale address.");

    const [hit] = store.searchThreads({ sourceId: "agent-one", query: "tailscale" }).hits;

    expect(hit?.snippet).toContain(
      `${WEB_SEARCH_HIGHLIGHT_OPEN}Tailscale${WEB_SEARCH_HIGHLIGHT_CLOSE}`,
    );
    store.close();
  });

  it("matches a title even when no message repeats it", async () => {
    const { store, threadId } = await openSearchStore();
    store.patchThread(threadId, { title: "Quarterly planning" });
    say(store, threadId, "kick this off", "Sure.");

    const page = store.searchThreads({ sourceId: "agent-one", query: "quarterly" });

    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]).toMatchObject({ titleMatch: true, messageMatches: 0 });
    expect(page.hits[0]?.snippet).toBeUndefined();
    store.close();
  });

  it("narrows as terms are added, and matches on a prefix as it is typed", async () => {
    const { store, threadId } = await openSearchStore();
    say(store, threadId, "deploy the phoenix exporter", "Done.");
    const other = store.createThread("agent-one");
    say(store, other.id, "deploy the docs website", "Done.");

    expect(store.searchThreads({ sourceId: "agent-one", query: "deploy" }).hits).toHaveLength(2);
    expect(store.searchThreads({ sourceId: "agent-one", query: "deploy phoen" }).hits)
      .toMatchObject([{ thread: { id: threadId } }]);
    store.close();
  });

  it("scopes results to the addressed agent", async () => {
    const { store, threadId } = await openSearchStore();
    say(store, threadId, "shared vocabulary", "Done.");
    const elsewhere = store.createThread("agent-two");
    say(store, elsewhere.id, "shared vocabulary", "Done.");

    expect(store.searchThreads({ sourceId: "agent-one", query: "vocabulary" }).hits)
      .toMatchObject([{ thread: { id: threadId } }]);
    store.close();
  });

  it("returns archived conversations, so archiving stops hiding them from search", async () => {
    const { store, threadId } = await openSearchStore();
    say(store, threadId, "the archived subject", "Done.");
    store.patchThread(threadId, { archived: true });

    const page = store.searchThreads({ sourceId: "agent-one", query: "archived subject" });

    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]?.thread.archivedAt).not.toBeNull();
    store.close();
  });

  it("indexes conversation prose only, not reasoning or tool payloads", async () => {
    const { store, threadId } = await openSearchStore();
    const turn = store.beginTurn({ threadId, text: "look around", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "assistant_thought", text: "considering zymurgy carefully" } },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "t1",
          name: "Search",
          arguments: { q: "kumquat" },
          content: "rutabaga",
        },
      },
    ] as never);
    store.completeTurn(turn.turnId, "All set.");

    expect(store.searchThreads({ sourceId: "agent-one", query: "zymurgy" }).hits).toEqual([]);
    expect(store.searchThreads({ sourceId: "agent-one", query: "kumquat" }).hits).toEqual([]);
    expect(store.searchThreads({ sourceId: "agent-one", query: "rutabaga" }).hits).toEqual([]);
    expect(store.searchThreads({ sourceId: "agent-one", query: "all set" }).hits).toHaveLength(1);
    store.close();
  });

  it("folds diacritics so an unaccented query still matches accented prose", async () => {
    const { store, threadId } = await openSearchStore();
    say(store, threadId, "rename the héro button", "Renamed.");

    expect(store.searchThreads({ sourceId: "agent-one", query: "hero" }).hits).toHaveLength(1);
    store.close();
  });

  it("indexes an answer when its turn settles, not on every streaming snapshot", async () => {
    const { store, threadId } = await openSearchStore();
    const turn = store.beginTurn({ threadId, text: "first wording", attachmentIds: [] });

    // Re-extracting a large message's text on every ~50ms snapshot costs several
    // times the row write, so a running answer stays out of the index. Interim
    // wording is transient and never worth indexing on its own.
    store.applyStreamFrames(turn.turnId, [{ kind: "append", delta: "the phoenix exporter" }] as never);
    expect(store.searchThreads({ sourceId: "agent-one", query: "phoenix" }).hits).toEqual([]);

    // Appending more while still running keeps it out; only settling admits it.
    store.applyStreamFrames(turn.turnId, [{ kind: "append", delta: " and the grafana one" }] as never);
    expect(store.searchThreads({ sourceId: "agent-one", query: "grafana" }).hits).toEqual([]);

    store.completeTurn(turn.turnId, "the grafana exporter");
    expect(store.searchThreads({ sourceId: "agent-one", query: "grafana" }).hits).toHaveLength(1);
    store.close();
  });

  it("indexes an interrupted answer, so a crashed turn is not lost to search", async () => {
    const { store, stateDir, threadId } = await openSearchStore();
    const turn = store.beginTurn({ threadId, text: "start", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [{ kind: "append", delta: "the phoenix exporter" }] as never);
    // Close without completing the turn: the process died mid-answer.
    store.close();

    const reopened = await WebStore.open({ stateDir });

    expect(reopened.searchThreads({ sourceId: "agent-one", query: "phoenix" }).hits)
      .toHaveLength(1);
    reopened.close();
  });

  it("re-indexes an edited answer and forgets a deleted conversation", async () => {
    const { store, threadId } = await openSearchStore();
    say(store, threadId, "first prompt", "the phoenix exporter");
    expect(store.searchThreads({ sourceId: "agent-one", query: "phoenix" }).hits).toHaveLength(1);

    store.patchThread(threadId, { archived: true });
    await store.deleteArchivedThread(threadId);
    expect(store.searchThreads({ sourceId: "agent-one", query: "phoenix" }).hits).toEqual([]);
    store.close();
  });

  it("reserves room for message hits when many titles match the same word", async () => {
    const { store } = await openSearchStore();
    // Titles are auto-derived from first prompts, so a common word matches many
    // of them. The one conversation that says the word only inside a message is
    // exactly what this feature exists to find; it must not be crowded out.
    for (let index = 0; index < 60; index += 1) {
      const noisy = store.createThread("agent-one");
      store.patchThread(noisy.id, { title: `report ${String(index)}` });
      say(store, noisy.id, "unrelated body", "Nothing here.");
    }
    const buried = store.createThread("agent-one");
    store.patchThread(buried.id, { title: "zzz" });
    say(store, buried.id, "the report is inside the message", "Filed.");

    const page = store.searchThreads({ sourceId: "agent-one", query: "report" });

    expect(page.hits).toHaveLength(WEB_THREAD_SEARCH_MAX);
    expect(page.hits.map((hit) => hit.thread.id)).toContain(buried.id);
    expect(page.truncated).toBe(true);
    store.close();
  });

  it("still fills the page from titles alone when no message matched", async () => {
    const { store } = await openSearchStore();
    for (let index = 0; index < 5; index += 1) {
      const named = store.createThread("agent-one");
      store.patchThread(named.id, { title: `budget ${String(index)}` });
      say(store, named.id, "unrelated body", "Nothing here.");
    }

    const page = store.searchThreads({ sourceId: "agent-one", query: "budget" });

    expect(page.hits).toHaveLength(5);
    expect(page.hits.every((hit) => hit.titleMatch)).toBe(true);
    expect(page.truncated).toBe(false);
    store.close();
  });

  it("strips the highlight sentinels from indexed text so a snippet cannot lie", async () => {
    const { store, threadId } = await openSearchStore();
    say(
      store,
      threadId,
      `injected ${WEB_SEARCH_HIGHLIGHT_OPEN}fake${WEB_SEARCH_HIGHLIGHT_CLOSE} sentinel needle`,
      "Filed.",
    );

    const [hit] = store.searchThreads({ sourceId: "agent-one", query: "needle" }).hits;

    // Exactly one highlighted run, and it is the term that actually matched.
    expect(hit?.snippet?.split(WEB_SEARCH_HIGHLIGHT_OPEN)).toHaveLength(2);
    expect(hit?.snippet).toContain(
      `${WEB_SEARCH_HIGHLIGHT_OPEN}needle${WEB_SEARCH_HIGHLIGHT_CLOSE}`,
    );
    expect(hit?.snippet).toContain("injected fake sentinel");
    store.close();
  });

  it("reports truncation only when matches were actually cut", async () => {
    const { store, threadId } = await openSearchStore();
    say(store, threadId, "one solitary needle", "Filed.");

    expect(store.searchThreads({ sourceId: "agent-one", query: "needle" }).truncated).toBe(false);
    store.close();
  });

  it("treats a too-short or wordless query as no query at all", async () => {
    const { store, threadId } = await openSearchStore();
    say(store, threadId, "anything at all", "Done.");

    for (const query of ["a", "  ", '"*(-)']) {
      expect(store.searchThreads({ sourceId: "agent-one", query }))
        .toEqual({ hits: [], truncated: false });
    }
    store.close();
  });

  it("rejects a search against an agent it does not know", async () => {
    const { store } = await openSearchStore();

    expect(() => store.searchThreads({ sourceId: "ghost", query: "anything" }))
      .toThrowError(/Agent not found/u);
    store.close();
  });

  it("backfills the index for a database written before it existed", async () => {
    const { store, stateDir, threadId } = await openSearchStore();
    say(store, threadId, "the migrated subject", "Done.");
    store.close();

    // Wind a real database back to schema 8 by removing the index and its
    // triggers, so initialize() has to rebuild and repopulate them.
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    for (const trigger of ["insert", "update", "delete"]) {
      database.exec(`DROP TRIGGER message_search_${trigger}`);
    }
    database.exec("DROP TABLE message_search");
    database.exec("PRAGMA user_version = 8");
    database.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.searchThreads({ sourceId: "agent-one", query: "migrated" }).hits)
      .toHaveLength(1);
    expect(
      new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true })
        .prepare("PRAGMA user_version").get(),
    ).toMatchObject({ user_version: 14 });
    reopened.close();
  });
});
