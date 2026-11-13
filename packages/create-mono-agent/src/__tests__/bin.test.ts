import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../../dist/bin/mono-agent.js", import.meta.url));
describe("installed bin routing and early Node guard", () => {
  it("preserves both installed names, single version output, and init help", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-bin-"));
    try {
      for (const name of ["create-mono-agent", "mono-agent"]) {
        const path = join(cwd, name);
        await symlink(bin, path);
        const version = await exec(process.execPath, [path, "--version"], { cwd });
        expect(version.stdout.trim().split("\n")).toHaveLength(1);
        expect(version.stdout).toMatch(/^mono-agent \d+\.\d+\.\d+\n$/);
        const help = await exec(process.execPath, [path, "--help"], { cwd });
        expect(help.stdout).toContain(name === "create-mono-agent" ? "mono-agent init" : "preflight");
        const preflightHelp = await exec(process.execPath, [path, "preflight", "--help"], { cwd });
        expect(preflightHelp.stdout).toContain("mono-agent preflight");
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 30000);
  it("rejects unsupported Node before imports or delegation, for both entry points", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "node-guard-"));
    try {
      const hook = join(cwd, "old-node.mjs");
      await writeFile(hook, `import{registerHooks}from'node:module';
Object.defineProperty(process.versions,'node',{value:'20.20.0'});
registerHooks({resolve(s,c,n){if(/cli-commands|resolve-agent-app-cli|delegate\\.js/.test(s))throw Error('import before guard');return n(s,c)}});`);
      const app = fileURLToPath(new URL("../../../app/dist/cli.js", import.meta.url));
      for (const path of [bin, app]) {
        try { await exec(process.execPath, ["--import", hook, path, "--version"], { cwd }); throw Error("expected rejection"); }
        catch (e) {
          const result = e as { code: number; stdout: string; stderr: string };
          expect(result.code).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("found 20.20.0");
          expect(result.stderr).toContain("requires Node.js >=");
          expect(result.stderr).toContain("volta install node@");
          expect(result.stderr).not.toContain("import before guard");
        }
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
