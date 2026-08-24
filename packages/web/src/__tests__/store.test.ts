import { chmod, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_AGENT_REPLY_PARTS, type AgentReplyPart } from "@mono-agent/agent-contracts";

import type { WebAgentSummary } from "../contracts.js";
import { prepareWebStatePaths } from "../state-paths.js";
import { WebStore } from "../store.js";
import { fakeProcessJob, temporaryRoot } from "./helpers.js";

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
    store.patchThread(thread.id, { workflowStatus: "done" });
    const reserved = store.reserveLiveInput(
      thread.id,
      "Run after the current work",
      { model: "provider/default", effort: "high" },
    );
    expect(reserved).toMatchObject({ offered: false, message: { liveInputStatus: "queued" } });

    const promoted = store.promoteNextQueuedLiveInput(thread.id);
    expect(promoted).toMatchObject({
      text: "Run after the current work",
      userMessageId: reserved.message.id,
      thread: {
        workflowStatus: "in_progress",
        runState: { status: "running", model: "provider/default", effort: "high" },
      },
    });
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
    store.patchThread(thread.id, { workflowStatus: "done" });

    const started = store.beginAssistantTurn({
      threadId: thread.id,
      prompt: "Process the worker result",
      model: "provider/default",
      effort: "high",
    });
    expect(started.text).toBe("Process the worker result");
    expect(started.thread).toMatchObject({
      workflowStatus: "in_progress",
      runState: { status: "running", model: "provider/default", effort: "high" },
    });
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

  it("migrates schema v1 state through notification and live-input storage", async () => {
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
    expect(version.user_version).toBe(9);
    expect(columns.map((column) => column.name)).toContain("trigger_kind");
    expect(ledger).toBeDefined();
    expect(liveInputs).toBeDefined();
    expect(processJobCards).toBeDefined();
  });

  it("keeps live memory inventory out of schema v9 and persisted agent summaries", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const databasePath = store.paths.database;
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.listAgents()[0]).not.toHaveProperty("memory");
    reopened.close();

    const inspected = new DatabaseSync(databasePath);
    const version = inspected.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    const tables = inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as Array<{ readonly name: string }>;
    const agentColumns = inspected.prepare("PRAGMA table_info(agents)").all() as unknown as Array<{ readonly name: string }>;
    inspected.close();
    expect(version.user_version).toBe(9);
    expect(tables.map((row) => row.name).some((name) => name.includes("memory"))).toBe(false);
    expect(agentColumns.map((column) => column.name).some((name) => name.includes("memory"))).toBe(false);
  });

  it("migrates schema v6 state through v9 conversation workspace storage", async () => {
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
    expect(version.user_version).toBe(9);
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
    future.exec("PRAGMA user_version = 10");
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

describe("conversation workspace storage", () => {
  it("atomically files, pins, archives, unfiles, and guards interactive workflow", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const collection = store.createCollection("Projects");
    const created = store.createThread("agent-one");

    const organized = store.patchThread(created.id, {
      collectionId: collection.id,
      workflowStatus: "done",
      pinned: true,
      expectedRevision: created.revision,
    });
    expect(organized).toMatchObject({
      collectionId: collection.id,
      workflowStatus: "done",
      pinned: true,
    });
    expect(() => store.patchThread(created.id, {
      workflowStatus: "todo",
      expectedRevision: created.revision,
    })).toThrowError(expect.objectContaining({ code: "thread_revision_conflict" }));

    const archived = store.patchThread(created.id, { archived: true });
    expect(archived).toMatchObject({
      pinned: false,
      collectionId: collection.id,
      workflowStatus: "done",
    });
    const active = store.patchThread(created.id, { archived: false });
    const turn = store.beginTurn({ threadId: created.id, text: "resume", attachmentIds: [] });
    expect(store.getThread(created.id)?.workflowStatus).toBe("in_progress");
    expect(() => store.patchThread(created.id, { workflowStatus: "done" }))
      .toThrowError(expect.objectContaining({ code: "workflow_turn_active" }));
    store.completeTurn(turn.turnId, "resumed");
    expect(active.collectionId).toBe(collection.id);

    expect(store.deleteCollection(collection.id)).toBe(1);
    expect(store.getThread(created.id)?.collectionId).toBeNull();
    expect(store.listCollections()).toEqual([]);
    expect(() => store.createCollection("Unfiled"))
      .toThrowError(expect.objectContaining({ code: "reserved_collection_name" }));

    const reservation = store.reserveNotification({
      sourceId: "agent-one",
      deliveryKey: "webhook-workspace-exclusion",
      triggerKind: "webhook",
      text: "automated",
    });
    const automation = store.completeNotification(reservation).thread!;
    expect(automation).toMatchObject({ canSend: false, canUpload: false });
    expect(automation.workflowStatus).toBeUndefined();
    expect(() => store.patchThread(automation.id, { collectionId: null }))
      .toThrowError(expect.objectContaining({ code: "automation_thread_metadata" }));
    expect(() => store.beginTurn({ threadId: automation.id, text: "reply", attachmentIds: [] }))
      .toThrowError(expect.objectContaining({ code: "automation_thread_read_only" }));
    expect(() => store.reserveLiveInput(automation.id, "follow up"))
      .toThrowError(expect.objectContaining({ code: "automation_thread_read_only" }));
    store.close();
  });

  it("searches only titles, visible user text, and completed assistant text with anchors", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.patchThread(thread.id, { title: "Roadmap Alpha" });
    const turn = store.beginTurn({ threadId: thread.id, text: "visible user phrase", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "assistant_thought", text: "classified reasoning phrase" } },
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: "search-exclusion-tool",
          name: "Lookup",
          arguments: { query: "toolonlyneedle" },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "search-exclusion-tool",
          name: "Lookup",
          content: "toolonlyneedle",
        },
      },
      {
        kind: "event",
        event: {
          type: "runtime_warning",
          message: "telemetryonlyneedle",
          warningKind: "provider",
        },
      },
      { kind: "append", delta: "streamed draft" },
    ]);
    const completed = store.completeTurn(turn.turnId, "completed final phrase", undefined, [{
      type: "attachment",
      id: "search-exclusion-attachment",
      reference: { scheme: "mono-agent-artifact", id: "search-exclusion-artifact" },
      name: "attachmentonlyneedle.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      integrityId: `sha256:${"c".repeat(64)}`,
    }]);
    const assistantId = completed.messages.at(-1)!.id;

    const failedThread = store.createThread("agent-one");
    const failed = store.beginTurn({ threadId: failedThread.id, text: "ordinary request", attachmentIds: [] });
    store.applyStreamFrame(failed.turnId, { kind: "append", delta: "failed partial phrase" });
    store.failTurn(failed.turnId, { message: "provider stopped" });

    expect(store.listThreadsPage({ q: "Roadmap", type: "interactive" }).threads[0]?.searchMatch)
      .toEqual({ snippet: "Roadmap Alpha" });
    const userHit = store.listThreadsPage({ q: "visible user", type: "interactive" }).threads[0];
    expect(userHit?.searchMatch?.messageId).toBe(turn.userMessageId);
    const assistantHit = store.listThreadsPage({ q: "completed final", type: "interactive" }).threads[0];
    expect(assistantHit?.searchMatch?.messageId).toBe(assistantId);
    expect(store.listThreadsPage({ q: "classified reasoning", type: "interactive" }).threads).toEqual([]);
    expect(store.listThreadsPage({ q: "toolonlyneedle", type: "interactive" }).threads).toEqual([]);
    expect(store.listThreadsPage({ q: "telemetryonlyneedle", type: "interactive" }).threads).toEqual([]);
    expect(store.listThreadsPage({ q: "attachmentonlyneedle", type: "interactive" }).threads).toEqual([]);
    expect(store.listThreadsPage({ q: "failed partial", type: "interactive" }).threads).toEqual([]);
    expect(store.listMessagesAround(thread.id, assistantId, 5).messages.map((message) => message.id))
      .toContain(assistantId);
    store.close();
  });

  it("keeps pinned-first keyset pagination stable without duplicates", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({
      stateDir: join(base, "state"),
      clock: () => new Date("2026-07-17T10:00:00.000Z"),
    });
    store.replaceAgents([agent()]);
    const firstCreated = store.createThread("agent-one");
    const secondCreated = store.createThread("agent-one");
    const thirdCreated = store.createThread("agent-one");
    store.patchThread(firstCreated.id, { pinned: true });

    const firstPage = store.listThreadsPage({ type: "interactive", limit: 2 });
    expect(firstPage.threads[0]).toMatchObject({ id: firstCreated.id, pinned: true });
    const cursor = firstPage.nextCursor;
    if (cursor === undefined) throw new Error("Expected another thread page.");
    const secondPage = store.listThreadsPage({
      type: "interactive",
      limit: 2,
      before: cursor,
    });
    const ids = [...firstPage.threads, ...secondPage.threads].map((thread) => thread.id);
    expect(new Set(ids)).toEqual(new Set([firstCreated.id, secondCreated.id, thirdCreated.id]));
    expect(ids).toHaveLength(3);
    store.close();
  });

  it("upgrades a v8 database and backfills workflow and FTS state", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const paths = await prepareWebStatePaths({ stateDir });
    const legacy = new DatabaseSync(paths.database);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE agents (
        source_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        health TEXT,
        supports_attachments INTEGER NOT NULL DEFAULT 0,
        models_json TEXT,
        default_model TEXT,
        default_effort TEXT,
        efforts_json TEXT,
        model_options_json TEXT,
        cron_read INTEGER NOT NULL DEFAULT 0,
        cron_actions INTEGER NOT NULL DEFAULT 0,
        ask_by_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        conversation_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        title_manual INTEGER NOT NULL DEFAULT 0,
        trigger_kind TEXT CHECK (trigger_kind IN ('cron', 'webhook')),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        assistant_message_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE live_inputs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        active_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        status TEXT NOT NULL CHECK (status IN ('offered', 'queued')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agents (
        source_id, label, status, health, supports_attachments, models_json,
        default_model, default_effort, efforts_json, model_options_json,
        cron_read, cron_actions, ask_by_id, updated_at
      ) VALUES (
        'agent-one', 'agent-one', 'online', 'running', 1, '["provider/default"]',
        'provider/default', NULL, '["low","high"]',
        '{"provider/default":{"effortLevels":["low","high"]}}',
        0, 0, 0, '2026-07-17T09:00:00.000Z'
      );
      INSERT INTO threads (
        id, source_id, conversation_id, title, title_manual, trigger_kind,
        archived_at, created_at, updated_at, revision
      ) VALUES
        ('legacy-interactive', 'agent-one', 'legacy-conversation', 'Legacy title', 0, NULL,
         NULL, '2026-07-17T09:00:00.000Z', '2026-07-17T09:00:00.000Z', 1),
        ('legacy-empty', 'agent-one', 'legacy-empty-conversation', 'Legacy empty', 0, NULL,
         NULL, '2026-07-17T09:00:00.000Z', '2026-07-17T09:00:00.000Z', 1),
        ('legacy-turn-only', 'agent-one', 'legacy-turn-only-conversation', 'Legacy turn only', 0, NULL,
         NULL, '2026-07-17T09:00:00.000Z', '2026-07-17T09:00:00.000Z', 1),
        ('legacy-message-only', 'agent-one', 'legacy-message-only-conversation', 'Legacy message only', 0, NULL,
         NULL, '2026-07-17T09:00:00.000Z', '2026-07-17T09:00:00.000Z', 1),
        ('legacy-live-input', 'agent-one', 'legacy-live-input-conversation', 'Legacy live input', 0, NULL,
         NULL, '2026-07-17T09:00:00.000Z', '2026-07-17T09:00:00.000Z', 1),
        ('legacy-webhook', 'agent-one', 'legacy-webhook-conversation', 'Legacy automation', 0, 'webhook',
         NULL, '2026-07-17T09:00:00.000Z', '2026-07-17T09:00:00.000Z', 1);
      INSERT INTO turns (
        id, thread_id, status, text, assistant_message_id, started_at, finished_at
      ) VALUES
        ('legacy-turn', 'legacy-interactive', 'complete', 'migration searchable',
         'legacy-assistant', '2026-07-17T09:00:00.000Z', '2026-07-17T09:01:00.000Z'),
        ('legacy-orphan-turn', 'legacy-turn-only', 'complete', 'historic turn only',
         'legacy-missing-assistant', '2026-07-17T09:00:00.000Z', '2026-07-17T09:01:00.000Z');
      INSERT INTO messages (
        id, thread_id, turn_id, role, parts_json, created_at, updated_at, status
      ) VALUES
        ('legacy-user', 'legacy-interactive', 'legacy-turn', 'user',
         '[{"type":"text","text":"migration searchable"}]',
         '2026-07-17T09:00:00.000Z', '2026-07-17T09:00:00.000Z', 'complete'),
        ('legacy-assistant', 'legacy-interactive', 'legacy-turn', 'assistant',
         '[{"type":"text","text":"migration complete"}]',
         '2026-07-17T09:01:00.000Z', '2026-07-17T09:01:00.000Z', 'complete'),
        ('legacy-standalone-message', 'legacy-message-only', NULL, 'user',
         '[{"type":"text","text":"historic message only"}]',
         '2026-07-17T09:01:00.000Z', '2026-07-17T09:01:00.000Z', 'complete'),
        ('legacy-live-message', 'legacy-live-input', NULL, 'user',
         '[{"type":"text","text":"historic queued input"}]',
         '2026-07-17T09:01:00.000Z', '2026-07-17T09:01:00.000Z', 'complete');
      INSERT INTO live_inputs (
        id, thread_id, message_id, active_turn_id, text, model, effort,
        status, created_at, updated_at
      ) VALUES (
        'legacy-queued-input', 'legacy-live-input', 'legacy-live-message', NULL,
        'historic queued input', NULL, NULL, 'queued',
        '2026-07-17T09:01:00.000Z', '2026-07-17T09:01:00.000Z'
      );
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    expect(migrated.getThread("legacy-empty")?.workflowStatus).toBe("todo");
    for (const threadId of [
      "legacy-interactive",
      "legacy-turn-only",
      "legacy-message-only",
      "legacy-live-input",
    ]) expect(migrated.getThread(threadId)?.workflowStatus).toBe("in_progress");
    expect(migrated.getThread("legacy-webhook")?.workflowStatus).toBeUndefined();
    expect(migrated.listThreadsPage({ q: "migration complete" }).threads)
      .toEqual([expect.objectContaining({
        id: "legacy-interactive",
        searchMatch: expect.objectContaining({ messageId: "legacy-assistant" }),
      })]);
    migrated.close();
    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThread("legacy-empty")?.workflowStatus).toBe("todo");
    expect(reopened.getThread("legacy-interactive")?.workflowStatus).toBe("in_progress");
    reopened.close();
    const inspected = new DatabaseSync(paths.database);
    expect(inspected.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'thread_search'").get()).toBeDefined();
    inspected.close();
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
