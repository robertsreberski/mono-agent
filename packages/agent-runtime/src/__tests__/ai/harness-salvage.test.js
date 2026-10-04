import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, afterEach } from "vitest";
import { JsonlSessionRepo } from "@mono-agent/harness";
const roots = [];
async function root() { const r = await mkdtemp(join(tmpdir(), "harness-salvage-")); roots.push(r); return r; }
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive:true, force:true }); });
it("salvages owned paired tool evidence without executing an unfinished turn", async () => {
  const { salvageDurableNativeSession } = await import("../../ai/providers/pi-native/session-salvage.js");
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r });
  const s = await repo.create({ id: "salvage-fixture" });
  await s.beginTurn("interrupted", {});
  await s.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "Read", arguments: {} }], stopReason: "toolUse", timestamp: 1700000000000 });
  await s.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "Read", content: [{ type: "text", text: "Fictional evidence." }], isError: false, timestamp: 1700000000001 });
  await s.close();
  const bytes = await readFile(s.metadata.path);
  const evidence = await salvageDurableNativeSession("salvage-fixture", r);
  expect(evidence.completed).toEqual([{ name: "Read", result: "Fictional evidence." }]);
  expect(evidence.outcomeUnknown).toEqual([]);
  expect(evidence.additionalOutcomesUnknown).toBe(true);
  expect(await readFile(s.metadata.path)).toEqual(bytes);
});
