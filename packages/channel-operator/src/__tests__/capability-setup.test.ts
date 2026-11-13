import { describe, expect, it, vi } from "vitest";
import { startTuiAdapter } from "../index.js";
import { parseCapabilitySetupSnapshot, MAX_CAPABILITY_SETUP_BYTES, type CapabilitySetupSnapshot } from "../capability-setup.js";

const snapshot: CapabilitySetupSnapshot = {
  version: 1, observedAt: "2026-08-01T10:00:00.000Z", observation: "durable-inputs",
  process: { pid: 42, startedAt: "2026-08-01T09:00:00.000Z" }, cards: [],
};
function reportOfSize(bytes: number): CapabilitySetupSnapshot {
  const result: CapabilitySetupSnapshot = { ...snapshot, cards: [{
    id: "tools", title: "Tools", purpose: "Local tools", requirements: [], usage: "Local",
    ownedConfigPaths: ["tools.allowedTools"], steps: Array.from({ length: 20 }, () => "x"), status: "ok", evidence: [],
  }] };
  const steps = result.cards[0]!.steps as string[];
  let remaining = bytes - Buffer.byteLength(JSON.stringify(result), "utf8");
  for (let index = 0; remaining > 0 && index < steps.length; index++) {
    const extra = Math.min(8191, remaining); steps[index] += "a".repeat(extra); remaining -= extra;
  }
  expect(remaining).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(bytes);
  return result;
}
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
    for (const capabilitySetup of [undefined, { read: async () => { throw new Error("synthetic private diagnostic"); } }, { read: async () => reportOfSize(MAX_CAPABILITY_SETUP_BYTES + 1) }]) {
      const error = vi.fn();
      const adapter = await startTuiAdapter({ port: 0, logger: { error }, responder: { respond: async () => ({ text: "unused" }) }, ...(capabilitySetup === undefined ? {} : { capabilitySetup }) });
      try {
        const response = await fetch(`${adapter.baseUrl}/v1/capabilities`);
        expect(response.status).toBe(capabilitySetup === undefined ? 501 : 503);
        expect(await response.text()).not.toContain("synthetic private");
        expect(error).toHaveBeenCalledTimes(capabilitySetup === undefined ? 0 : 1);
        expect(JSON.stringify(error.mock.calls)).not.toContain("synthetic private");
      } finally { await adapter.stop(); }
    }
  });
  it.each([MAX_CAPABILITY_SETUP_BYTES - 1, MAX_CAPABILITY_SETUP_BYTES])("accepts a valid report of exactly %i UTF-8 bytes", (bytes) => {
    const report = reportOfSize(bytes);
    expect(parseCapabilitySetupSnapshot(report)).toEqual(report);
  });
  it("rejects a valid-shaped report one byte over the actual UTF-8 limit", () => {
    expect(() => parseCapabilitySetupSnapshot(reportOfSize(MAX_CAPABILITY_SETUP_BYTES + 1))).toThrow("too large");
    const unicode = reportOfSize(MAX_CAPABILITY_SETUP_BYTES - 1);
    const steps = unicode.cards[0]!.steps as string[];
    steps[0] = steps[0]!.replaceAll("a", "é");
    expect(() => parseCapabilitySetupSnapshot(unicode)).toThrow("too large");
  });
  it("rejects unknown, malformed, oversized and secret-bearing extra fields", () => {
    expect(parseCapabilitySetupSnapshot(snapshot)).toEqual(snapshot);
    for (const invalid of [reportOfSize(MAX_CAPABILITY_SETUP_BYTES + 1), { ...snapshot, secret: "synthetic" }, { ...snapshot, version: 2 }, { ...snapshot, cards: [{ id: "a" }] }, { ...snapshot, process: { pid: 0, startedAt: "bad" } }]) {
      expect(() => parseCapabilitySetupSnapshot(invalid)).toThrow();
    }
  });
});
