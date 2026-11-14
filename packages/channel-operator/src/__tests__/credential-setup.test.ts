import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { startTuiAdapter } from "../index.js";
import { parseCredentialSaveRequest, parseCredentialSnapshot, type CredentialSetupService } from "../credential-setup.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });
const identity = { pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString() };
const fence = "12345678-1234-1234-1234-123456789012";
const plantedValue = ["fictional", "credential", "literal"].join("-");
const input = { card: "openai-api", process: identity, fence, confirmed: true, fields: { bearer: plantedValue } };
it("strictly bounds typed fields by UTF-8 bytes and rejects arbitrary names, values, paths and response properties", () => {
  expect(parseCredentialSaveRequest({ ...input, fields: { bearer: "é".repeat(2048) } }).fields.bearer).toHaveLength(2048);
  for (const fields of [{ bearer: "é".repeat(2049) }, { bearer: plantedValue, path: "outside" }, { bearer: "\n" }, { bearer: 42 }, {}, { bearer: plantedValue, apiKeyEnv: "PATH" }]) expect(() => parseCredentialSaveRequest({ ...input, fields })).toThrow();
  expect(() => parseCredentialSaveRequest({ ...input, path: "outside" })).toThrow();
  expect(() => parseCredentialSnapshot({ ...input, value: plantedValue })).toThrow();
});
it("isolates all parser/service failures with no-store, fixed bodies, no reveal route or credential logging", async () => {
  const save = vi.fn(async () => { throw new Error(plantedValue); });
  const logger = { error: vi.fn(), warn: vi.fn() };
  const adapter = await startTuiAdapter({ port: 0, responder: { respond: async () => ({ text: "No calls" }) }, logger, credentialSetup: { read: async () => { throw new Error(plantedValue); }, save, retry: save } as CredentialSetupService }); cleanup.push(() => adapter.stop());
  const url = `${adapter.baseUrl}/v1/credentials`;
  const cases: Array<[string, Record<string, string>, number]> = [
    [JSON.stringify(input), { "Content-Type": "application/json" }, 503],
    [`{"fields":"${plantedValue}`, { "Content-Type": "application/json" }, 400],
    ["[]", { "Content-Type": "application/json" }, 400],
    [JSON.stringify({ ...input, fields: { bearer: "x".repeat(4097) } }), { "Content-Type": "application/json" }, 400],
    [" ".repeat(16385), { "Content-Type": "application/json" }, 413],
    [JSON.stringify(input), { "Content-Type": "application/json", "Content-Encoding": "gzip" }, 415],
    [JSON.stringify(input), { "Content-Type": "application/json; charset=utf-16" }, 400],
    [JSON.stringify(input), { "Content-Type": "text/plain" }, 415],
    [JSON.stringify(input), { "Content-Type": "application/json", Origin: "https://foreign.invalid" }, 400],
  ];
  for (const [body, headers, code] of cases) {
    const response = await fetch(`${url}/save`, { method: "POST", headers, body }); expect(response.status).toBe(code);
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(await response.text()).not.toContain(plantedValue);
  }
  const chunked = await new Promise<{ status: number; body: string; cache: string | undefined }>((resolve, reject) => {
    const req = request(`${url}/save`, { method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (res) => { let text = ""; res.on("data", (part) => { text += part; }); res.on("end", () => resolve({ status: res.statusCode!, body: text, cache: res.headers["cache-control"] })); });
    req.on("error", reject); req.write('{"fields":"'); req.write(plantedValue); req.end('"' + " ".repeat(17000));
  });
  expect(chunked.status).toBe(413); expect(chunked.cache).toContain("no-store"); expect(chunked.body).not.toContain(plantedValue);
  const reveal = await fetch(`${url}/reveal`); expect(reveal.status).toBe(404); expect(reveal.headers.get("cache-control")).toContain("no-store");
  expect(JSON.stringify(logger)).not.toContain(plantedValue);
  expect(save).toHaveBeenCalledTimes(1);
});
