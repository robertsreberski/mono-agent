import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RUNS_HEALTH_STALE_RUNNING_MS } from "@mono-agent/observability";

import { startSessionWebServer } from "../server.js";
import type { SessionWebServerHandle } from "../server.js";
import { makeTmpDir, readSseFrames, registerSource, removeDir, seedRun, seedRunningRun } from "./helpers.js";

const tmpDirs: string[] = [];
let server: SessionWebServerHandle | undefined;

async function tmp(prefix: string): Promise<string> {
  const dir = await makeTmpDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await Promise.all(tmpDirs.splice(0).map(removeDir));
});

interface Fixture {
  readonly registryDir: string;
  readonly staticDir: string;
  readonly sourceId: string;
  readonly runId: string;
}

async function fixture(): Promise<Fixture> {
  const registryDir = await tmp("reg");
  const artifactDir = join(await tmp("agent"), "runs");
  const staticDir = await tmp("static");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>session-web</title><div id=app></div>", "utf8");
  await seedRun({
    artifactDir,
    runId: "run-http-1",
    conversationId: "chat:http",
    userInput: "Ping",
    text: "Pong.",
    source: "chat",
    at: 1_700_000_000,
  });
  await registerSource({ registryDir, sourceId: "http-agent", label: "HTTP Agent", artifactDir });
  return { registryDir, staticDir, sourceId: "http-agent", runId: "run-http-1" };
}

