import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MemoryOperatorError,
  type AgentResponder,
  type MemoryOperatorRecord,
  type MemoryOperatorService,
} from "@mono-agent/agent-contracts";

import { startTuiAdapter, type TuiAdapterStartResult } from "../index.js";

let running: TuiAdapterStartResult | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const responder: AgentResponder = {
  respond: async () => ({ text: "ok" }),
};

const REVISION = "a".repeat(64);

const record: MemoryOperatorRecord = {
  id: "memory-1",
  revision: REVISION,
  lifecycle: "active",
  type: "note",
  status: "open",
  text: "Prefers concise summaries",
  salience: 0.8,
  isInsight: true,
  createdAt: "2026-08-24T10:00:00.000Z",
  accessCount: 2,
  tags: ["preference"],
};

function memoryService(overrides: Partial<MemoryOperatorService> = {}): MemoryOperatorService {
  return {
    capability: () => ({
      schema: 1,
      backend: "builtin",
      tier: "bujo",
      status: "ready",
      read: true,
      actions: true,
      graph: "captured",
    }),
    overview: () => ({
      generatedAt: "2026-08-24T10:00:00.000Z",
      capability: {
        schema: 1,
        backend: "builtin",
        tier: "bujo",
        status: "ready",
        read: true,
        actions: true,
        graph: "captured",
      },
      counts: { total: 1, active: 1, superseded: 0, forgotten: 0, byType: { task: 0, event: 0, note: 1 } },
      access: { totalCount: 2, accessedRecords: 1 },
    }),
    records: () => ({ records: [record] }),
    record: () => ({ record, history: [] }),
    graph: () => ({
      fidelity: "captured",
      nodes: [{ kind: "memory", id: record.id, label: record.text, lifecycle: "active", recordType: "note" }],
      edges: [],
    }),
    edit: () => ({
      kind: "queued",
      operation: {
        id: "operation-1",
        action: "edit",
        recordId: record.id,
        status: "queued",
        createdAt: "2026-08-24T10:01:00.000Z",
        updatedAt: "2026-08-24T10:01:00.000Z",
        resultRecordId: "memory-2",
      },
    }),
    forget: () => ({
      kind: "confirmation_required",
      confirmation: {
        token: "confirm-forget",
        expiresAt: "2026-08-24T10:06:00.000Z",
        message: "Forget this memory?",
      },
    }),
    restore: () => ({
      kind: "queued",
      operation: {
        id: "operation-2",
        action: "restore",
        recordId: record.id,
        status: "queued",
        createdAt: "2026-08-24T10:02:00.000Z",
        updatedAt: "2026-08-24T10:02:00.000Z",
        resultRecordId: "memory-2",
      },
    }),
    operation: () => ({
      id: "operation-1",
      action: "edit",
      recordId: record.id,
      status: "succeeded",
      createdAt: "2026-08-24T10:01:00.000Z",
      updatedAt: "2026-08-24T10:01:01.000Z",
      resultRecordId: "memory-2",
    }),
    ...overrides,
  };
}

function bearer(): Record<string, string> {
  return { authorization: "Bearer owner-key" };
}

