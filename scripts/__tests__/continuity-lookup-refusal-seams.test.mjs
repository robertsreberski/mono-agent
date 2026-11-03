import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { parseLookupOptions, main as compare } from "../continuity-lookup-compare.mjs";
import { main as benchmark, execute } from "../continuity-benchmark.mjs";
import { runLiveTurn } from "../lib/continuity-runner.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
afterEach(() => vi.restoreAllMocks());
it("compare:12 refuses --real=value before parsing or IO", () => {
  expect(() => parseLookupOptions(["--real=yes"], [])).toThrow("lookup_real_not_authorized");
});
it("compare:88 refuses --real before registration IO", async () => {
  await expect(compare(["run", "--real"])).rejects.toThrow("lookup_real_not_authorized");
});
it("benchmark:165 refuses real lookup before modules load", async () => {
  const modulesLoader = vi.fn(); await expect(benchmark(["--probe-mode", "lookup-allowed-v1", "--real"], { modulesLoader, env: {} })).rejects.toThrow("lookup_real_not_authorized"); expect(modulesLoader).not.toHaveBeenCalled();
});
it("benchmark:282 execute refuses non-offline mode before modules load", async () => {
  const modulesLoader = vi.fn(); await expect(execute({ flags: {}, plan: { probeMode: "lookup-allowed-v1" }, mode: "real", modulesLoader })).rejects.toThrow("lookup_real_not_authorized"); expect(modulesLoader).not.toHaveBeenCalled();
});
const plan = { probeMode: "lookup-allowed-v1", lookup: { budget: { callBudget: 8 }, maxTurns: 10, deadlineMs: 600000, cleanupAllowanceMs: 1 }, limits: { perLiveTurnTimeoutMs: 690000 } };
it("runner:350 non-offline liveRoute bypass remains unreachable to lookup", async () => {
  // liveRoute is private and its non-offline branch is NOT an authorization guard.
  // Pin the branch and prove its public enclosing path refuses before parsing a model.
  const source = await readFile(new URL("../lib/continuity-runner.mjs", import.meta.url), "utf8");
  expect(source).toContain('if (mode !== "offline") return (options) => { watch?.noteOffered(options); return {}; };');
  const parse = vi.fn(); await expect(runLiveTurn({ modules: { host: { parseMonoRuntimeModelReference: parse } }, plan, mode: "real" })).rejects.toThrow("lookup_real_not_authorized"); expect(parse).not.toHaveBeenCalled();
});
it("runner:406 refuses independently of CLI and with egress denied", async () => {
  const network = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw Error("egress_denied"); });
  await expect(runLiveTurn({ modules: {}, plan, mode: "real" })).rejects.toThrow("lookup_real_not_authorized"); expect(network).not.toHaveBeenCalled();
});
it("probe-child:12 refuses real lookup before production modules load", async () => {
  const child = spawn(process.execPath, ["scripts/lib/continuity-probe-child.mjs"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
  child.stdin.end(JSON.stringify({ type: "probe", plan, mode: "real", root: "/fictional-must-not-load" }));
  const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  expect(status).toBe(1); expect(JSON.parse(out).failure).toBe("invalid_lookup_child_contract"); expect(err).toContain("invalid_lookup_child_contract");
});