describe("startSessionWebServer", () => {
  it("serves the JSON API for instances and sessions", async () => {
    const fix = await fixture();
    server = await startSessionWebServer({ registryDirs: [fix.registryDir], port: 0, staticDir: fix.staticDir });

    const instances = (await (await fetch(`${server.url}api/instances`)).json()) as {
      instances: { sourceId: string; counts: { runs: number } }[];
    };
    expect(instances.instances).toHaveLength(1);
    expect(instances.instances[0]?.sourceId).toBe("http-agent");
    expect(instances.instances[0]?.counts.runs).toBe(1);

    const all = (await (await fetch(`${server.url}api/sessions`)).json()) as {
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
      sessions: { id: string; finalText: string; steps: unknown[]; totals: { steps: number } }[];
    };
    expect(all.sessions.map((session) => session.id)).toContain("run-http-1");
    expect(all).toMatchObject({ total: 1, offset: 0, limit: 1, hasMore: false });
    const listed = all.sessions.find((session) => session.id === "run-http-1");
    expect(listed?.finalText).toBe("");
    expect((listed as { instr?: string } | undefined)?.instr).toBe("");
    expect(listed?.steps).toEqual([]);
    expect(listed?.totals.steps).toBeGreaterThan(0);

    const limited = (await (await fetch(`${server.url}api/sessions?instance=${fix.sourceId}&limit=0`)).json()) as {
      sessions: unknown[];
    };
    expect(limited.sessions).toHaveLength(0);

    const one = (await (await fetch(`${server.url}api/sessions/${fix.sourceId}/${fix.runId}`)).json()) as {
      session: { id: string; sourceId: string; finalText: string; steps: unknown[] };
    };
    expect(one.session.id).toBe("run-http-1");
    expect(one.session.sourceId).toBe(fix.sourceId);
    expect(one.session.finalText).toBe("Pong.");
    expect(one.session.steps.length).toBeGreaterThan(0);

    const missing = await fetch(`${server.url}api/sessions/${fix.sourceId}/nope`);
    expect(missing.status).toBe(404);
  });

  it("serves instance timezone metadata from the discovered config", async () => {
    const registryDir = await tmp("reg");
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    const configPath = join(agentDir, "mono-agent.config.json");
    const staticDir = await tmp("static");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>session-web</title><div id=app></div>", "utf8");
    await writeFile(configPath, JSON.stringify({ runtime: { session: { rolloverTimezone: "Europe/Amsterdam" } } }), "utf8");
    await registerSource({ registryDir, sourceId: "tz-agent", label: "TZ Agent", artifactDir, configPath });

    server = await startSessionWebServer({ registryDirs: [registryDir], port: 0, staticDir });

    const instances = (await (await fetch(`${server.url}api/instances`)).json()) as {
      instances: { sourceId: string; timeZone?: string; timezone?: string }[];
    };
    expect(instances.instances).toEqual([
      expect.objectContaining({ sourceId: "tz-agent", timeZone: "Europe/Amsterdam", timezone: "Europe/Amsterdam" }),
    ]);
  });

  it("reports stale running sessions as stalled without rewriting artifacts", async () => {
    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    const staticDir = await tmp("static");
    const now = 1_700_100_000_000;
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>session-web</title><div id=app></div>", "utf8");
    await seedRunningRun({
      artifactDir,
      runId: "run-stale-running",
      conversationId: "chat:stale",
      text: "stale answer",
      source: "chat",
      at: now - RUNS_HEALTH_STALE_RUNNING_MS - 1,
    });
    await registerSource({ registryDir, sourceId: "http-agent", label: "HTTP Agent", artifactDir });

    server = await startSessionWebServer({ registryDirs: [registryDir], port: 0, staticDir, clock: () => now });

    const listed = (await (await fetch(`${server.url}api/sessions`)).json()) as {
      sessions: { id: string; status: string; steps: unknown[] }[];
    };
    expect(listed.sessions).toMatchObject([{ id: "run-stale-running", status: "stalled", steps: [] }]);

    const detail = (await (await fetch(`${server.url}api/sessions/http-agent/run-stale-running`)).json()) as {
      session: { id: string; status: string; finalText: string };
    };
    expect(detail.session).toMatchObject({ id: "run-stale-running", status: "stalled", finalText: "stale answer" });

    const frames = await readSseFrames(`${server.url}api/stream`, 2) as (
      | { t: "instances" }
      | { t: "session_upsert"; session: { id: string; status: string; steps: unknown[] } }
    )[];
    expect(frames[1]?.t === "session_upsert" ? frames[1].session : undefined).toMatchObject({
      id: "run-stale-running",
      status: "stalled",
      steps: [],
    });
  });

  it("pages older disk history beyond the retained cache", async () => {
    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    const staticDir = await tmp("static");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>session-web</title><div id=app></div>", "utf8");
    for (let idx = 0; idx < 5; idx += 1) {
      await seedRun({
        artifactDir,
        runId: `run-${idx}`,
        conversationId: `chat:${idx}`,
        text: `answer ${idx}`,
        source: "chat",
        at: 1_700_000_000_000 + idx,
      });
    }
    await registerSource({ registryDir, sourceId: "http-agent", label: "HTTP Agent", artifactDir });

    server = await startSessionWebServer({
      registryDirs: [registryDir],
      port: 0,
      staticDir,
      maxRunsPerInstance: 2,
    });

    const retained = (await (await fetch(`${server.url}api/sessions`)).json()) as {
      sessions: { id: string }[];
    };
    expect(retained.sessions.map((session) => session.id)).toEqual(["run-4", "run-3"]);

    const page = (await (await fetch(`${server.url}api/sessions?offset=3&limit=2`)).json()) as {
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
      sessions: { id: string; steps: unknown[]; finalText: string }[];
    };
    expect(page).toMatchObject({ total: 5, offset: 3, limit: 2, hasMore: false });
    expect(page.sessions.map((session) => session.id)).toEqual(["run-1", "run-0"]);
    expect(page.sessions.every((session) => session.finalText === "" && session.steps.length === 0)).toBe(true);
  });

  it("excludes memory runs from the API by default and includes them with includeMemory", async () => {
    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    const staticDir = await tmp("static");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>session-web</title><div id=app></div>", "utf8");
    await seedRun({
      artifactDir,
      runId: "run-agent",
      conversationId: "chat:http",
      text: "agent answer",
      source: "chat",
      at: 1_700_000_000,
    });
    await seedRun({
      artifactDir,
      runId: "mem-new",
      conversationId: "memory:capture:distill",
      text: "new memory",
      source: "memory",
      artifactKind: "memory",
      at: 1_700_000_100,
    });
    await registerSource({ registryDir, sourceId: "http-agent", label: "HTTP Agent", artifactDir });

    server = await startSessionWebServer({ registryDirs: [registryDir], port: 0, staticDir });
    const defaultSessions = (await (await fetch(`${server.url}api/sessions`)).json()) as {
      sessions: { id: string }[];
    };
    expect(defaultSessions.sessions.map((session) => session.id)).toEqual(["run-agent"]);
    const defaultMemoryDetail = await fetch(`${server.url}api/sessions/http-agent/mem-new`);
    expect(defaultMemoryDetail.status).toBe(404);
    await server.stop();

    server = await startSessionWebServer({ registryDirs: [registryDir], port: 0, staticDir, includeMemory: true });
    const withMemorySessions = (await (await fetch(`${server.url}api/sessions`)).json()) as {
      sessions: { id: string }[];
    };
    expect(withMemorySessions.sessions.map((session) => session.id).sort()).toEqual(["mem-new", "run-agent"]);
    const memoryDetail = (await (await fetch(`${server.url}api/sessions/http-agent/mem-new`)).json()) as {
      session: { id: string; source: string; finalText: string };
    };
    expect(memoryDetail.session).toMatchObject({ id: "mem-new", source: "memory", finalText: "new memory" });
  });

  it("streams an initial instances frame then session upserts over SSE", async () => {
    const fix = await fixture();
    server = await startSessionWebServer({ registryDirs: [fix.registryDir], port: 0, staticDir: fix.staticDir });

    const controller = new AbortController();
    const response = await fetch(`${server.url}api/stream`, { signal: controller.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("stream had no body");
    }
    const decoder = new TextDecoder();
    const frames: ({ t: "instances" } | { t: "session_upsert"; session: { steps: unknown[]; finalText: string } })[] = [];
    let buffer = "";
    try {
      while (frames.length < 2) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          if (chunk.startsWith("data:")) {
            frames.push(
              JSON.parse(chunk.slice("data:".length).trim()) as
                | { t: "instances" }
                | { t: "session_upsert"; session: { steps: unknown[]; finalText: string } },
            );
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) {
          break;
        }
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }

    expect(frames[0]?.t).toBe("instances");
    expect(frames[1]?.t).toBe("session_upsert");
    expect(frames[1]?.t === "session_upsert" ? frames[1].session.steps : undefined).toEqual([]);
    expect(frames[1]?.t === "session_upsert" ? frames[1].session.finalText : undefined).toBe("");
  });

  it("does not drop the initial SSE snapshot for a run with oversized detail", async () => {
    const registryDir = await tmp("reg");
    const artifactDir = join(await tmp("agent"), "runs");
    const staticDir = await tmp("static");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>session-web</title><div id=app></div>", "utf8");
    await seedRun({
      artifactDir,
      runId: "run-large-detail",
      conversationId: "chat:large",
      userInput: "Summarize the large artifact",
      text: "x".repeat(1_100_000),
      source: "chat",
      at: 1_700_000_100_000,
    });
    await registerSource({ registryDir, sourceId: "large-agent", label: "Large Agent", artifactDir });
    const warn = vi.fn();
    server = await startSessionWebServer({
      registryDirs: [registryDir],
      port: 0,
      staticDir,
      logger: { warn },
    });

    const frames = await readSseFrames(`${server.url}api/stream`, 2) as (
      | { t: "instances" }
      | { t: "session_upsert"; session: { id: string; finalText: string; instr: string; steps: unknown[] } }
    )[];

    expect(frames[0]?.t).toBe("instances");
    expect(frames[1]?.t).toBe("session_upsert");
    expect(frames[1]?.t === "session_upsert" ? frames[1].session.id : undefined).toBe("run-large-detail");
    expect(frames[1]?.t === "session_upsert" ? frames[1].session.finalText : undefined).toBe("");
    expect(frames[1]?.t === "session_upsert" ? frames[1].session.instr : undefined).toBe("");
    expect(frames[1]?.t === "session_upsert" ? frames[1].session.steps : undefined).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(
      "Dropped oversized browser SSE frame.",
      expect.objectContaining({ frameType: "session_upsert" }),
    );
  });

  it("stops promptly with an open browser SSE stream", async () => {
    const fix = await fixture();
    server = await startSessionWebServer({ registryDirs: [fix.registryDir], port: 0, staticDir: fix.staticDir });

    const controller = new AbortController();
    const response = await fetch(`${server.url}api/stream`, { signal: controller.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("stream had no body");
    }

    const stopPromise = server.stop().then(() => "stopped" as const);
    server = undefined;
    try {
      await expect(Promise.race([stopPromise, sleep(300).then(() => "timeout" as const)])).resolves.toBe("stopped");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await stopPromise.catch(() => undefined);
    }
  });

  it("serves the SPA index.html for the root and unknown client routes", async () => {
    const fix = await fixture();
    server = await startSessionWebServer({ registryDirs: [fix.registryDir], port: 0, staticDir: fix.staticDir });

    const root = await fetch(`${server.url}`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("session-web");

    const clientRoute = await fetch(`${server.url}sessions/http-agent/run-http-1`);
    expect(clientRoute.status).toBe(200);
    expect(await clientRoute.text()).toContain("id=app");

    const unknownApi = await fetch(`${server.url}api/does-not-exist`);
    expect(unknownApi.status).toBe(404);
  });

  it("refuses to bind a non-loopback host unless allowNonLoopback is set", async () => {
    const fix = await fixture();
    await expect(
      startSessionWebServer({ registryDirs: [fix.registryDir], host: "0.0.0.0", port: 0, staticDir: fix.staticDir }),
    ).rejects.toThrow(/non-loopback/u);
  });

  it("requires an auth token before binding a non-loopback host", async () => {
    const fix = await fixture();
    await expect(
      startSessionWebServer({
        registryDirs: [fix.registryDir],
        host: "0.0.0.0",
        port: 0,
        allowNonLoopback: true,
        staticDir: fix.staticDir,
      }),
    ).rejects.toThrow(/auth token/u);
  });

  it("requires bearer auth on API and stream routes for non-loopback binds", async () => {
    const fix = await fixture();
    server = await startSessionWebServer({
      registryDirs: [fix.registryDir],
      host: "0.0.0.0",
      port: 0,
      allowNonLoopback: true,
      staticDir: fix.staticDir,
      authToken: "session-secret",
    });

    const apiUrl = localLoopbackUrl(server.url, "api/instances");
    const unauthApi = await fetch(apiUrl);
    expect(unauthApi.status).toBe(401);

    const wrongApi = await fetch(apiUrl, { headers: { authorization: "Bearer wrong" } });
    expect(wrongApi.status).toBe(401);

    const authedApi = await fetch(apiUrl, { headers: { authorization: "Bearer session-secret" } });
    expect(authedApi.status).toBe(200);

    const queryAuthedApi = await fetch(localLoopbackUrl(server.url, "api/instances?token=session-secret"));
    expect(queryAuthedApi.status).toBe(200);

    const unauthStream = await fetch(localLoopbackUrl(server.url, "api/stream"));
    const unauthStreamStatus = unauthStream.status;
    await unauthStream.body?.cancel().catch(() => undefined);
    expect(unauthStreamStatus).toBe(401);

    const authedStream = await fetch(localLoopbackUrl(server.url, "api/stream"), {
      headers: { authorization: "Bearer session-secret" },
    });
    const authedStreamStatus = authedStream.status;
    await authedStream.body?.cancel().catch(() => undefined);
    expect(authedStreamStatus).toBe(200);
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function localLoopbackUrl(serverUrl: string, path: string): string {
  const url = new URL(serverUrl);
  url.hostname = "127.0.0.1";
  const separator = path.indexOf("?");
  url.pathname = separator === -1 ? path : path.slice(0, separator);
  url.search = separator === -1 ? "" : path.slice(separator);
  return url.toString();
}
