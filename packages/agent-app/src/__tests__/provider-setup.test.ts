import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeProviderSetupPlan,
  piAuthPathForSetup,
  piAuthRecoveryCommand,
  planProviderSetup,
} from "../provider-setup.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pi provider setup safety", () => {
  it("expands home paths and shell-quotes recovery paths", () => {
    expect(piAuthPathForSetup("~/.pi/custom/auth.json", "/repo")).toBe(join(homedir(), ".pi", "custom", "auth.json"));
    expect(piAuthRecoveryCommand("openai-codex", "/tmp/auth stores/it's.json")).toBe(
      "mono-agent auth login openai-codex --pi-auth-path '/tmp/auth stores/it'\"'\"'s.json'",
    );
  });

  it("kills and fails a hung local CLI preflight at the configured deadline", async () => {
    const dir = await tempDir();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const kill = vi.fn(() => true);
    const spawn = vi.fn(() => ({
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener);
      },
      kill,
    }));
    const plan = planProviderSetup({ cwd: dir, modelRefs: ["pi:ollama:qwen3.6:latest"] });

    const [result] = await executeProviderSetupPlan(plan, {
      spawn: spawn as never,
      preflightTimeoutMs: 10,
    });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toContain("ollama list timed out after 10ms");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("aborts and fails a hung LM Studio preflight even when fetch never settles", async () => {
    const dir = await tempDir();
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const plan = planProviderSetup({ cwd: dir, modelRefs: ["pi:lmstudio:qwen3-8b"] });

    const [result] = await executeProviderSetupPlan(plan, {
      fetch: fetch as never,
      preflightTimeoutMs: 10,
    });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toContain("GET http://localhost:1234/v1/models timed out after 10ms");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not apply the preflight deadline to interactive auth commands", async () => {
    const dir = await tempDir();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const kill = vi.fn(() => true);
    const spawn = vi.fn(() => ({
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener);
      },
      kill,
    }));
    const plan = planProviderSetup({ cwd: dir, modelRefs: ["codex:gpt-5.6-terra"] });
    const pending = executeProviderSetupPlan(plan, {
      spawn: spawn as never,
      preflightTimeoutMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(kill).not.toHaveBeenCalled();
    listeners.get("close")?.(0, null);
    const [result] = await pending;
    expect(result?.status).toBe("ok");
  });

  it("rejects malformed source JSON before spawning and preserves it byte-for-byte", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, "{recoverable-but-malformed", { mode: 0o600 });
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/Unable to parse Pi auth file/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(authPath, "utf8")).toBe("{recoverable-but-malformed");
  });

  it("rejects an array-shaped auth store before spawning", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, '[{"type":"oauth","refresh":"keep"}]\n', { mode: 0o600 });
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/must contain a JSON object/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(authPath, "utf8")).toBe('[{"type":"oauth","refresh":"keep"}]\n');
  });

  it("rejects a successful child that omits the requested provider", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } }, null, 2)}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const spawn = spawned(async (cwd) => {
      await writeFile(join(cwd, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } }));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/did not produce credentials/u);
    expect(await readFile(authPath, "utf8")).toBe(original);
  });

  it("rejects a child that changes sibling providers", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } }, null, 2)}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const spawn = spawned(async (cwd) => {
      await writeFile(join(cwd, "auth.json"), JSON.stringify({
        anthropic: { type: "oauth", refresh: "changed" },
        "openai-codex": { type: "oauth", access: "new" },
      }));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/unexpectedly changed sibling provider anthropic/u);
    expect(await readFile(authPath, "utf8")).toBe(original);
  });

  it("preserves a credential store changed by another process during login", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`, { mode: 0o600 });
    const concurrent = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "concurrent" } }, null, 2)}\n`;
    const spawn = spawned(async (cwd) => {
      await writeFile(join(cwd, "auth.json"), JSON.stringify({
        anthropic: { type: "oauth", refresh: "old" },
        "openai-codex": { type: "oauth", access: "new" },
      }));
      await writeFile(authPath, concurrent, { mode: 0o600 });
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/changed during credential setup/u);
    expect(await readFile(authPath, "utf8")).toBe(concurrent);
  });

  it("atomically promotes a valid target credential and preserves siblings", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "nested", "credentials.json");
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`, { mode: 0o644 });
    const spawn = spawned(async (cwd) => {
      const current = JSON.parse(await readFile(join(cwd, "auth.json"), "utf8"));
      await writeFile(join(cwd, "auth.json"), JSON.stringify({
        ...current,
        "openai-codex": { type: "oauth", access: "new-access", refresh: "new-refresh" },
      }));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("ok");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      anthropic: { type: "oauth", refresh: "keep" },
      "openai-codex": { type: "oauth", access: "new-access", refresh: "new-refresh" },
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(dirname(authPath))).toEqual(["credentials.json"]);
  });

  it("refuses an auth store that another user can write", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    await chmod(authPath, 0o666);
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/writable by another user/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(authPath, "utf8")).toBe(original);
    expect((await stat(authPath)).mode & 0o777).toBe(0o666);
  });

  it("refuses credential persistence in a group/world-writable parent", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await chmod(dir, 0o777);
    const plan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "secret" },
    });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/owned by the current user and not group\/world-writable/u);
    await expect(readFile(authPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${authPath}.mono-agent.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a multiply-linked existing auth store without changing either alias", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const aliasPath = join(dir, "auth-alias.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    await link(authPath, aliasPath);
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/hard-link identity is unsafe/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(authPath, "utf8")).toBe(original);
    expect(await readFile(aliasPath, "utf8")).toBe(original);
  });

  it("rejects multiply-linked bundled Pi output before promotion", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const spawn = spawned(async (cwd) => {
      const stagedPath = join(cwd, "auth.json");
      await writeFile(stagedPath, JSON.stringify({
        anthropic: { type: "oauth", refresh: "keep" },
        "openai-codex": { type: "oauth", access: "new" },
      }));
      await link(stagedPath, join(cwd, "credential-alias.json"));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/hard-link identity is unsafe/u);
    expect(await readFile(authPath, "utf8")).toBe(original);
  });

  it("proves lock ownership before promotion and leaves a replacement lock untouched", async () => {
    if (typeof process.getuid !== "function") throw new Error("This regression requires a POSIX uid.");
    const ownerUid = process.getuid();
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const lockPath = `${authPath}.mono-agent.lock`;
    const replacement = "replacement-owner-lock\n";
    const plan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "secret" },
      beforePiAuthPromotion: async () => {
        const lockStat = await stat(lockPath);
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        expect(lockStat.uid).toBe(ownerUid);
        expect(lockStat.mode & 0o777).toBe(0o600);
        expect(lockStat.nlink).toBe(1);
        expect(owner.ownerUid).toBe(ownerUid);
        expect(typeof owner.token).toBe("string");
        await rm(lockPath);
        await writeFile(lockPath, replacement, { mode: 0o600 });
      },
    });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/credential lock/u);
    expect(await readFile(lockPath, "utf8")).toBe(replacement);
    await expect(readFile(authPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent Pi credential writers under the identity-bound lock", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const plan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let releaseFirst!: () => void;
    const firstMayPromote = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "first-key" },
      beforePiAuthPromotion: async () => {
        markLocked();
        await firstMayPromote;
      },
    });
    await locked;
    const [contender] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "second-key" },
    });
    expect(contender?.status).toBe("failed");
    expect(contender?.detail).toMatch(/credential lock .* already exists/u);

    releaseFirst();
    const [firstResult] = await first;
    expect(firstResult?.status).toBe("ok");
    const [retry] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "second-key" },
    });
    expect(retry?.status).toBe("ok");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toMatchObject({
      "opencode-go": { type: "api_key", key: "second-key" },
    });
    await expect(readFile(`${authPath}.mono-agent.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses symbolic-link auth stores without touching their targets", async () => {
    const dir = await tempDir();
    const target = join(dir, "target.json");
    const authPath = join(dir, "auth.json");
    await writeFile(target, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`);
    await symlink(target, authPath);
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/symbolic link/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ anthropic: { type: "oauth", refresh: "keep" } });
  });

  it("fails closed on Windows for OAuth and API-key persistence", async () => {
    const dir = await tempDir();
    const oauthSpawn = vi.fn();
    const [oauthResult] = await executeProviderSetupPlan(oauthPlan(dir, join(dir, "oauth.json")), {
      platform: "win32",
      spawn: oauthSpawn as never,
    });
    const apiPlan = planProviderSetup({ cwd: dir, piAuthPath: join(dir, "api.json"), modelRefs: ["pi:opencode-go:kimi-k2.6"] });
    const [apiResult] = await executeProviderSetupPlan(apiPlan, {
      platform: "win32",
      apiKeys: { "pi-api-key:opencode-go": "secret-value" },
    });

    expect(oauthResult?.status).toBe("failed");
    expect(apiResult?.status).toBe("failed");
    expect(oauthSpawn).not.toHaveBeenCalled();
    await expect(readFile(join(dir, "oauth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "api.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses automatic Pi credential persistence anywhere inside a Git worktree", async () => {
    const dir = await tempDir();
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    const authPath = join(dir, "credentials", "auth.json");
    const oauthSpawn = vi.fn();
    const [oauthResult] = await executeProviderSetupPlan(oauthPlan(dir, authPath), {
      spawn: oauthSpawn as never,
    });
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });
    const [apiResult] = await executeProviderSetupPlan(apiPlan, {
      apiKeys: { "pi-api-key:opencode-go": "PI_SECRET_SENTINEL_185" },
    });

    expect(oauthResult?.status).toBe("failed");
    expect(apiResult?.status).toBe("failed");
    expect(oauthResult?.detail).toMatch(/inside Git worktree/u);
    expect(apiResult?.detail).toMatch(/inside Git worktree/u);
    expect(oauthSpawn).not.toHaveBeenCalled();
    expect(await readdir(join(dir, "credentials"))).toEqual([]);
  });

  it("rejects a FIFO Pi auth path without blocking", async () => {
    if (process.platform === "win32") return;
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await execFileAsync("mkfifo", [authPath]);
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const result = await Promise.race([
      executeProviderSetupPlan(apiPlan, {
        apiKeys: { "pi-api-key:opencode-go": "secret" },
      }),
      new Promise<"blocked">((resolveBlocked) => setTimeout(() => resolveBlocked("blocked"), 500)),
    ]);

    expect(result).not.toBe("blocked");
    if (result === "blocked") return;
    expect(result[0]?.status).toBe("failed");
    expect(result[0]?.detail).toMatch(/not a regular file/u);
  });

  it("preserves a Pi auth writer that wins immediately before pathname claim", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`, { mode: 0o600 });
    const concurrent = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "concurrent" }, sibling: { type: "api_key", key: "new" } })}\n`;
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(apiPlan, {
      apiKeys: { "pi-api-key:opencode-go": "intended-key" },
      beforePiAuthPromotion: async () => writeFile(authPath, concurrent, { mode: 0o600 }),
    });

    expect(result?.status).toBe("failed");
    expect(await readFile(authPath, "utf8")).toBe(concurrent);
  });

  it("rejects a hard-link alias added before claim and restores the validated inode", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const aliasPath = join(dir, "concurrent-alias.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(apiPlan, {
      apiKeys: { "pi-api-key:opencode-go": "intended-key" },
      beforePiAuthPromotion: async () => link(authPath, aliasPath),
    });

    expect(result?.status).toBe("failed");
    expect(await readFile(authPath, "utf8")).toBe(original);
    expect(await readFile(aliasPath, "utf8")).toBe(original);
    expect((await stat(authPath)).nlink).toBe(2);
    expect((await readdir(dir)).some((name) => name.endsWith(".backup"))).toBe(false);
  });

  it("detects an in-place write through the staged hard-link alias", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`, { mode: 0o600 });
    const attacker = `${JSON.stringify({ attacker: { type: "api_key", key: "CONCURRENT_ALIAS_WRITE" } })}\n`;
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(apiPlan, {
      apiKeys: { "pi-api-key:opencode-go": "intended-key" },
      afterPiAuthLink: async (targetPath) => writeFile(targetPath, attacker, { mode: 0o600 }),
    });

    expect(result?.status).toBe("failed");
    expect(await readFile(authPath, "utf8")).toBe(attacker);
  });

  it("detects and preserves a writer using the claimed auth inode through an open descriptor", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`;
    const concurrent = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "OPEN_FD_CONCURRENT" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const held = await open(authPath, "r+");
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    let result;
    try {
      [result] = await executeProviderSetupPlan(apiPlan, {
        apiKeys: { "pi-api-key:opencode-go": "intended-key" },
        afterPiAuthLink: async () => {
          await held.truncate(0);
          await held.write(concurrent, 0, "utf8");
          await held.sync();
        },
      });
    } finally {
      await held.close();
    }

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/concurrent credentials were retained at/u);
    const backups = (await readdir(dir)).filter((name) => name.endsWith(".backup"));
    expect(backups).toHaveLength(1);
    const recoveryPath = join(dir, backups[0]!);
    expect(await readFile(recoveryPath, "utf8")).toBe(concurrent);
    expect((await stat(recoveryPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(authPath, "utf8")).toContain("intended-key");
  });
});

function oauthPlan(cwd: string, authPath: string) {
  return planProviderSetup({
    cwd,
    piAuthPath: authPath,
    modelRefs: ["pi:openai-codex:gpt-5.6-terra"],
  });
}

function spawned(update: (cwd: string) => Promise<void>) {
  return vi.fn((_file: string, _args: readonly string[], options: { cwd?: string }) => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    queueMicrotask(async () => {
      try {
        await update(options.cwd!);
        listeners.get("close")?.(0, null);
      } catch (error) {
        listeners.get("error")?.(error);
      }
    });
    return {
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener);
      },
    };
  });
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-safe-"));
  tempDirs.push(dir);
  return dir;
}
