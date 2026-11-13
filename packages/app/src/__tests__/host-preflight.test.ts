import { execFile } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { bindLoopback, boundedProcess, loopbackProbe, PROBE_MAX_BYTES } from "../doctor/host-preflight-probes.js";
import { consolePortCheck, hostReport, modelsCheck, nativeCheck, sandboxCheck, serviceCheck } from "../doctor/host-preflight.js";
import { nativeRemediations, shellQuote } from "../doctor/host-remediation.js";
import { classifyNativeFailure, isBuiltInMemoryNativeFailure } from "../doctor/native-failures.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))); });
async function serve(handler: RequestListener): Promise<number> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as { port: number }).port;
}

describe("bounded literal-loopback host checks", () => {
  it("recognizes both local model list protocols", async () => {
    const port = await serve((_req, res) => res.end(JSON.stringify({ models: [], data: [] })));
    expect((await loopbackProbe(port, "/api/tags")).ok).toBe(true);
    expect((await loopbackProbe(port, "/v1/models")).ok).toBe(true);
  });
  it("never follows redirects", async () => {
    let targetHits = 0;
    const target = await serve((_req, res) => { targetHits++; res.end('{"models":[]}'); });
    const port = await serve((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target}/api/tags` }); res.end(); });
    expect((await loopbackProbe(port, "/api/tags")).code).toBe("http_status");
    expect(targetHits).toBe(0);
  });
  it("rejects oversized, invalid and refused responses", async () => {
    const large = await serve((_req, res) => res.end("x".repeat(PROBE_MAX_BYTES + 1)));
    expect((await loopbackProbe(large, "/api/tags")).code).toBe("response_too_large");
    const invalid = await serve((_req, res) => res.end("not-json"));
    expect((await loopbackProbe(invalid, "/api/tags")).ok).toBe(false);
    const free = await bindLoopback(0);
    expect((await loopbackProbe(free.port, "/api/tags")).ok).toBe(false);
  });
  it("applies a wall deadline even if headers or a body stall", async () => {
    const port = await serve((_req, res) => { res.writeHead(200); res.write('{"models":['); });
    const start = Date.now();
    expect((await loopbackProbe(port, "/api/tags", 60)).code).toBe("probe_timeout");
    expect(Date.now() - start).toBeLessThan(1500);
  });
  it("ignores proxy variables and offers a tested, unreserved port", async () => {
    const port = await serve((_req, res) => res.end('{"models":[]}'));
    const previous = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://192.0.2.1:1";
    try { expect((await loopbackProbe(port, "/api/tags")).ok).toBe(true); }
    finally { if (previous === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous; }
    const check = await consolePortCheck(port);
    expect(check.status).toBe("warning");
    expect(check.observed.suggestedPort).toBeTypeOf("number");
    expect(check.remediations[0]?.command).toContain(`--port ${check.observed.suggestedPort}`);
    expect((await bindLoopback(Number(check.observed.suggestedPort))).ok).toBe(true);
  });
  it("force-kills a sandbox-style worker that ignores graceful cancellation", async () => {
    const start = Date.now();
    const result = await boundedProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], 100, { graceful: true });
    expect(result.code).toBe("probe_timeout");
    expect(Date.now() - start).toBeLessThan(3000);
  });
  it("bounds process timeout, output and crashes", async () => {
    expect((await boundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], 60)).code).toBe("probe_timeout");
    expect((await boundedProcess(process.execPath, ["-e", "process.abort()"])).ok).toBe(false);
    expect((await boundedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000000))"])).code).toBe("probe_output_limit");
  });
});

describe("native probes and repair guidance", () => {
  it.each(["memory", "sharp"] as const)("actually loads %s in a child", async (kind) => {
    const worker = fileURLToPath(new URL("../../dist/doctor/host-native-worker.js", import.meta.url));
    const raw = await boundedProcess(process.execPath, [worker, kind]);
    const result = JSON.parse(raw.stdout) as { ok: boolean; observed: Record<string, unknown> };
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (kind === "memory") expect(result.observed).toMatchObject({ betterSqlite3: "loaded", sqliteVec: "loaded", vecVersion: expect.any(String) });
    else expect(result.observed.outputBytes).toBeGreaterThan(0);
  });
  it("classifies simulated ABI mismatch without mislabelling generic failures", async () => {
    const error = "was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version requires NODE_MODULE_VERSION 137.";
    const check = await nativeCheck("memory", async () => ({ ok: false, observed: {}, error, code: "probe_failed" }));
    expect(check).toMatchObject({ status: "error", code: "native_abi_mismatch", observed: { compiledAbi: "115", requiredAbi: "137", runningAbi: process.versions.modules } });
    expect(check.remediations.length).toBeGreaterThan(0);
    expect(classifyNativeFailure("ERR_DLOPEN_FAILED invalid binary").code).toBe("native_load_failed");
    expect(classifyNativeFailure("Cannot find package 'sqlite-vec'").code).toBe("native_dependency_missing");
    expect(isBuiltInMemoryNativeFailure(new Error(error))).toBe(true);
    expect(isBuiltInMemoryNativeFailure(new Error("unrelated"))).toBe(false);
  });
  it.each(["probe_timeout", "probe_failed", "probe_protocol_failed"])("reports %s as failure", async (code) => {
    expect(await nativeCheck("sharp", async () => ({ ok: false, observed: {}, error: "", code }))).toMatchObject({ status: "error", code });
  });
  it("derives source repair from installed app, not cwd, and quotes shell paths", async () => {
    expect(shellQuote("/source/it's here")).toBe("'/source/it'\\''s here'");
    const remedies = nativeRemediations();
    expect(remedies[0]?.command).toMatch(/pnpm install --frozen-lockfile --force && pnpm run build$/);
    expect(remedies[0]?.prerequisite).toContain("stop affected agents");
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `const {nativeRemediations}=await import(${JSON.stringify(new URL("../../dist/doctor/host-remediation.js", import.meta.url).href)});console.log(JSON.stringify(nativeRemediations()))`], { cwd: "/" });
    expect(JSON.parse(result.stdout)).toEqual(remedies);
  });
  it("optional warnings do not imply errors", () => {
    expect(hostReport([{ id: "console.port", status: "warning", code: "occupied", message: "busy", observed: {}, remediations: [{ command: "mono-agent preflight --port 5051", explanation: "Use another port" }] }]).ok).toBe(true);
  });
});


describe("optional capability status and exact remediation", () => {
  it("probes the actual user manager without retrieving its environment", async () => {
    const calls: unknown[] = [];
    const run = async (command: string, args: readonly string[]) => { calls.push([command, args]); return { ok: true, stdout: "", code: "ok" }; };
    expect((await serviceCheck("linux", run)).status).toBe("ok");
    expect(calls).toEqual([["systemctl", ["--user", "show", "--property=Version", "--value"]]]);
    const missing = await serviceCheck("darwin", async () => ({ ok: false, stdout: "", code: "probe_failed" }));
    expect(missing.status).toBe("warning");
    expect(missing.remediations.map((r) => r.command)).toEqual(["mono-agent start --foreground", "mono-agent web run --loopback"]);
    expect(missing.remediations[0]?.prerequisite).toContain("After scaffolding");
    expect((await serviceCheck("win32", run)).status).toBe("warning");
  });
  it.each(["ollama", "lmstudio"] as const)("keeps missing %s informational and conditional", async (kind) => {
    const result = await modelsCheck(kind, async () => ({ ok: false, code: "connection_failed" }), async () => false);
    expect(result.status).toBe("info");
    expect(result.remediations[0]?.command).toBe(kind === "ollama" ? "ollama serve" : "lms server start --port 1234");
    expect(result.remediations[0]?.prerequisite).toContain("Install the CLI first");
    expect(result.message).toContain("optional");
  });
  it("keeps sandbox states distinct and offers platform-specific repair only", async () => {
    for (const state of ["absent", "corrupt", "unsupported"] as const) {
      const probe = async () => ({ ok: true, observed: { state, version: "0.0.64" }, error: "", code: "ok" });
      const mac = await sandboxCheck("darwin", probe);
      expect(mac.code).toBe(`sandbox_${state}`);
      expect(mac.remediations[0]?.command).toBe("mono-agent sandbox setup");
      const linux = await sandboxCheck("linux", probe, async () => false);
      expect(linux.remediations[0]?.command).toMatch(/^npm install --global @anthropic-ai\/sandbox-runtime@\d+\.\d+\.\d+$/);
      expect(linux.observed.prerequisites).toEqual({ bwrap: false, socat: false });
      expect(linux.remediations[0]?.prerequisite).toContain("unprivileged user namespaces");
      const unsupported = await sandboxCheck("win32", probe);
      expect(unsupported.remediations[0]?.explanation).toContain("Linux/WSL");
      expect(unsupported.remediations[0]?.command).not.toContain("setup");
    }
    const ready = await sandboxCheck("darwin", async () => ({ ok: true, observed: { state: "ready" }, error: "", code: "ok" }));
    expect(ready.status).toBe("ok");
    expect(ready.remediations).toEqual([]);
  });
});
