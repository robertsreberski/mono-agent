import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCopilotCredentialDiscovery } from "../copilot-usage-credentials.js";

const editor = (value: string, host = "github.com:synthetic-app") => JSON.stringify({ [host]: { oauth_token: value } });
function fixture(files: (string | undefined)[] = []) {
  const readFile = vi.fn(async () => files.shift());
  const run = vi.fn(async () => ({ stdout: "synthetic-keychain\n", stderr: "" }));
  const discover = createCopilotCredentialDiscovery({ home: () => "/synthetic-home", readFile, run,
    env: { PATH: "/synthetic-bin", GH_TOKEN: "SECRET_ENV", GITHUB_TOKEN: "SECRET_ENV", GH_PROMPT_DISABLED: "0" } });
  return { discover, readFile, run };
}
describe("private Copilot local credential discovery", () => {
  it.each([0, 1, 2, 3])("uses exact source precedence at source %s", async (source) => {
    const files = [editor("synthetic-apps"), editor("synthetic-hosts", "github.com"), "github.com:\n  oauth_token: synthetic-gh-file"];
    for (let i = 0; i < source; i++) files[i] = "";
    const f = fixture(files);
    expect(await f.discover()).toBe(["synthetic-apps", "synthetic-hosts", "synthetic-gh-file", "synthetic-keychain"][source]);
    expect(f.readFile.mock.calls.map((call) => (call as unknown as string[])[0])).toEqual([
      "/synthetic-home/.config/github-copilot/apps.json", "/synthetic-home/.config/github-copilot/hosts.json", "/synthetic-home/.config/gh/hosts.yml",
    ].slice(0, Math.min(3, source + 1)));
    expect(f.run).toHaveBeenCalledTimes(source === 3 ? 1 : 0);
  });
  it("scopes editor host/app keys and active gh token to github.com only", async () => {
    const f = fixture([editor("enterprise", "github.company") , editor("lookalike", "github.com.evil"),
      "github.company:\n  oauth_token: enterprise\ngithub.com:\n  users:\n    other:\n      oauth_token: other-account\n  oauth_token: 'synthetic-active'\n"]);
    expect(await f.discover()).toBe("synthetic-active");
    const g = fixture([editor("wrong", "github.com:"), editor("wrong", "https://github.com"), "github.com.evil:\n  oauth_token: wrong"]);
    expect(await g.discover()).toBe("synthetic-keychain");
  });
  it.each(["{broken", "[]", "x".repeat(65537), editor("x".repeat(4097)), editor("embedded\nsecret")])("skips malformed or oversized editor content", async (text) => {
    const f = fixture([text, editor("synthetic-fallback")]);
    expect(await f.discover()).toBe("synthetic-fallback");
  });
  it.each(["github.com: [", "github.com:\n  oauth_token: one\n  oauth_token: two", "other: &token {oauth_token: secret}\ngithub.com: *token", "x".repeat(65537)])("rejects malformed/duplicate/aliased/oversized YAML", async (text) => {
    const f = fixture([undefined, undefined, text]);
    expect(await f.discover()).toBe("synthetic-keychain");
  });
  it("uses bounded shell-free noninteractive gh with token environment removed", async () => {
    const f = fixture();
    expect(await f.discover()).toBe("synthetic-keychain");
    expect(f.run).toHaveBeenCalledExactlyOnceWith("gh", ["auth", "token", "--hostname", "github.com"], {
      env: { PATH: "/synthetic-bin", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GH_HOST: "github.com" },
      timeout: 2000, maxBuffer: 8192, encoding: "utf8", shell: false, windowsHide: true,
    });
    expect(JSON.stringify(f.run.mock.calls)).not.toContain("SECRET_ENV");
  });
  it.each(["ENOENT", "exit 1 SECRET", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"])("treats gh %s as absent without logging", async (code) => {
    const f = fixture(); f.run.mockRejectedValueOnce(new Error(code));
    const log = vi.spyOn(console, "error");
    try { expect(await f.discover()).toBeUndefined(); expect(log).not.toHaveBeenCalled(); }
    finally { log.mockRestore(); }
  });
  it.each([{ stdout: "x".repeat(8193), stderr: "" }, { stdout: "synthetic", stderr: "x".repeat(8193) }, { stdout: "two\nlines", stderr: "" }, { stdout: "", stderr: "" }])("bounds and validates injected process output", async (output) => {
    const f = fixture(); f.run.mockResolvedValueOnce(output); expect(await f.discover()).toBeUndefined();
  });
  it("bounds real regular-file reads, skips directories, and never mutates stores", async () => {
    const output = fileURLToPath(new URL("../../../../output/", import.meta.url));
    await mkdir(output, { recursive: true });
    const home = await mkdtemp(join(output, "copilot-credentials-"));
    try {
      const config = join(home, ".config/github-copilot"); await mkdir(config, { recursive: true });
      await writeFile(join(config, "apps.json"), "x".repeat(65537));
      await writeFile(join(config, "hosts.json"), editor("synthetic-file"));
      const run = vi.fn(async () => ({ stdout: "synthetic-keychain", stderr: "" }));
      const discover = createCopilotCredentialDiscovery({ home: () => home, run });
      expect(await discover()).toBe("synthetic-file");
      await rm(join(config, "apps.json")); await mkdir(join(config, "apps.json"));
      expect(await discover()).toBe("synthetic-file");
      expect(run).not.toHaveBeenCalled();
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("enforces real subprocess absence, failure, output and timeout bounds without host gh", async () => {
    const output = fileURLToPath(new URL("../../../../output/", import.meta.url));
    await mkdir(output, { recursive: true });
    const home = await mkdtemp(join(output, "copilot-process-"));
    try {
      const env = { PATH: home, GH_TOKEN: "SECRET_ENV", GITHUB_TOKEN: "SECRET_ENV" };
      const discover = (mode: string) => createCopilotCredentialDiscovery({ home: () => home, env: { ...env, FIXTURE_MODE: mode } })();
      expect(await discover("absent")).toBeUndefined();
      await writeFile(join(home, "gh"), `#!${process.execPath}
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_PROMPT_DISABLED !== "1"
  || JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["auth", "token", "--hostname", "github.com"])) process.exit(9);
switch (process.env.FIXTURE_MODE) {
case "timeout": setTimeout(() => process.stdout.write("too-late"), 10000); break;
case "stdout": process.stdout.write("x".repeat(9000)); break;
case "stderr": process.stderr.write("x".repeat(9000)); process.stdout.write("synthetic"); break;
case "failure": process.exit(1); break;
default: process.stdout.write("synthetic-process\\n");
}
`, { mode: 0o700 });
      expect(await discover("success")).toBe("synthetic-process");
      for (const mode of ["failure", "stdout", "stderr", "timeout"]) {
        const start = Date.now();
        expect(await discover(mode)).toBeUndefined();
        expect(Date.now() - start).toBeLessThan(5000);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 10000);

});
