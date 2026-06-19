import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAppSessionsRoot } from "../app-config.js";
import { purgeSessions } from "../sessions.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sessions-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: unknown): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(json));
  return configPath;
}

function inputFor(configPath: string, env: Record<string, string | undefined> = {}) {
  return { env, cwd: dir, configPath };
}

describe("resolveAppSessionsRoot", () => {
  it("returns undefined when no pi sessions root is configured (in-memory)", async () => {
    const configPath = await writeConfig({ runtime: { model: "pi:x:y" } });
    expect(await resolveAppSessionsRoot(inputFor(configPath))).toBeUndefined();
  });

  it("resolves providers.piNative.piSessionsRoot relative to cwd", async () => {
    const configPath = await writeConfig({ providers: { piNative: { piSessionsRoot: "./.mono-agent/sessions" } } });
    expect(await resolveAppSessionsRoot(inputFor(configPath))).toBe(join(dir, ".mono-agent", "sessions"));
  });

  it("prefers the MONO_AGENT_PI_SESSIONS_ROOT env override over the config file", async () => {
    const configPath = await writeConfig({ providers: { piNative: { piSessionsRoot: "./from-config" } } });
    const root = await resolveAppSessionsRoot(inputFor(configPath, { MONO_AGENT_PI_SESSIONS_ROOT: "./from-env" }));
    expect(root).toBe(join(dir, "from-env"));
  });

  it("returns undefined (does not throw) when the config file is malformed", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, "{ not valid json");
    expect(await resolveAppSessionsRoot(inputFor(configPath))).toBeUndefined();
  });
});

describe("purgeSessions", () => {
  it("is a no-op when sessions are in-memory (no root configured)", async () => {
    const configPath = await writeConfig({ runtime: { model: "pi:x:y" } });
    const result = await purgeSessions(inputFor(configPath));
    expect(result.removed).toBe(false);
    expect(result.files).toBe(0);
  });

  it("removes the sessions store and counts the nested jsonl files", async () => {
    const configPath = await writeConfig({ providers: { piNative: { piSessionsRoot: "./.mono-agent/sessions" } } });
    const root = join(dir, ".mono-agent", "sessions");
    // The runtime nests session files under a per-workspace subdirectory.
    const workspaceDir = join(root, "--workspace--");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "a.jsonl"), "{}\n");
    await writeFile(join(workspaceDir, "b.jsonl"), "{}\n");
    await writeFile(join(workspaceDir, "notes.txt"), "ignored — not a session file");

    const result = await purgeSessions(inputFor(configPath));

    expect(result.removed).toBe(true);
    expect(result.root).toBe(root);
    expect(result.files).toBe(2);
    await expect(stat(root)).rejects.toThrow();
  });

  it("is a no-op when the configured store does not exist on disk yet", async () => {
    const configPath = await writeConfig({ providers: { piNative: { piSessionsRoot: "./.mono-agent/sessions" } } });
    const result = await purgeSessions(inputFor(configPath));
    expect(result.removed).toBe(false);
    expect(result.files).toBe(0);
  });
});
