import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("round-trips canonical and tool history through built producers and a fresh read process", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-round-trip-"));
  const entry = new URL("../../dist/index.js", import.meta.url).href;
  try {
    const producer = await execute(process.execPath, ["--eval", `(async () => {
      const [entry, root] = process.argv.slice(1);
      const api = await import(entry);
      const store = api.createDurableHistoryStore({ root });
      await store.append("morgan#2026-01-02", [{ role: "user", content: "Hello, world." }]);
      const handle = await api.acquireToolHistoryWriter({ root, persistenceCeilingMs: 5000 });
      const binding = { conversationId: "morgan#2026-01-02", logicalConversationId: "morgan", runId: "round-trip", isolated: false };
      try {
        const invocation = await handle.writer.persist(binding, { phase: "invocation", toolCallId: "call-1", toolName: "Read", arguments: { query: "fixture" } });
        const result = await handle.writer.persist(binding, { phase: "result", toolCallId: "call-1", state: "success", content: "Fixture result." });
        await handle.writer.finishRun(binding, "success");
        if (invocation.persistence !== "persisted" || result.persistence !== "persisted") throw new Error("Fixture writes did not settle");
        console.log(JSON.stringify({ invocationId: invocation.recordId, resultId: result.recordId }));
      } finally { await handle.release(); }
    })().catch((error) => { console.error(error); process.exitCode = 1; });`, entry, root], { timeout: 20_000 });
    const consumer = await execute(process.execPath, ["--eval", `(async () => {
      const [entry, root] = process.argv.slice(1);
      const api = await import(entry);
      const store = api.createDurableHistoryStore({ root });
      const history = await store.load("morgan#2026-01-02");
      const reader = new api.ToolHistoryReader(root);
      const page = reader.search({ logicalConversationId: "morgan", currentConversationId: "morgan#2026-01-03", currentRunId: "read-only" });
      console.log(JSON.stringify({ history, calls: page.items, databasePath: reader.databasePath.endsWith("/tool-history/tool-lifecycles.sqlite") }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });`, entry, root], { timeout: 20_000 });
    const ids = JSON.parse(producer.stdout);
    const read = JSON.parse(consumer.stdout);
    expect(read.history).toEqual([{ role: "user", content: "Hello, world." }]);
    expect(read.databasePath).toBe(true);
    expect(read.calls).toHaveLength(1);
    expect(read.calls[0]).toMatchObject({ recordId: ids.invocationId, resultRecordId: ids.resultId, toolCallId: "call-1", state: "success" });
    expect(ids.invocationId).toMatch(/^sth1_/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
