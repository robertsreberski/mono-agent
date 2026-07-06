import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import { openMemoryDb } from "@mono-agent/memory/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCliArgs, renderHelp, runCli } from "../cli.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseCliArgs memory", () => {
  it("parses memory subcommands and limit/json flags", () => {
    expect(parseCliArgs(["memory", "search", "deploy", "pipeline", "--limit", "3", "--json"])).toMatchObject({
      command: "memory",
      positionals: ["search", "deploy", "pipeline"],
      limit: 3,
      json: true,
    });
    expect(() => parseCliArgs(["metrics", "--limit", "3"])).toThrow(/--limit/u);
    expect(renderHelp()).toContain("mono-agent memory");
  });
});

describe("runCli memory", () => {
  it("prints a clear no-memory message", async () => {
    const dir = await agentDir({ memory: undefined });

    const { code, stdout, stderr } = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "stats"]))));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("No memory configured");
  });

  it("previews local stats, today, search, and top from the configured store", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({ memory: { mode: "lite", path: memoryRoot, writeMode: "append-host-summary" } });
    await seedLocalStore(memoryRoot);

    const stats = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "stats", "--limit", "5"]))));
    expect(stats.code).toBe(0);
    expect(stats.stdout).toContain("2 total, 2 live");
    expect(stats.stdout).toContain("mono-agent");

    const today = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "today"]))));
    expect(today.code).toBe(0);
    expect(today.stdout).toContain("Deploy pipeline uses blue green releases.");

    const beforeSearch = accessSnapshot(memoryRoot);
    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "search", "deploy", "releases"]))));
    expect(search.code).toBe(0);
    expect(search.stdout).toContain("Deploy pipeline uses blue green releases.");
    expect(search.stdout).toContain("source:");
    expect(search.stdout).toMatch(/\d+\.\d{3}/u);
    expect(accessSnapshot(memoryRoot)).toEqual(beforeSearch);

    const top = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "top", "--limit", "1"]))));
    expect(top.code).toBe(0);
    expect(top.stdout).toMatch(/Deploy pipeline uses blue green releases|Memory preview should show source metadata/u);
    expect(top.stdout).toContain("salience");
  });

  it("falls back to FTS-only when configured embeddings are down", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "journal",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          endpoint: "http://127.0.0.1:1",
          timeoutMs: 20,
          circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
        },
      },
    });
    await seedLocalStore(memoryRoot);

    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "search", "deploy", "releases"]))));

    expect(search.code).toBe(0);
    expect(search.stdout).toContain("[WARN] Semantic embeddings unavailable");
    expect(search.stdout).toContain("FTS-only");
    expect(search.stdout).toContain("Deploy pipeline uses blue green releases.");
  });

  it("proxies Supermemory search and marks local stats unavailable", async () => {
    const server = await supermemoryServer();
    try {
      const dir = await agentDir({
        memory: {
          backend: "supermemory",
          mode: "lite",
          writeMode: "capture",
          supermemory: { baseUrl: server.baseUrl, container: "agent-alpha" },
        },
      });

      const stats = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "stats"]))));
      expect(stats.code).toBe(0);
      expect(stats.stdout).toContain("Remote-only fields not known locally");
      expect(stats.stdout).toContain("agent-alpha");

      const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "search", "coffee"]))));
      expect(search.code).toBe(0);
      expect(search.stdout).toContain("Supermemory remembers coffee preference.");
      expect(server.searchBodies).toHaveLength(1);
      expect(server.searchBodies[0]).toMatchObject({ containerTag: "agent-alpha", q: "coffee" });
    } finally {
      await server.close();
    }
  });
});

async function seedLocalStore(root: string): Promise<void> {
  const store = createBujoMemoryStore({ root });
  try {
    await store.appendHostSummary("conv-1", "Deploy pipeline uses blue green releases.");
    await store.appendHostSummary("conv-2", "Memory preview should show source metadata.");
  } finally {
    await store.close();
  }
  const db = openMemoryDb({ path: join(root, "memory.db") });
  try {
    db.upsertEntity({
      id: "project:mono-agent",
      name: "mono-agent",
      type: "project",
      summary: "Config-first agent framework.",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
  } finally {
    db.close();
  }
}

function accessSnapshot(root: string): readonly {
  readonly text: string;
  readonly accessCount: number;
  readonly lastAccessedAt?: string;
}[] {
  const db = openMemoryDb({ path: join(root, "memory.db") });
  try {
    return db.topSalient(20).map((record) => ({
      text: record.text,
      accessCount: record.accessCount,
      ...(record.lastAccessedAt === undefined ? {} : { lastAccessedAt: record.lastAccessedAt }),
    }));
  } finally {
    db.close();
  }
}

async function agentDir(input: { readonly memory: unknown }): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, "IDENTITY.md"), "# Test Agent\n", "utf8");
  const config: Record<string, unknown> = {
    runtime: { model: "pi:ollama:test-model" },
    context: { identityPath: "./IDENTITY.md" },
  };
  if (input.memory !== undefined) {
    config.memory = input.memory;
  }
  await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return dir;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-memory-"));
  tempDirs.push(dir);
  return dir;
}

async function captureCli(run: () => Promise<number>): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    const code = await run();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    return await run();
  } finally {
    process.chdir(previous);
  }
}

async function withCleanMonoAgentEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MONO_AGENT_")) {
      previous.set(key, process.env[key] ?? "");
      delete process.env[key];
    }
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of previous) {
      process.env[key] = value;
    }
  }
}

async function supermemoryServer(): Promise<{
  readonly baseUrl: string;
  readonly searchBodies: Record<string, unknown>[];
  readonly close: () => Promise<void>;
}> {
  const searchBodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v4/search") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      searchBodies.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        results: [
          { id: "sm-1", memory: "Supermemory remembers coffee preference.", similarity: 0.88 },
        ],
      }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    searchBodies,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    }),
  };
}
