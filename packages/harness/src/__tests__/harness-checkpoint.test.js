import { afterEach, expect, it } from "vitest";
import { mkdtemp, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { JsonlSessionRepo } from "../session-store.js";
import { buildHarnessSessionContext } from "../session-context.js";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each([false, true])("replays the exact checkpoint after process reopen including signed pairs, split-derived and imported context (import=%s)", async (legacy) => {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-exact-")); roots.push(root); const repo = new JsonlSessionRepo({ sessionsRoot: root });
  let session;
  if (legacy) { await mkdir(join(root, "legacy")); await copyFile(new URL("./fixtures/legacy-v4.jsonl", import.meta.url), join(root, "legacy", "fixture_fixture-session.jsonl")); session = await repo.open((await repo.list())[0]); }
  else session = await repo.create({ id: "checkpoint" });
  const user = { role: "user", content: [{ type: "text", text: "Fictional signed-tool request" }], timestamp: 1 };
  const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "Fictional reasoning", thinkingSignature: "fictional-signature", opaque: { marker: "preserved" } }, { type: "toolCall", id: "pair", name: "Read", arguments: { path: "fictional.txt" } }], stopReason: "toolUse", api: "openai-responses", provider: "faux", model: "fictional", timestamp: 2 };
  const outcome = { role: "toolResult", toolCallId: "pair", toolName: "Read", isError: false, content: [{ type: "text", text: "Fictional observed result" }], timestamp: 3 };
  await session.appendMessage(user); await session.appendMessage(assistant); await session.appendMessage(outcome);
  const before = await session.getEntries(); const native = before.filter((entry) => entry.type === "message");
  const derived = { role: "user", content: "Fictional split-turn continuation", timestamp: 4, projectionOnly: true };
  const kept = native.map((entry) => entry.message); kept.push(derived);
  await session.beginTurn("synthetic:checkpoint"); await session.openOperation("checkpoint-op", { model: { provider: "faux", id: "fictional", api: "openai-responses" } }, "compaction", "manual");
  await session.appendCompaction({ summary: "Exact fictional checkpoint", retainedTail: kept, tokensBefore: 900, tokensAfter: 120, details: { fixture: "exact" } });
  await session.sync(); await session.closeOperation("checkpoint-op", "completed"); await session.endTurn("synthetic:checkpoint", "completed"); await session.sync();
  const entries = await session.getEntries(); const messages = buildHarnessSessionContext(entries); const checkpoint = entries.at(-1).checkpoint;
  expect(checkpoint).toMatchObject({ version: 1, tokensBefore: 900, tokensAfter: 120, projectionVersion: 1,
    preservedMessageIds: native.map((entry) => entry.id), derivedMessages: [derived], coverage: { sourceEntryCount: before.length }, model: { id: "fictional" } });
  const bytes = await readFile(session.metadata.path); await session.close();
  const child = fork(new URL("./fixtures/checkpoint-worker.mjs", import.meta.url), [root], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try { const [reopened] = await once(child, "message"); await once(child, "exit"); expect(reopened).toEqual({ messages, checkpoint }); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  expect((await readFile(session.metadata.path)).equals(bytes)).toBe(true); // no fresh timestamp, summary or repair call
});
