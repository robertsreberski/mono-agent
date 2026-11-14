import { expect, it, vi } from "vitest";
import { startTuiAdapter } from "../index.js";
import { parseCapabilityActionSaveInput, parseCapabilityActionsSnapshot } from "../capability-actions.js";
const processIdentity = { pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString() };
it("keeps action contracts strict and independent of read snapshots", () => {
  for (const extra of [{ patch: {} }, { path: "config.json" }, { command: "anything" }, { options: {} }]) expect(() => parseCapabilityActionSaveInput({ action: "memory-lite", process: processIdentity, expectedVersion: "a".repeat(64), confirmed: true, ...extra })).toThrow();
  expect(() => parseCapabilityActionSaveInput({ action: "memory-lite", process: processIdentity, expectedVersion: "a".repeat(64), confirmed: false })).toThrow();
  expect(() => parseCapabilityActionsSnapshot({ version: 1, process: processIdentity, actions: [] })).toThrow();
});
it("exposes keyless bounded typed actions, rejects invalid JSON and never returns service diagnostics", async () => {
  const save = vi.fn(async () => { throw new Error("fictional-private-diagnostic"); });
  const preview = vi.fn(async () => { throw new Error("fictional-private-diagnostic"); });
  const adapter = await startTuiAdapter({ port: 0, responder: { respond: async () => ({ text: "unused" }) }, capabilityActions: {
    read: async () => ({ version: 1, process: processIdentity, actions: [{ id: "memory-lite", available: true, active: false, reason: "eligible" }, { id: "cron-controls", available: false, active: false, reason: "no-valid-jobs" }] }), preview, save,
  } });
  try {
    const url = `${adapter.baseUrl}/v1/capability-actions`;
    const read = await fetch(url); expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toContain("no-store");
    for (const body of ["fictional-private-diagnostic", '{"secret":"fictional-private-diagnostic",', JSON.stringify({ action: "memory-lite", process: processIdentity, patch: {} }), JSON.stringify({ action: "memory-lite", process: processIdentity, extra: "not-allowed" })]) {
      const response = await fetch(`${url}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(400); expect(await response.text()).not.toContain("fictional-private-diagnostic");
    }
    expect(preview).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    const failed = await fetch(`${url}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "memory-lite", process: processIdentity }) });
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("fictional-private-diagnostic");
    const failedSave = await fetch(`${url}/save`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "memory-lite", process: processIdentity, expectedVersion: "a".repeat(64), confirmed: true }) });
    expect(failedSave.status).toBe(503); expect(await failedSave.text()).not.toContain("fictional-private-diagnostic");
    expect(save).toHaveBeenCalledOnce();
    const oversized = await fetch(`${url}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(2048) }) });
    expect(oversized.status).toBe(413);
    const info = await (await fetch(adapter.infoUrl)).json() as { capabilities: Record<string, unknown> }; expect(info.capabilities.capabilityActions).toEqual({ version: 1, preview: true, save: true }); expect(info.capabilities.capabilitySetup).toBeUndefined();
  } finally { await adapter.stop(); }
});
it("parses the E2 snapshot with optional newer actions but keeps the E1 pair mandatory", async () => {
  const { parseCapabilityActionsSnapshot, parseCapabilityActionPreview } = await import("../capability-actions.js");
  const full = { version: 1, process: processIdentity, actions: [
    { id: "memory-lite", available: true, active: false, reason: "eligible" },
    { id: "cron-controls", available: false, active: false, reason: "no-valid-jobs" },
    { id: "subagents-enable", available: true, active: false, reason: "eligible" },
    { id: "config-undo", available: true, active: false, reason: "eligible" },
  ] };
  expect(parseCapabilityActionsSnapshot(full).actions).toHaveLength(4);
  expect(() => parseCapabilityActionsSnapshot({ ...full, actions: full.actions.slice(1) })).toThrow();
  expect(() => parseCapabilityActionsSnapshot({ ...full, actions: [...full.actions, full.actions[0]] })).toThrow();
  const undo = { action: "config-undo", process: processIdentity, expectedVersion: "a".repeat(64), changes: [{ field: "config", value: "Restore." }], normalizesFormatting: false, exactBytes: true, noOp: false };
  expect(parseCapabilityActionPreview(undo).exactBytes).toBe(true);
  const subagents = { action: "subagents-enable", process: processIdentity, expectedVersion: "a".repeat(64), changes: [{ field: "subagents.enabled", value: "true" }, { field: "tools.allowedTools", value: "Append." }], normalizesFormatting: true, exactBytes: false, noOp: false };
  expect(parseCapabilityActionPreview(subagents).changes).toHaveLength(2);
  expect(() => parseCapabilityActionPreview({ ...subagents, changes: [...subagents.changes, ...subagents.changes, ...subagents.changes] })).toThrow();
  expect(() => parseCapabilityActionPreview({ ...undo, changes: [{ field: "memory", value: "x" }] })).toThrow();
});
