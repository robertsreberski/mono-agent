import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleToolScope } from "../console-tools.js";
import type { WebAgentSummary } from "../contracts.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const agent = (sourceId: string): WebAgentSummary => ({
  sourceId, label: sourceId, status: "online", health: "running", models: ["provider/default"],
  defaultModel: "provider/default", efforts: [], updatedAt: "2001-01-01T00:00:00.000Z", supportsAttachments: true,
  runSettings: { config: { model: "provider/default" }, override: null, effective: { model: "provider/default", modelSource: "config", effortSource: "config" } },
});
async function fixture() {
  const root = await temporaryRoot(); roots.push(root);
  let now = "2001-01-01T00:00:00.000Z";
  const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
  store.replaceAgents([agent("agent-one"), agent("agent-two")]);
  const origin = store.createThread("agent-one");
  const turn = store.beginTurn({ threadId: origin.id, text: "Search the archive", attachmentIds: [] });
  const scope = { sourceId: "agent-one", threadId: origin.id, turnId: turn.turnId, datedSnippets: true as const };
  const search = (args: Record<string, unknown>, capability: ConsoleToolScope = scope) => store.consoleToolOperation(capability, {
    operationId: randomUUID(), tool: "SearchConversations", args,
  });
  const conversation = (text: string, reply: string, at = now, source = "agent-one") => {
    now = at;
    const thread = store.createThread(source);
    const admitted = store.beginTurn({ threadId: thread.id, text, attachmentIds: [] });
    store.completeTurn(admitted.turnId, reply);
    // Deliberately keep the title from repeating the query.
    store.patchThread(thread.id, { title: "Archive record" });
    return { thread, admitted };
  };
  const database = (store as unknown as { database: DatabaseSync }).database;
  return { store, scope, search, conversation, database, setTime: (at: string) => { now = at; } };
}
type Row = { id: string; snippet?: string; match?: { kind: string; messageId?: string; role?: string; createdAt?: string; snippet?: string; consoleUrl: string } };
const rows = (result: Record<string, unknown>) => result.conversations as Row[];

