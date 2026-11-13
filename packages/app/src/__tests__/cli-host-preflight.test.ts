import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseHostPreflightArgs } from "../cli/host-preflight-args.js";
import { parseCliArgs } from "../cli/cli-args.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const ids = ["runtime.node", "runtime.node-abi", "native.memory", "native.sharp", "service.manager", "models.ollama", "models.lmstudio", "sandbox.runtime", "console.port"];
describe("independent preflight CLI", () => {
  it.each([["--port", "0"], ["--port", "65536"], ["--port", "1.5"], ["--port"], ["--config", "x"], ["--env-file", "x"], ["--host", "example.com"], ["extra"]])("rejects %j", (...args) => {
    expect(() => parseHostPreflightArgs(args)).toThrow();
    expect(() => parseCliArgs(["preflight", ...args])).toThrow();
  });
  it("shares recognition and preserves doctor alias", () => {
    expect(parseCliArgs(["preflight", "--json", "--port", "12345"])).toMatchObject({ command: "preflight", json: true, port: 12345 });
    expect(parseCliArgs(["doctor", "--json"])).toEqual(parseCliArgs(["validate", "--json"]));
  });
  it("works in an empty folder, emits pure JSON parsed in another process, never reads config/dotenv", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "preflight-test-"));
    try {
      // Reject the ordinary config-loading import graph at the executable boundary.
      const hook = join(cwd, "tripwire.mjs");
      await writeFile(hook, `import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){if(s.includes('cli-commands')||s==='@mono-agent/config'||s.includes('dotenv'))throw Error('heavy import');return n(s,c)}});`);
      const { stdout, stderr } = await exec(process.execPath, ["--import", hook, cli, "preflight", "--json"], { cwd, timeout: 40000 });
      expect(stderr).toBe("");
      const path = join(cwd, "report.json");
      await writeFile(path, stdout);
      const parsed = await exec(process.execPath, ["--input-type=module", "-e", "import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify({schema:r.schemaVersion,ids:r.checks.map(c=>c.id),ok:r.ok,invalid:r.checks.filter(c=>c.status!=='ok'&&!c.remediations.length).length}))", path], { cwd });
      expect(JSON.parse(parsed.stdout)).toEqual({ schema: 1, ids, ok: true, invalid: 0 });
      const text = await exec(process.execPath, [cli, "preflight"], { cwd, timeout: 40000 });
      expect(text.stdout).toContain("Host preflight: no errors");
      expect(await readdir(cwd)).toEqual(["report.json", "tripwire.mjs"]);
      // Poison files must remain unread, unchanged, and cannot influence results.
      await writeFile(join(cwd, "mono-agent.config.json"), "invalid config");
      await writeFile(join(cwd, ".env"), "NODE_OPTIONS=--invalid\n");
      const again = await exec(process.execPath, [cli, "preflight", "--json"], { cwd, timeout: 40000 });
      expect(JSON.parse(again.stdout).checks.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(await readFile(join(cwd, ".env"), "utf8")).toBe("NODE_OPTIONS=--invalid\n");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 120000);
  it("retains every host result when sandbox temp setup fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "preflight-temp-failure-"));
    try {
      const missing = join(cwd, "unavailable-temp-root");
      const { stdout, stderr } = await exec(process.execPath, [cli, "preflight", "--json"], {
        cwd, timeout: 40000, env: { ...process.env, TMPDIR: missing, TMP: missing, TEMP: missing },
      });
      const report = JSON.parse(stdout);
      expect(stderr).toBe("");
      expect(report.ok).toBe(true);
      expect(report.failure).toBeUndefined();
      expect(report.checks.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(report.checks.find((c: { id: string }) => c.id === "sandbox.runtime")).toMatchObject({ status: "warning", code: "probe_setup_failed" });
      expect(await readdir(cwd)).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 60000);
  it("reports a simulated broken native module without loading the ordinary CLI graph", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "preflight-install-"));
    try {
      const app = join(cwd, "app");
      await mkdir(app);
      await cp(new URL("../../dist", import.meta.url), join(app, "dist"), { recursive: true });
      await cp(new URL("../../package.json", import.meta.url), join(app, "package.json"));
      await cp(new URL("../../resources", import.meta.url), join(app, "resources"), { recursive: true });
      await writeFile(join(app, "dist/cli/cli-commands.js"), "throw Error('ordinary CLI graph imported');");
      const modules = join(app, "node_modules/@mono-agent");
      await mkdir(modules, { recursive: true });
      for (const name of ["contracts", "turn", "conversation"]) {
        await symlink(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), join(modules, name), "dir");
      }
      const memory = join(modules, "memory");
      await mkdir(memory);
      await writeFile(join(memory, "package.json"), JSON.stringify({ name: "@mono-agent/memory", type: "module", exports: { "./store": "./store.js" } }));
      await writeFile(join(memory, "store.js"), "throw Error('Compiled using NODE_MODULE_VERSION 115; requires NODE_MODULE_VERSION 137.');");
      try {
        await exec(process.execPath, [join(app, "dist/cli.js"), "preflight", "--json"], { cwd, timeout: 40000 });
        throw Error("expected native error exit");
      } catch (e) {
        const result = e as { code: number; stdout: string; stderr: string };
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        const report = JSON.parse(result.stdout);
        expect(report.checks.find((c: { id: string }) => c.id === "native.memory")).toMatchObject({ code: "native_abi_mismatch", observed: { compiledAbi: "115", requiredAbi: "137" } });
        const fixes = report.checks.find((c: { id: string }) => c.id === "native.memory").remediations;
        expect(fixes).toHaveLength(2);
        const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as { version: string };
        expect(fixes[0].command).toBe(`npm uninstall --global create-mono-agent && npm install --global create-mono-agent@${manifest.version}`);
        expect(fixes[1].explanation).toContain("Alternative");
      }
      // Simulation only: replace the broken fixture with the installed native
      // dependency, without mutating the workspace or running a global repair.
      await rm(memory, { recursive: true });
      await symlink(fileURLToPath(new URL("../../../memory", import.meta.url)), memory, "dir");
      const restored = await exec(process.execPath, [join(app, "dist/cli.js"), "preflight", "--json"], { cwd, timeout: 40000 });
      const healthy = JSON.parse(restored.stdout);
      expect(healthy.ok).toBe(true);
      expect(healthy.checks.find((c: { id: string }) => c.id === "native.memory").status).toBe("ok");
      // A damaged optional resource must not discard healthy native/runtime checks.
      await writeFile(join(app, "resources/srt/package.json"), "invalid resource json");
      const damaged = await exec(process.execPath, [join(app, "dist/cli.js"), "preflight", "--json"], { cwd, timeout: 40000 });
      const partial = JSON.parse(damaged.stdout);
      expect(partial.ok).toBe(true);
      expect(partial.failure).toBeUndefined();
      expect(partial.checks.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(partial.checks.find((c: { id: string }) => c.id === "sandbox.runtime")).toMatchObject({ status: "warning", code: "sandbox_resource_failed" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 60000);
  it("retains JSON envelope and exit 2 on usage failure", async () => {
    try { await exec(process.execPath, [cli, "preflight", "--json", "--port", "0"]); throw new Error("expected usage failure"); }
    catch (e) {
      const failure = e as { code: number; stdout: string; stderr: string };
      expect(failure.code).toBe(2);
      expect(failure.stderr).toBe("");
      expect(JSON.parse(failure.stdout)).toMatchObject({ schemaVersion: 1, operation: "host-preflight", ok: false, failure: { code: "usage" } });
    }
  });
  it("supports both lightweight help spellings", async () => {
    expect((await exec(process.execPath, [cli, "preflight", "--help"])).stdout).toContain("--port");
    expect((await exec(process.execPath, [cli, "help", "preflight"])).stdout).toContain("--port");
  });
});
