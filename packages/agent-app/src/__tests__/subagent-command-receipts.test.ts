import { boundSubagentCommandReceipts, type DurableProcessJobRecord } from "../process-jobs-store.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { emptySubagentCommandReceipts, isSubagentCommandReceipts, retainSubagentCommandReceipt, subagentCommandReceipt, SUBAGENT_COMMAND_RECEIPTS_MAX_BYTES } from "../subagent-command-receipts.js";
import type { SubagentOwnedCommand } from "../subagent-execution-ownership.js";
const command = (): SubagentOwnedCommand => ({ id: randomUUID(), callKey: "1:opaque", tool: "Exec", cwd: "/workspace", state: "released",
  pid: null, pgid: null, incarnation: null, sandboxSettingsPath: null, deadlineAt: 5000, budgetMs: 3000 });
it("retains bounded counts independently from non-evicting execution identities", () => {
  const receipts = emptySubagentCommandReceipts();
  for (let i = 0; i < 45; i++) retainSubagentCommandReceipt(receipts, subagentCommandReceipt(command(), i));
  expect(receipts.commands).toHaveLength(32); expect(receipts.omitted).toBe(13); expect(isSubagentCommandReceipts(receipts)).toBe(true);
});
it("bounds aggregate bytes without truncating a path into different evidence", () => {
  const receipts = emptySubagentCommandReceipts();
  for (let i = 0; i < 32; i++) retainSubagentCommandReceipt(receipts, subagentCommandReceipt({ ...command(), cwd: `/${"x".repeat(2000)}` }, i));
  expect(Buffer.byteLength(JSON.stringify(receipts))).toBeLessThanOrEqual(SUBAGENT_COMMAND_RECEIPTS_MAX_BYTES);
  expect(receipts.omitted).toBeGreaterThan(0); expect(receipts.commands[0]!.cwd).toHaveLength(2001);
});
it("omits invalid optional facts rather than blocking mandatory ownership", () => {
  const receipts = emptySubagentCommandReceipts();
  retainSubagentCommandReceipt(receipts, subagentCommandReceipt(command(), NaN));
  expect(receipts).toEqual({ schemaVersion: 1, commands: [], omitted: 1 });
});
it("does not invent an exit or success from restart cleanup", () => {
  const receipts = emptySubagentCommandReceipts();
  const item = command();
  retainSubagentCommandReceipt(receipts, subagentCommandReceipt(item, 100));
  expect(receipts.commands[0]).toMatchObject({ completion: "unobserved", exitCode: null, timedOut: null, cancelled: null, durationMs: null, cleanup: "confirmed" });
  retainSubagentCommandReceipt(receipts, subagentCommandReceipt({ ...item, state: "cleanup_unknown" }, 200));
  expect(receipts.commands).toHaveLength(1); expect(receipts.commands[0]!.cleanup).toBe("confirmed");
});
it("adds cleanup proof without erasing previously observed exit facts", () => {
  const receipts = emptySubagentCommandReceipts(); const item = command();
  retainSubagentCommandReceipt(receipts, { ...subagentCommandReceipt(item, 100), completion: "observed", exitCode: 1, durationMs: 50, cleanup: "unknown" });
  retainSubagentCommandReceipt(receipts, subagentCommandReceipt(item, 200));
  expect(receipts.commands).toHaveLength(1);
  expect(receipts.commands[0]).toMatchObject({ exitCode: 1, durationMs: 50, capturedAt: 200, cleanup: "confirmed" });
});
it.each(["argv", "env", "stdout", "answer", "passed", "providerSuccess"])("rejects unsupported %s as stored authority", (field) => {
  const receipts = emptySubagentCommandReceipts(); const fact = subagentCommandReceipt(command(), 100);
  expect(isSubagentCommandReceipts({ ...receipts, commands: [{ ...fact, [field]: "not authority" }] })).toBe(false);
});
it("rejects duplicate identities and fabricated recovery outcomes", () => {
  const fact = subagentCommandReceipt(command(), 100);
  expect(isSubagentCommandReceipts({ schemaVersion: 1, commands: [fact, fact], omitted: 0 })).toBe(false);
  expect(isSubagentCommandReceipts({ schemaVersion: 1, commands: [{ ...fact, exitCode: 0 }], omitted: 0 })).toBe(false);
});
it("bounds the real pretty-printed record rather than spending ownership capacity on optional facts", () => {
  const receipts = emptySubagentCommandReceipts();
  for (let i = 0; i < 32; i++) retainSubagentCommandReceipt(receipts, subagentCommandReceipt(command(), i));
  // Structural stress fixture: only the optional-field limiter is under test.
  const record = { preview: "x".repeat(127 * 1024), subagentOwnership: { held: true }, subagentCommandReceipts: receipts } as unknown as DurableProcessJobRecord;
  boundSubagentCommandReceipts(record);
  expect(Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`)).toBeLessThanOrEqual(128 * 1024);
  expect(record.subagentOwnership).toEqual({ held: true });
  expect(record.subagentCommandReceipts?.omitted).toBeGreaterThan(0);
});
it("can omit the entire optional field when even its header has no room", () => {
  const record = { preview: "x".repeat(128 * 1024), subagentCommandReceipts: emptySubagentCommandReceipts() } as unknown as DurableProcessJobRecord;
  boundSubagentCommandReceipts(record);
  expect(record.subagentCommandReceipts).toBeUndefined();
  // Mandatory oversized state still fails the ordinary store validator; it is
  // never truncated here to manufacture capacity or ownership release.
  expect(record.preview).toHaveLength(128 * 1024);
});
