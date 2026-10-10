import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { WebService } from "../service.js";
import { INTERRUPTED_QUESTION_NOTE } from "../store.js";
import { fakeDiscoveredAgent, temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))); });

it("a parent-interruption wake after an interrupted AskUser suppresses interaction tools and carries the notes", async () => {
  const root = await temporaryRoot(); roots.push(root);
  const encoder = new TextEncoder();
  let discovered = fakeDiscoveredAgent({ apiKey: "fixture-key" });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let failLiveInput!: (error: Error) => void;
  const turnBodies: Array<{ text: string; metadata: { web: Record<string, unknown> } }> = [];
  const service = await WebService.create({
    stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [discovered],
    fetchImpl: (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) {
        return Response.json({ schema: 1, pid: discovered.source.pid, capabilities: { askUser: true, liveInput: true } });
      }
      if (url.endsWith("/v1/turns")) {
        turnBodies.push(JSON.parse(String(init?.body)));
        return turnBodies.length === 1
          ? new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
            { headers: { "content-type": "application/x-ndjson" } })
          : new Response(JSON.stringify({ kind: "finish", finalText: "Inspected." }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.endsWith("/live-input")) return await new Promise<Response>((_, reject) => { failLiveInput = reject; });
      if (url.includes("/ask")) return new Response(null, { status: 404 });
      throw new Error(`Unexpected fake request: ${url}`);
    }) as typeof fetch,
  });
  try {
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Fictional task that asks a question." });
    await vi.waitFor(() => expect(stream).toBeDefined());
    stream.enqueue(encoder.encode(JSON.stringify({ kind: "event", event: { type: "tool_call_started", id: "fictional-ask", name: "AskUser",
      arguments: { message: "Fictional question." } } }) + "\n"));
    await vi.waitFor(() => expect(service.thread(thread.id).messages.at(-1)?.parts.some((part) => part.type === "tool-call")).toBe(true));
    expect(service.submitLiveInput(thread.id, "Fictional mid-turn note.").disposition).toBe("pending");
    await vi.waitFor(() => expect(failLiveInput).toBeDefined());
    // SIGKILL equivalent: the stream and the live-input request both drop.
    stream.error(new Error("terminated"));
    failLiveInput(new Error("terminated"));
    await vi.waitFor(() => expect(service.store.getThread(thread.id)?.runState.error?.code).toBe("agent_connection_lost"));
    await vi.waitFor(() => expect(service.thread(thread.id).messages.some((message) => message.liveInputStatus === "uncertain")).toBe(true));
    expect(turnBodies).toHaveLength(1);

    discovered = { ...discovered, source: { ...discovered.source, pid: 456, startedAt: "2026-07-17T10:00:00.000Z" } };
    await service.refreshAgents();
    await vi.waitFor(() => expect(turnBodies).toHaveLength(2));
    const wake = turnBodies[1]!;
    expect(wake.metadata.web.suppressInteractionTools).toBe(true);
    expect(turnBodies[0]!.metadata.web.suppressInteractionTools).toBeUndefined();
    expect(wake.text).toContain("Inspect background jobs and subagents with AgentManage inspect");
    expect(wake.text).toContain(INTERRUPTED_QUESTION_NOTE);
    expect(wake.text).toContain("Do not re-ask the interrupted question; the user will answer in a new message.");
    expect(wake.text).toContain("Some messages sent during the previous turn (1 total) were not confirmed as applied and were not replayed.");
    await vi.waitFor(() => expect(service.store.activeTurn(thread.id)).toBeUndefined());
    await service.refreshAgents();
    expect(turnBodies).toHaveLength(2);
    const notes = service.thread(thread.id).messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "text" && part.text === INTERRUPTED_QUESTION_NOTE);
    expect(notes).toHaveLength(1);
    const db = new DatabaseSync(service.store.paths.database, { readOnly: true });
    try { expect(db.prepare("SELECT state FROM parent_turn_interruptions").all()).toEqual([{ state: "completed" }]); }
    finally { db.close(); }
  } finally { await service.stop(); }
});