async function memoryFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${running!.baseUrl}/v1/memory${path}`, init);
}

describe("memory operator routes", () => {
  it("advertises sanitized memory capability and disables actions without an operator key", async () => {
    running = await startTuiAdapter({ responder, memory: memoryService() });

    await expect((await fetch(running.infoUrl)).json()).resolves.toMatchObject({
      capabilities: {
        memory: { schema: 1, backend: "builtin", tier: "bujo", read: true, actions: false },
      },
    });
    expect((await memoryFetch("")).status).toBe(200);
    expect((await memoryFetch("/records/memory-1/forget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: REVISION, idempotencyKey: "forget-1" }),
    })).status).toBe(403);
  });

  it("freshly gates the four inventory reads when projected capability read support is false", async () => {
    const capability = vi.fn<MemoryOperatorService["capability"]>(() => ({
      schema: 1,
      backend: "builtin",
      tier: "bujo",
      status: "degraded",
      read: false,
      actions: false,
      graph: "unavailable",
      reason: "Memory action state requires recovery.",
    }));
    const overview = vi.fn<MemoryOperatorService["overview"]>(() => memoryService().overview());
    const records = vi.fn<MemoryOperatorService["records"]>(() => ({ records: [record] }));
    const detail = vi.fn<MemoryOperatorService["record"]>(() => ({ record, history: [] }));
    const graph = vi.fn<MemoryOperatorService["graph"]>(() => ({ fidelity: "unavailable", nodes: [], edges: [] }));
    running = await startTuiAdapter({
      responder,
      memory: memoryService({ capability, overview, records, record: detail, graph }),
    });

    for (const path of ["", "/records", "/records/memory-1", "/graph"]) {
      const response = await memoryFetch(path);
      expect(response.status, path).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: { code: "unavailable", message: "Memory operator is temporarily unavailable." },
      });
    }
    expect(capability).toHaveBeenCalledTimes(4);
    expect(overview).not.toHaveBeenCalled();
    expect(records).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect((await memoryFetch("/operations/operation-1")).status).toBe(200);
    expect(capability).toHaveBeenCalledTimes(4);
  });

  it("degrades getter failures without exposing capability diagnostics in bodies or logs", async () => {
    const rootPath = "/Users/owner/private-memory.db";
    const credential = "sk-memory-secret";
    const loggerError = vi.fn();
    const capability = () => ({
      get schema(): 1 {
        throw new Error(`${rootPath} ${credential}`);
      },
      backend: "builtin" as const,
      tier: "bujo" as const,
      status: "ready" as const,
      read: true,
      actions: true,
      graph: "captured" as const,
    });
    running = await startTuiAdapter({
      responder,
      logger: { error: loggerError },
      memory: memoryService({ capability }),
    });

    const info = await fetch(running.infoUrl);
    expect(info.status).toBe(200);
    await expect(info.json()).resolves.toMatchObject({
      capabilities: {
        memory: {
          schema: 1,
          backend: "builtin",
          status: "degraded",
          read: false,
          actions: false,
          graph: "unavailable",
          reason: "Memory operator is temporarily unavailable.",
        },
      },
    });
    const route = await memoryFetch("");
    expect(route.status).toBe(503);
    const exposed = JSON.stringify([await route.json(), loggerError.mock.calls]);
    expect(exposed).not.toContain(rootPath);
    expect(exposed).not.toContain(credential);
    expect(loggerError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ category: expect.any(String) }),
    );
    expect(loggerError.mock.calls.flatMap((call) => Object.keys(call[1] ?? {}))).not.toContain("error");
  });

  it("serves normalized bounded inventory, detail, graph, and operation state", async () => {
    const records = vi.fn<MemoryOperatorService["records"]>(() => ({ records: [record] }));
    const detail = vi.fn<MemoryOperatorService["record"]>(() => ({ record, history: [] }));
    const graph = vi.fn<MemoryOperatorService["graph"]>(() => ({ fidelity: "captured", nodes: [], edges: [] }));
    running = await startTuiAdapter({
      responder,
      apiKey: "owner-key",
      memory: memoryService({ records, record: detail, graph }),
    });

    const headers = bearer();
    expect((await memoryFetch("/records")).status).toBe(401);
    const params = new URLSearchParams({
      q: "  ｃoncise  ",
      lifecycle: "active",
      type: "note",
      collection: "  ｐeople  ",
      limit: "100",
      before: "cursor",
    });
    expect((await memoryFetch(`/records?${params.toString()}`, { headers })).status).toBe(200);
    expect(records).toHaveBeenCalledWith({
      query: "concise",
      lifecycle: "active",
      type: "note",
      collection: "people",
      limit: 100,
      before: "cursor",
    });
    expect((await memoryFetch("/records", { headers })).status).toBe(200);
    expect(records).toHaveBeenLastCalledWith({ limit: 50 });
    const maxQuery = "🧠".repeat(512);
    const maxCollection = "c".repeat(128);
    const maxParams = new URLSearchParams({ q: maxQuery, collection: maxCollection });
    expect((await memoryFetch(`/records?${maxParams.toString()}`, { headers })).status).toBe(200);
    expect(records).toHaveBeenLastCalledWith({
      query: maxQuery,
      collection: maxCollection,
      limit: 50,
    });

    const maxCodePointId = "🧠".repeat(512);
    expect((await memoryFetch(`/records/${encodeURIComponent(maxCodePointId)}`, { headers })).status).toBe(200);
    expect(detail).toHaveBeenCalledWith(maxCodePointId);

    const graphParams = new URLSearchParams({ focusId: maxCodePointId, includeHistory: "true", limit: "200" });
    expect((await memoryFetch(`/graph?${graphParams.toString()}`, { headers })).status).toBe(200);
    expect(graph).toHaveBeenCalledWith({ focusId: maxCodePointId, includeHistory: true, limit: 200 });
    expect((await memoryFetch("/graph", { headers })).status).toBe(200);
    expect(graph).toHaveBeenLastCalledWith({ limit: 100 });
    expect((await memoryFetch("/operations/operation-1", { headers })).status).toBe(200);
  });

  it("projects every service result onto clean allowlisted wire objects", async () => {
    const rootPath = "/Users/owner/private-memory.db";
    const credential = "sk-memory-secret";
    const extra = { rootPath, credential, serializationTrap: 1n };
    const dirtyCapability = {
      schema: 1,
      backend: "builtin",
      tier: "bujo",
      status: "ready",
      read: true,
      actions: true,
      graph: "captured",
      reason: `token=${credential}`,
      ...extra,
      toJSON: () => { throw new Error(`${rootPath} ${credential}`); },
    } as const;
    const dirtyRecord = {
      ...record,
      source: { conversationId: "web:conversation-1", ...extra },
      ...extra,
      toJSON: () => { throw new Error(`${rootPath} ${credential}`); },
    };
    const failedOperation = {
      id: "operation-failed",
      action: "forget" as const,
      recordId: record.id,
      status: "failed" as const,
      createdAt: "2026-08-24T10:01:00.000Z",
      updatedAt: "2026-08-24T10:01:01.000Z",
      errorCode: "invalid_request",
      errorMessage: `${rootPath} token=${credential}`,
      ...extra,
    };
    const queuedEdit = {
      id: "operation-edit",
      action: "edit" as const,
      recordId: record.id,
      status: "queued" as const,
      createdAt: "2026-08-24T10:02:00.000Z",
      updatedAt: "2026-08-24T10:02:00.000Z",
      resultRecordId: "memory-2",
      ...extra,
    };
    const queuedRestore = {
      ...queuedEdit,
      id: "operation-restore",
      action: "restore" as const,
    };
    running = await startTuiAdapter({
      responder,
      apiKey: "owner-key",
      memory: memoryService({
        capability: () => dirtyCapability as never,
        overview: () => ({
          generatedAt: "2026-08-24T10:00:00.000Z",
          capability: dirtyCapability,
          counts: {
            total: 1,
            active: 1,
            superseded: 0,
            forgotten: 0,
            byType: { task: 0, event: 0, note: 1, ...extra },
            ...extra,
          },
          access: { totalCount: 2, accessedRecords: 1, ...extra },
          embedding: { model: "text-embedding-safe", dimension: 256, ...extra },
          ...extra,
        } as never),
        records: () => ({ records: [dirtyRecord], ...extra } as never),
        record: () => ({
          record: dirtyRecord,
          history: [{
            id: "operation-history",
            action: "edit",
            status: "failed",
            recordId: record.id,
            resultRecordId: "memory-2",
            createdAt: "2026-08-24T09:00:00.000Z",
            completedAt: "2026-08-24T09:00:01.000Z",
            errorCode: "invalid_request",
            ...extra,
          }],
          ...extra,
        } as never),
        graph: () => ({
          fidelity: "captured",
          nodes: [
            {
              kind: "memory",
              id: record.id,
              label: record.text,
              lifecycle: "active",
              recordType: "note",
              ...extra,
            },
            {
              kind: "entity",
              id: "person:morgan",
              label: "Morgan",
              entityType: "person",
              summary: "Known collaborator",
              ...extra,
            },
          ],
          edges: [{
            source: record.id,
            target: "person:morgan",
            kind: "relation",
            label: "mentions",
            ...extra,
          }],
          ...extra,
        } as never),
        operation: () => failedOperation as never,
        edit: () => ({ kind: "queued", operation: queuedEdit, ...extra } as never),
        forget: () => ({
          kind: "confirmation_required",
          confirmation: {
            token: "confirm-token",
            expiresAt: "2026-08-24T10:06:00.000Z",
            message: `${rootPath} token=${credential}`,
            ...extra,
          },
          ...extra,
        } as never),
        restore: () => ({ kind: "queued", operation: queuedRestore, ...extra } as never),
      }),
    });
    const readHeaders = bearer();
    const actionHeaders = { ...readHeaders, "content-type": "application/json" };
    const action = (idempotencyKey: string) => JSON.stringify({
      expectedRevision: REVISION,
      idempotencyKey,
    });
    const responses = [
      await fetch(running.infoUrl, { headers: readHeaders }),
      await memoryFetch("", { headers: readHeaders }),
      await memoryFetch("/records", { headers: readHeaders }),
      await memoryFetch("/records/memory-1", { headers: readHeaders }),
      await memoryFetch("/graph", { headers: readHeaders }),
      await memoryFetch("/operations/operation-failed", { headers: readHeaders }),
      await memoryFetch("/records/memory-1", {
        method: "PATCH",
        headers: actionHeaders,
        body: JSON.stringify({
          expectedRevision: REVISION,
          idempotencyKey: "edit-clean-wire",
          patch: { text: "Projected edit" },
        }),
      }),
      await memoryFetch("/records/memory-1/forget", {
        method: "POST",
        headers: actionHeaders,
        body: action("forget-clean-wire"),
      }),
      await memoryFetch("/records/memory-1/restore", {
        method: "POST",
        headers: actionHeaders,
        body: action("restore-clean-wire"),
      }),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 202, 428, 202]);
    const exposed = (await Promise.all(responses.map(async (response) => await response.text()))).join("\n");
    expect(exposed).not.toContain(rootPath);
    expect(exposed).not.toContain(credential);
    expect(exposed).not.toContain("serializationTrap");
    expect(exposed).toContain("Memory operator capability is limited.");
    expect(exposed).toContain('"read":true');
    expect(exposed).toContain("Memory action was not valid for this record.");
    expect(exposed).toContain("Confirm this memory action?");
  });

  it("fails malformed service results closed with one sanitized 503 contract", async () => {
    const rootPath = "/Users/owner/private-memory.db";
    const credential = "sk-memory-secret";
    const loggerError = vi.fn();
    const graph = vi.fn<MemoryOperatorService["graph"]>();
    graph
      .mockReturnValueOnce({
        fidelity: "captured",
        nodes: [{
          kind: "memory",
          id: record.id,
          label: record.text,
          lifecycle: "active",
          recordType: "credential",
        }],
        edges: [],
      } as never)
      .mockReturnValueOnce({
        fidelity: "captured",
        nodes: [{
          kind: "memory",
          id: record.id,
          label: record.text,
          lifecycle: "active",
          recordType: "note",
        }],
        edges: [{ source: record.id, target: rootPath, kind: "supports", weight: 1 }],
      } as never);
    running = await startTuiAdapter({
      responder,
      apiKey: "owner-key",
      logger: { error: loggerError },
      memory: memoryService({
        overview: () => ({
          generatedAt: "2026-08-24T10:00:00.000Z",
          capability: memoryService().capability(),
          counts: { total: 2, active: 1, superseded: 0, forgotten: 0, byType: { task: 0, event: 0, note: 1 } },
          access: { totalCount: 1, accessedRecords: 1 },
          credential,
        } as never),
        records: () => ({ records: [{ ...record, revision: credential, rootPath }] } as never),
        record: () => ({
          record,
          history: [{
            id: "operation-history",
            action: "edit",
            status: "queued",
            recordId: record.id,
            createdAt: "2026-08-24T09:00:00.000Z",
            completedAt: "2026-08-24T09:00:01.000Z",
            credential,
          }],
        } as never),
        graph,
        operation: () => ({
          id: "operation-1",
          action: "forget",
          recordId: record.id,
          status: "failed",
          createdAt: "2026-08-24T10:00:00.000Z",
          updatedAt: "not-an-iso-timestamp",
          errorCode: "invalid_request",
          errorMessage: credential,
          rootPath,
        } as never),
        edit: () => ({
          kind: "queued",
          operation: {
            id: "operation-edit",
            action: "edit",
            recordId: record.id,
            status: "queued",
            createdAt: "2026-08-24T10:00:00.000Z",
            updatedAt: "2026-08-24T10:00:00.000Z",
            credential,
          },
        } as never),
        forget: () => ({
          kind: "confirmation_required",
          confirmation: {
            token: "invalid token",
            expiresAt: "2026-08-24T10:06:00.000Z",
            message: credential,
          },
        } as never),
        restore: () => ({ kind: "unknown", rootPath, credential } as never),
      }),
    });
    const readHeaders = bearer();
    const actionHeaders = { ...readHeaders, "content-type": "application/json" };
    const action = (idempotencyKey: string) => JSON.stringify({ expectedRevision: REVISION, idempotencyKey });
    const responses = [
      await memoryFetch("", { headers: readHeaders }),
      await memoryFetch("/records", { headers: readHeaders }),
      await memoryFetch("/records/memory-1", { headers: readHeaders }),
      await memoryFetch("/graph", { headers: readHeaders }),
      await memoryFetch("/graph", { headers: readHeaders }),
      await memoryFetch("/operations/operation-1", { headers: readHeaders }),
      await memoryFetch("/records/memory-1", {
        method: "PATCH",
        headers: actionHeaders,
        body: JSON.stringify({
          expectedRevision: REVISION,
          idempotencyKey: "edit-malformed-output",
          patch: { text: "Valid input" },
        }),
      }),
      await memoryFetch("/records/memory-1/forget", {
        method: "POST",
        headers: actionHeaders,
        body: action("forget-malformed-output"),
      }),
      await memoryFetch("/records/memory-1/restore", {
        method: "POST",
        headers: actionHeaders,
        body: action("restore-malformed-output"),
      }),
    ];
    expect(responses.every((response) => response.status === 503)).toBe(true);
    const exposed = JSON.stringify([
      await Promise.all(responses.map(async (response) => await response.json())),
      loggerError.mock.calls,
    ]);
    expect(exposed).not.toContain(rootPath);
    expect(exposed).not.toContain(credential);
    for (const response of responses) {
      expect(response.status).toBe(503);
    }
    expect(loggerError).toHaveBeenCalled();
    expect(loggerError.mock.calls.every((call) => (
      call[1] !== undefined
      && Object.keys(call[1]).length === 1
      && typeof call[1].category === "string"
    ))).toBe(true);
  });

  it("rejects malformed paths and non-exact query fields before invoking memory reads", async () => {
    const records = vi.fn<MemoryOperatorService["records"]>(() => ({ records: [record] }));
    const detail = vi.fn<MemoryOperatorService["record"]>(() => ({ record, history: [] }));
    const graph = vi.fn<MemoryOperatorService["graph"]>(() => ({ fidelity: "captured", nodes: [], edges: [] }));
    const operation = vi.fn<MemoryOperatorService["operation"]>(() => ({
      id: "operation-1",
      action: "edit",
      recordId: record.id,
      status: "queued",
      createdAt: "2026-08-24T10:01:00.000Z",
      updatedAt: "2026-08-24T10:01:00.000Z",
    }));
    const edit = vi.fn<MemoryOperatorService["edit"]>(() => { throw new Error("unexpected edit"); });
    const forget = vi.fn<MemoryOperatorService["forget"]>(() => { throw new Error("unexpected forget"); });
    const restore = vi.fn<MemoryOperatorService["restore"]>(() => { throw new Error("unexpected restore"); });
    running = await startTuiAdapter({
      responder,
      apiKey: "owner-key",
      memory: memoryService({ records, record: detail, graph, operation, edit, forget, restore }),
    });
    const headers = bearer();

    const invalidPaths = [
      `/records?q=${encodeURIComponent("🧠".repeat(513))}`,
      `/records?collection=${"a".repeat(129)}`,
      "/records?lifecycle=%20active",
      "/records?type=NOTE",
      "/records?limit=101",
      "/records?q=one&q=two",
      "/records?limit=1&limit=2",
      "/records?lifecyle=active",
      "/records/memory-1?includeHistory=true",
      `/records/${encodeURIComponent("🧠".repeat(513))}`,
      `/records/${encodeURIComponent("memory\u200b")}`,
      "/records/%E0%A4%A",
      `/graph?focusId=${encodeURIComponent("🧠".repeat(513))}`,
      `/graph?focusId=${encodeURIComponent("memory\u2028")}`,
      "/graph?includeHistory=1",
      "/graph?includeHistory=true&includeHistory=false",
      "/graph?focusId=one&focusId=two",
      "/graph?includeHistor=true",
      "/graph?limit=201",
      "?limit=1",
      `/operations/${encodeURIComponent("operation\u0000one")}`,
      "/operations/operation-1?limit=1",
    ];
    for (const path of invalidPaths) {
      const response = await memoryFetch(path, { headers });
      expect(response.status, path).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    }
    const actionHeaders = { ...headers, "content-type": "application/json" };
    const action = JSON.stringify({ expectedRevision: REVISION, idempotencyKey: "query-typo" });
    const invalidActions = [
      await memoryFetch("/records/memory-1?typo=true", {
        method: "PATCH",
        headers: actionHeaders,
        body: JSON.stringify({
          expectedRevision: REVISION,
          idempotencyKey: "edit-query-typo",
          patch: { text: "Valid edit" },
        }),
      }),
      await memoryFetch("/records/memory-1/forget?typo=true", {
        method: "POST",
        headers: actionHeaders,
        body: action,
      }),
      await memoryFetch("/records/memory-1/restore?typo=true", {
        method: "POST",
        headers: actionHeaders,
        body: action,
      }),
    ];
    expect(invalidActions.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(records).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("normalizes edits and maps direct queues, forget confirmation, and conflicts", async () => {
    const edit = vi.fn<MemoryOperatorService["edit"]>((_id, input) => ({
      kind: "queued",
      operation: {
        id: "operation-edit",
        action: "edit",
        recordId: record.id,
        status: "queued",
        createdAt: "2026-08-24T10:01:00.000Z",
        updatedAt: "2026-08-24T10:01:00.000Z",
        resultRecordId: "memory-2",
      },
    }));
    const restore = vi.fn<MemoryOperatorService["restore"]>(() => ({
      kind: "queued",
      operation: {
        id: "operation-restore",
        action: "restore",
        recordId: record.id,
        status: "queued",
        createdAt: "2026-08-24T10:02:00.000Z",
        updatedAt: "2026-08-24T10:02:00.000Z",
        resultRecordId: "memory-2",
      },
    }));
    running = await startTuiAdapter({
      responder,
      apiKey: "owner-key",
      memory: memoryService({
        edit,
        restore,
      }),
    });
    const headers = { ...bearer(), "content-type": "application/json" };

    const edited = await memoryFetch("/records/memory-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: REVISION,
        idempotencyKey: "edit:key-1",
        patch: {
          text: "  Ｐrefers short summaries  ",
          type: "note",
          tags: ["  ｐreference  "],
          salience: 1,
          collection: "  My_Notes  ",
          dueAt: null,
          validFrom: "2026-08-24T10:00:00.000Z",
        },
      }),
    });
    expect(edited.status).toBe(202);
    expect(edit).toHaveBeenCalledWith("memory-1", {
      expectedRevision: REVISION,
      idempotencyKey: "edit:key-1",
      patch: {
        text: "Prefers short summaries",
        type: "note",
        tags: ["preference"],
        salience: 1,
        collection: "my-notes",
        dueAt: null,
        validFrom: "2026-08-24T10:00:00.000Z",
      },
    });

    const confirmation = await memoryFetch("/records/memory-1/forget", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: REVISION, idempotencyKey: "forget-1" }),
    });
    expect(confirmation.status).toBe(428);

    const restored = await memoryFetch("/records/memory-1/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: REVISION, idempotencyKey: "restore-1" }),
    });
    expect(restored.status).toBe(202);

    restore.mockImplementationOnce(() => {
      throw new MemoryOperatorError(
        "revision_conflict",
        "Memory changed at /Users/owner/private-memory.db; token=sk-memory-secret",
      );
    });
    const conflict = await memoryFetch("/records/memory-1/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: REVISION, idempotencyKey: "restore-2" }),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json();
    expect(conflictBody).toEqual({
      error: { code: "revision_conflict", message: "Memory record changed; refresh and retry." },
    });
    expect(JSON.stringify(conflictBody)).not.toContain("/Users/owner");
    expect(JSON.stringify(conflictBody)).not.toContain("sk-memory-secret");
  });

  it("accepts code-point maxima and rejects malformed edit fields before runtime admission", async () => {
    const edit = vi.fn<MemoryOperatorService["edit"]>(() => ({
      kind: "queued",
      operation: {
        id: "operation-edit",
        action: "edit",
        recordId: record.id,
        status: "queued",
        createdAt: "2026-08-24T10:01:00.000Z",
        updatedAt: "2026-08-24T10:01:00.000Z",
        resultRecordId: "memory-2",
      },
    }));
    running = await startTuiAdapter({ responder, apiKey: "owner-key", memory: memoryService({ edit }) });
    const headers = { ...bearer(), "content-type": "application/json" };

    const maxTags = Array.from({ length: 32 }, (_, index) => (
      index === 0 ? "🧠".repeat(64) : `tag-${String(index)}`
    ));
    const accepted = await memoryFetch("/records/memory-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: REVISION,
        idempotencyKey: "k".repeat(200),
        patch: {
          text: "🧠".repeat(4_000),
          tags: maxTags,
          collection: "A".repeat(128),
          salience: 0,
          validFrom: null,
        },
      }),
    });
    expect(accepted.status).toBe(202);
    expect(edit).toHaveBeenCalledTimes(1);

    const base = (patch: Record<string, unknown>, extras: Record<string, unknown> = {}) => ({
      expectedRevision: REVISION,
      idempotencyKey: "edit-invalid",
      patch,
      ...extras,
    });
    const invalidBodies: ReadonlyArray<readonly [string, string]> = [
      ["uppercase revision", JSON.stringify({ ...base({ text: "valid" }), expectedRevision: "A".repeat(64) })],
      ["long revision", JSON.stringify({ ...base({ text: "valid" }), expectedRevision: "a".repeat(65) })],
      ["idempotency prefix", JSON.stringify({ ...base({ text: "valid" }), idempotencyKey: "_invalid" })],
      ["idempotency length", JSON.stringify({ ...base({ text: "valid" }), idempotencyKey: "a".repeat(201) })],
      ["empty patch", JSON.stringify(base({}))],
      ["unknown patch key", JSON.stringify(base({ text: "valid", unknown: true }))],
      ["unknown action key", JSON.stringify(base({ text: "valid" }, { unknown: true }))],
      ["record type", JSON.stringify(base({ type: "memo" }))],
      ["text length", JSON.stringify(base({ text: "x".repeat(4_001) }))],
      ["text control", JSON.stringify(base({ text: "unsafe\u200btext" }))],
      ["text delimiter", JSON.stringify(base({ text: "unsafe<!--mem payload" }))],
      ["tag count", JSON.stringify(base({ tags: Array.from({ length: 33 }, (_, index) => `tag-${String(index)}`) }))],
      ["tag length", JSON.stringify(base({ tags: ["x".repeat(65)] }))],
      ["tag normalization duplicate", JSON.stringify(base({ tags: ["tag", "ｔａｇ"] }))],
      ["tag control", JSON.stringify(base({ tags: ["unsafe\u2029tag"] }))],
      ["collection grammar", JSON.stringify(base({ collection: "not/a-slug" }))],
      ["collection length", JSON.stringify(base({ collection: "a".repeat(129) }))],
      ["salience range", JSON.stringify(base({ salience: -0.01 }))],
      ["salience finite", `{"expectedRevision":"${REVISION}","idempotencyKey":"edit-invalid","patch":{"salience":1e309}}`],
      ["dueAt canonical", JSON.stringify(base({ dueAt: "2026-08-24T10:00:00Z" }))],
      ["validFrom type", JSON.stringify(base({ validFrom: 1 }))],
    ];
    for (const [label, body] of invalidBodies) {
      const response = await memoryFetch("/records/memory-1", { method: "PATCH", headers, body });
      expect(response.status, label).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(edit).toHaveBeenCalledTimes(1);

    const cleared = await memoryFetch("/records/memory-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: REVISION,
        idempotencyKey: "edit-clear",
        patch: { tags: [], collection: null, dueAt: null, validFrom: null },
      }),
    });
    expect(cleared.status).toBe(202);
    expect(edit).toHaveBeenLastCalledWith("memory-1", {
      expectedRevision: REVISION,
      idempotencyKey: "edit-clear",
      patch: { tags: [], collection: null, dueAt: null, validFrom: null },
    });
  });

  it("allows only forget to expose a confirmation-required status", async () => {
    const challenge = () => ({
      kind: "confirmation_required" as const,
      confirmation: {
        token: "unexpected",
        expiresAt: "2026-08-24T10:06:00.000Z",
        message: "Unexpected confirmation",
      },
    });
    running = await startTuiAdapter({
      responder,
      apiKey: "owner-key",
      memory: memoryService({ edit: challenge, restore: challenge }),
    });
    const headers = { ...bearer(), "content-type": "application/json" };
    const editResponse = await memoryFetch("/records/memory-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: REVISION,
        idempotencyKey: "edit-unexpected",
        patch: { text: "valid" },
      }),
    });
    expect(editResponse.status).toBe(503);

    const restoreResponse = await memoryFetch("/records/memory-1/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: REVISION, idempotencyKey: "restore-unexpected" }),
    });
    expect(restoreResponse.status).toBe(503);

    const forgetResponse = await memoryFetch("/records/memory-1/forget", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: REVISION, idempotencyKey: "forget-confirm" }),
    });
    expect(forgetResponse.status).toBe(428);
  });

  it("does not expose an unexpected provider or filesystem failure", async () => {
    const rootPath = "/Users/owner/private-memory.db";
    const credential = "sk-memory-secret";
    const loggerError = vi.fn();
    running = await startTuiAdapter({
      responder,
      logger: { error: loggerError },
      memory: memoryService({
        overview: () => { throw new Error(`sqlite failed at ${rootPath}; token=${credential}`); },
      }),
    });

    const response = await memoryFetch("");
    expect(response.status).toBe(503);
    const body = JSON.stringify([await response.json(), loggerError.mock.calls]);
    expect(body).toContain("temporarily unavailable");
    expect(body).not.toContain(rootPath);
    expect(body).not.toContain(credential);
    expect(body).not.toContain("sqlite");
    expect(loggerError).toHaveBeenCalledWith(
      "Memory operator request failed.",
      { category: "unexpected_failure" },
    );
  });
});
