import { mkdtemp, readFile, rm, writeFile, mkdir, appendFile, copyFile, chmod } from "node:fs/promises";
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
  expect((await readFile(s.metadata.path)).equals(bytes)).toBe(true);
});

it("salvages large v2 journals read-only with bounded result excerpts", async () => {
  const { salvageDurableNativeSession } = await import("../../ai/providers/pi-native/session-salvage.js");
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r }); const s = await repo.create({ id: "large-salvage" });
  await s.beginTurn("synthetic:large-salvage");
  for (let i = 0; i < 12; i++) await s.appendMessage({ role: "user", content: "x".repeat(3 * 1024 * 1024), timestamp: i });
  await s.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "Read", arguments: {} }], timestamp: 13 });
  await s.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "Read", content: [{ type: "text", text: "y".repeat(5000) }], isError: false, timestamp: 14 });
  await s.close();
  const bytes = await readFile(s.metadata.path);
  const evidence = await salvageDurableNativeSession("large-salvage", r);
  expect(evidence.completed).toEqual([{ name: "Read", result: "y".repeat(4096) }]);
  expect(evidence.additionalOutcomesUnknown).toBe(true);
  expect((await readFile(s.metadata.path)).equals(bytes)).toBe(true);
});

it("salvages the requested v2 ID despite unrelated malformed, insecure and non-file journals", async () => {
  const { salvageDurableNativeSession } = await import("../../ai/providers/pi-native/session-salvage.js");
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r }); const session = await repo.create({ id: "requested" });
  await session.close(); const bytes = await readFile(session.metadata.path); const directory = join(r, "mono-v2", "journals");
  await writeFile(join(directory, "malformed.jsonl"), "not-json\n", { mode: 0o600 });
  await writeFile(join(directory, "insecure.jsonl"), bytes, { mode: 0o644 }); await mkdir(join(directory, "directory.jsonl"));
  expect((await salvageDurableNativeSession("requested", r)).completed).toEqual([]);
  await expect(salvageDurableNativeSession("missing", r)).rejects.toThrow();
  expect((await readFile(session.metadata.path)).equals(bytes)).toBe(true);
});

it.each(["insecure", "corrupt", "non-file"])("fails closed instead of salvaging a clean-break legacy source when v2 is %s", async (damage) => {
  const { salvageDurableNativeSession } = await import("../../ai/providers/pi-native/session-salvage.js");
  const r = await root(); await mkdir(join(r, "legacy")); const source = join(r, "legacy", "fixture_fixture-session.jsonl");
  await copyFile(new URL("../../../../harness/src/__tests__/fixtures/legacy-v4.jsonl", import.meta.url), source);
  await appendFile(source, JSON.stringify({ kind: "value", op: "set", seq: 6, namespace: "pi.op.meta", key: "open", value: {} }) + "\n");
  const legacyBytes = await readFile(source); const repo = new JsonlSessionRepo({ sessionsRoot: r }); const session = await repo.open((await repo.list())[0]);
  expect(session.continuity).toBe("clean_break"); const path = session.metadata.path; await session.close();
  if (damage === "insecure") await chmod(path, 0o644);
  else if (damage === "corrupt") await writeFile(path, "not-json\n");
  else { await rm(path); await mkdir(path); }
  await expect(salvageDurableNativeSession("fixture-session", r)).rejects.toThrow("salvage unavailable");
  expect((await readFile(source)).equals(legacyBytes)).toBe(true);
});
