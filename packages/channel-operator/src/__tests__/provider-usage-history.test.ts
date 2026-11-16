import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_USAGE_HISTORY_SCHEMA, type ProviderUsageHistory, type ProviderUsageOperator } from "@mono-agent/contracts";
import { startTuiAdapter, type TuiAdapterStartResult } from "../index.js";

const servers: TuiAdapterStartResult[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });
const range = { from: "2026-10-24T00:00:00.000Z", to: "2026-10-27T00:00:00.000Z", bucket: "day" as const, timeZone: "Europe/Berlin" };
const history: ProviderUsageHistory = { schema: PROVIDER_USAGE_HISTORY_SCHEMA, ...range, retentionDays: 90, storage: "ready", providers: [{ providerId: "anthropic", label: "Claude", samples: [], accountChanges: ["2026-10-25T12:00:00.000Z"], downsampled: false }] };
async function server(operator: ProviderUsageOperator) {
  const running = await startTuiAdapter({ port: 0, info: { label: "Fictional agent", model: "fictional:model" }, responder: { respond: async () => ({ text: "fictional" }) }, providerUsage: operator });
  servers.push(running); return running;
}
function operator() { return { snapshot: vi.fn(async () => ({ schema: "mono-agent.provider-usage.v1" as const, providers: [] })), history: vi.fn(async () => history), clearHistory: vi.fn(async () => undefined) }; }

describe("quota history operator routes", () => {
  it("advertises additive history support, serves no-store local reads and clears without vendor reads", async () => {
    const op = operator(), running = await server(op);
    const info = await (await fetch(`${running.baseUrl}/v1/info`)).json() as { capabilities: { providerUsage: unknown } };
    expect(info.capabilities.providerUsage).toEqual({ version: 1, history: { version: 1, clear: true } });
    const read = await fetch(`${running.baseUrl}/v1/provider-usage/history?${new URLSearchParams(range)}`);
    expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toContain("no-store"); expect(await read.json()).toEqual(history);
    expect(op.history).toHaveBeenCalledWith(range); expect(op.snapshot).not.toHaveBeenCalled();
    const cleared = await fetch(`${running.baseUrl}/v1/provider-usage/history?provider=anthropic`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
    expect(cleared.status).toBe(200); expect(await cleared.json()).toEqual({}); expect(op.clearHistory).toHaveBeenCalledWith("anthropic");
  });
  it("leaves old snapshot-only hosts compatible and reports unsupported history explicitly", async () => {
    const op = operator(), running = await server({ snapshot: op.snapshot });
    const info = await (await fetch(`${running.baseUrl}/v1/info`)).json() as { capabilities: { providerUsage: unknown } };
    expect(info.capabilities.providerUsage).toEqual({ version: 1 });
    expect((await fetch(`${running.baseUrl}/v1/provider-usage/history?${new URLSearchParams(range)}`)).status).toBe(409);
    expect((await fetch(`${running.baseUrl}/v1/provider-usage`)).status).toBe(200);
  });
  it("rejects foreign browser origin, invalid range/zone/query and nonempty clear payloads before host calls", async () => {
    const op = operator(), running = await server(op), url = `${running.baseUrl}/v1/provider-usage/history`;
    expect((await fetch(`${url}?${new URLSearchParams(range)}`, { headers: { origin: "https://foreign.invalid" } })).status).toBe(403);
    for (const patch of [{ timeZone: "fictional/zone" }, { bucket: "week" }, { accountId: "fictional-account" }, { provider: "other" }, { to: range.from }]) {
      expect((await fetch(`${url}?${new URLSearchParams({ ...range, ...patch })}`)).status).toBe(400);
    }
    for (const body of ["null", "[]", '{"provider":"anthropic"}']) expect((await fetch(url, { method: "DELETE", headers: { "content-type": "application/json" }, body })).status).toBe(400);
    expect(op.history).not.toHaveBeenCalled(); expect(op.clearHistory).not.toHaveBeenCalled(); expect(op.snapshot).not.toHaveBeenCalled();
  });
  it("rejects storage identities at the wire boundary", async () => {
    const op = operator(); op.history.mockResolvedValueOnce({ ...history, fingerprint: "fictional-fingerprint" } as ProviderUsageHistory);
    const running = await server(op);
    const response = await fetch(`${running.baseUrl}/v1/provider-usage/history?${new URLSearchParams(range)}`);
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("fictional-fingerprint");
  });
});
