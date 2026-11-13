import { describe, expect, it, vi } from "vitest";
import { startTuiAdapter } from "../index.js";
import { parseCapabilitySetupSnapshot, type CapabilitySetupSnapshot } from "../capability-setup.js";

const snapshot: CapabilitySetupSnapshot = {
  version: 1, observedAt: "2026-08-01T10:00:00.000Z", observation: "durable-inputs",
  process: { pid: 42, startedAt: "2026-08-01T09:00:00.000Z" }, cards: [],
};
describe("operator capability discovery", () => {
  it("advertises only read authority, authorizes and disables caching", async () => {
    const read = vi.fn(async () => snapshot);
    const adapter = await startTuiAdapter({ port: 0, apiKey: "fictional-test-key", responder: { respond: async () => ({ text: "unused" }) }, capabilitySetup: { read } });
    try {
      const url = `${adapter.baseUrl}/v1/capabilities`;
      expect((await fetch(url)).status).toBe(401);
      expect(read).not.toHaveBeenCalled();
      const headers = { Authorization: "Bearer fictional-test-key" };
      const info = await (await fetch(adapter.infoUrl, { headers })).json() as { capabilities: Record<string, unknown> };
      expect(info.capabilities.capabilitySetup).toEqual({ version: 1, read: true, propose: false, apply: false });
      const response = await fetch(url, { headers });
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toEqual(snapshot);
      expect((await fetch(url, { method: "POST", headers })).status).toBe(404);
    } finally { await adapter.stop(); }
  });
  it("keeps older hosts unsupported and sanitizes service errors", async () => {
    for (const capabilitySetup of [undefined, { read: async () => { throw new Error("synthetic private diagnostic"); } }]) {
      const adapter = await startTuiAdapter({ port: 0, responder: { respond: async () => ({ text: "unused" }) }, ...(capabilitySetup === undefined ? {} : { capabilitySetup }) });
      try {
        const response = await fetch(`${adapter.baseUrl}/v1/capabilities`);
        expect(response.status).toBe(capabilitySetup === undefined ? 501 : 503);
        expect(await response.text()).not.toContain("synthetic private");
      } finally { await adapter.stop(); }
    }
  });
  it("rejects unknown, malformed, oversized and secret-bearing extra fields", () => {
    expect(parseCapabilitySetupSnapshot(snapshot)).toEqual(snapshot);
    for (const invalid of [{ ...snapshot, secret: "synthetic" }, { ...snapshot, version: 2 }, { ...snapshot, cards: [{ id: "a" }] }, { ...snapshot, process: { pid: 0, startedAt: "bad" } }]) {
      expect(() => parseCapabilitySetupSnapshot(invalid)).toThrow();
    }
  });
});