describe("owner-web dated SearchConversations", () => {
  it("keeps the legacy/UI path and fields unchanged, gates rich calls, and writes no receipts", async () => {
    const f = await fixture();
    try {
      f.conversation("Morgan repaired a bicycle wheel", "The bicycle wheel spins evenly");
      const legacyScope = { sourceId: f.scope.sourceId, threadId: f.scope.threadId, turnId: f.scope.turnId };
      const legacy = f.search({ query: "bicycle" }, legacyScope);
      expect(legacy).toEqual(f.search({ query: "bicycle" }));
      expect(rows(legacy.result)[0]).not.toHaveProperty("match");
      const ui = f.store.searchThreads({ sourceId: "agent-one", query: "bicycle", scope: "chats" });
      expect(ui.hits.map((hit) => hit.thread.id)).toEqual(rows(legacy.result).map((row) => row.id));
      expect(ui.hits[0]).not.toHaveProperty("messageMatch");
      for (const args of [{ query: "bicycle", dated: true }, { query: "bicycle", after: "2001-01-01" }, { query: "bicycle", role: "user" }]) {
        expect(() => f.search(args, legacyScope)).toThrowError(expect.objectContaining({ code: "conversation_search_unavailable", message: "conversation_search_unavailable" }));
        expect(() => f.search(args, { kind: "external", sourceId: "agent-one", channel: "telegram", turnKey: "turn-00000001", pid: 1 }))
          .toThrowError(expect.objectContaining({ code: "conversation_search_unavailable" }));
      }
      expect(f.search({ query: "bicycle", dated: true })).toMatchObject({ projects: [], threads: [], tags: [], deletedProjects: [], deletedTags: [] });
      expect(f.database.prepare("SELECT count(*) AS n FROM console_tool_operations").get()).toEqual({ n: 0 });
      f.store.completeTurn(f.scope.turnId, "Finished searching");
      expect(() => f.search({ query: "bicycle", dated: true })).toThrowError(expect.objectContaining({ code: "console_tool_revoked" }));
    } finally { f.store.close(); }
  });

  it("uses matched message creation dates (inclusive UTC), filters role before ranking, and labels title-only hits", async () => {
    const f = await fixture();
    try {
      const early = f.conversation("Avery chose a pottery class", "Pottery uses a rotating wheel", "2001-02-01T23:59:59.000Z");
      const later = f.store.beginTurn({ threadId: early.thread.id, text: "A new puzzle", attachmentIds: [] });
      f.setTime("2001-03-01T00:00:00.000Z");
      f.store.completeTurn(later.turnId, "Another puzzle");
      const late = f.conversation("Pottery glazing practice", "Pottery tiles dried evenly", "2001-02-02T00:00:00.000Z");
      const title = f.conversation("A sketch of a kite", "The kite has a long tail");
      f.store.patchThread(title.thread.id, { title: "Pottery notes" });
      expect(rows(f.search({ query: "pottery", dated: true }).result).find((row) => row.id === title.thread.id)?.match)
        .toEqual({ kind: "title", consoleUrl: `/?thread=${title.thread.id}` });
      const bounded = rows(f.search({ query: "pottery", after: "2001-02-01", before: "2001-02-01", role: "user" }).result);
      expect(bounded.map((row) => row.id)).toEqual([early.thread.id]);
      expect(bounded[0]?.match).toMatchObject({ kind: "message", role: "user", messageId: early.admitted.userMessageId, createdAt: "2001-02-01T23:59:59.000Z" });
      const assistant = rows(f.search({ query: "pottery", after: "2001-02-02", role: "assistant" }).result);
      expect(assistant.map((row) => row.id)).toEqual([late.thread.id]);
      expect(assistant[0]?.match).toMatchObject({ role: "assistant", messageId: late.admitted.assistantMessageId });
      for (const row of [...bounded, ...assistant]) {
        const message = f.store.getMessage(row.match!.messageId!)!;
        expect(row.match).toMatchObject({ role: message.role, createdAt: message.createdAt, consoleUrl: `/?thread=${encodeURIComponent(message.threadId)}` });
        expect(new URL(row.match!.consoleUrl, "https://console.invalid").searchParams.get("thread")).toBe(message.threadId);
        expect(row.snippet).not.toMatch(/[\u0002\u0003]/u);
      }
      for (const args of [{ after: "2001-02-29" }, { after: "2001-02-03", before: "2001-02-01" }, { role: "system" }, { dated: "yes" }]) {
        expect(() => f.search({ query: "pottery", ...args })).toThrowError(expect.objectContaining({ code: "invalid_conversation_search", message: "invalid_conversation_search" }));
      }
    } finally { f.store.close(); }
  });

  it("excludes foreign, notification, imported and synthetic rows before the scan cap", async () => {
    const f = await fixture();
    try {
      const retained = f.conversation("A bicycle brake adjustment", "The cable is secure", "2001-06-01T12:00:00.000Z");
      const excluded = f.conversation("Bicycle brake", "Bicycle brake", "2001-05-01T12:00:00.000Z", "agent-two");
      const triggered = f.conversation("Bicycle brake", "Bicycle brake");
      f.database.prepare("UPDATE threads SET trigger_kind = 'webhook' WHERE id = ?").run(triggered.thread.id);
      const cron = f.conversation("Bicycle brake", "Bicycle brake");
      f.database.prepare("UPDATE threads SET trigger_kind = 'cron' WHERE id = ?").run(cron.thread.id);
      const imported = f.store.createThread("agent-one");
      f.database.prepare("INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status) VALUES (?, ?, NULL, 'user', ?, ?, ?, 'complete')")
        .run(randomUUID(), imported.id, JSON.stringify([{ type: "text", text: "Bicycle brake" }]), "2001-06-01T12:00:00.000Z", "2001-06-01T12:00:00.000Z");
      const wake = f.store.createThread("agent-one");
      const synthetic = f.store.beginAssistantTurn({ threadId: wake.id, prompt: "Bicycle brake" });
      f.store.completeTurn(synthetic.turnId, "Bicycle brake");
      const unknown = f.conversation("Bicycle brake", "Bicycle brake");
      f.database.prepare("UPDATE messages SET parts_json = ? WHERE id = ?")
        .run(JSON.stringify([{ type: "text", text: "Bicycle brake" }, { type: "telemetry", event: "imported", data: {} }]), unknown.admitted.userMessageId);
      // Enough high-ranking but out-of-date owner rows to exhaust the legacy scan.
      const old = f.conversation("Bicycle brake", "Bicycle brake", "2001-05-01T00:00:00.000Z");
      const insert = f.database.prepare("INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status) VALUES (?, ?, ?, 'user', ?, ?, ?, 'complete')");
      for (let i = 0; i < 410; i++) insert.run(randomUUID(), old.thread.id, old.admitted.turnId,
        JSON.stringify([{ type: "text", text: "Bicycle brake" }]), "2001-05-01T00:00:00.000Z", "2001-05-01T00:00:00.000Z");
      const found = f.search({ query: "bicycle brake", after: "2001-06-01", role: "user", limit: 1 }).result;
      expect(rows(found).map((row) => row.id)).toEqual([retained.thread.id]);
      expect(found.truncated).toBe(false);
      expect(rows(f.search({ query: "bicycle brake", role: "assistant" }).result).map((row) => row.id)).toEqual([old.thread.id]);
      const steered = f.conversation("A human bicycle brake question", "Bicycle brake result");
      f.database.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run(JSON.stringify([
        { type: "process-job-wake", jobId: "11111111-1111-4111-8111-111111111111", deliveryKey: "fixture-job-wake", disposition: "steered" },
        { type: "text", text: "Bicycle brake result" },
      ]), steered.admitted.assistantMessageId);
      expect(rows(f.search({ query: "bicycle brake", role: "assistant" }).result).map((row) => row.id)).not.toContain(steered.thread.id);
      const unfiltered = rows(f.search({ query: "bicycle brake", dated: true, limit: 50 }).result);
      for (const item of [excluded, triggered, cron, unknown]) expect(unfiltered.map((row) => row.id)).not.toContain(item.thread.id);
      for (const id of [imported.id, wake.id]) expect(unfiltered.map((row) => row.id)).not.toContain(id);
      expect(() => f.search({ query: "bicycle", dated: true }, { ...f.scope, sourceId: "agent-two" }))
        .toThrowError(expect.objectContaining({ code: "console_tool_revoked" }));
    } finally { f.store.close(); }
  });

  it("bounds snippets and defaults rich model results to ten while legacy remains twenty", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 21; i++) f.conversation(`Mosaic practice ${String(i)} ${"🎨".repeat(500)}`, "The samples dried");
      const rich = f.search({ query: "mosaic", dated: true }).result;
      expect(rows(rich)).toHaveLength(10);
      expect(rich.truncated).toBe(true);
      expect(rows(rich).some((row) => Array.from(row.match!.snippet!).length === 320)).toBe(true);
      expect(rows(f.search({ query: "mosaic" }).result)).toHaveLength(20);
      for (const row of rows(rich)) {
        expect(row.match?.kind).toBe("message");
        expect(Array.from(row.match!.snippet!).length).toBeLessThanOrEqual(320);
        expect(row.match?.snippet).toBe(row.snippet);
      }
    } finally { f.store.close(); }
  });

  it("scrubs internal rich-search failures to a stable code", async () => {
    const f = await fixture();
    const fault = vi.spyOn(f.store, "searchThreads").mockImplementation(() => { throw new Error("fictional record diagnostics"); });
    try {
      expect(() => f.search({ query: "pottery", dated: true }))
        .toThrowError(expect.objectContaining({ code: "conversation_search_failed", message: "conversation_search_failed" }));
    } finally { fault.mockRestore(); f.store.close(); }
  });

  it("achieves Recall@10 >=90% on a labelled fictional multilingual thread set", async () => {
    const f = await fixture();
    try {
      const cases = [
        ["bicycle", "Morgan adjusted a bicycle spoke"], ["pottery", "Avery joined a pottery class"],
        ["origami", "A paper origami crane unfolded"], ["astronomy", "Astronomy charts show distant stars"],
        ["chess", "A chess puzzle needs a rook move"], ["mosaic", "A mosaic uses small blue tiles"],
        ["vélo", "Morgan répare un vélo bleu"], ["cerámica", "Avery practica cerámica azul"],
        ["Fahrrad", "Morgan prüft ein Fahrrad"], ["陶芸", "Avery 陶芸 教室"],
        ["пазл", "Morgan собирает пазл"], ["فسيفساء", "Avery يصنع فسيفساء"],
      ] as const;
      const labels = cases.map(([query, prose]) => ({ query, ids: [
        f.conversation(prose, "The exercise is complete").thread.id,
        f.conversation(`Notebook: ${prose}`, "Another exercise is complete").thread.id,
      ] }));
      for (let i = 0; i < 25; i++) f.conversation(`Neutral geometry practice ${String(i)}`, "A triangle has three sides");
      let recalled = 0, relevant = 0;
      for (const label of labels) {
        const found = rows(f.search({ query: label.query, dated: true }).result);
        relevant += label.ids.length;
        recalled += label.ids.filter((id) => found.some((row) => row.id === id)).length;
        for (const row of found) {
          const message = f.store.getMessage(row.match!.messageId!)!;
          expect(row.match).toMatchObject({ kind: "message", role: message.role, createdAt: message.createdAt, consoleUrl: `/?thread=${message.threadId}` });
        }
      }
      expect(relevant).toBe(24);
      expect(recalled / relevant).toBeGreaterThanOrEqual(0.9);
      expect(recalled).toBe(24);
    } finally { f.store.close(); }
  });
});
