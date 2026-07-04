import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startSessionWebServer } from "../server.js";
import type { SessionWebServerHandle } from "../server.js";
import { makeTmpDir, registerSource, removeDir, seedRun } from "./helpers.js";

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

    const all = (await (await fetch(`${server.url}api/sessions`)).json()) as { sessions: { id: string }[] };
    expect(all.sessions.map((session) => session.id)).toContain("run-http-1");

    const limited = (await (await fetch(`${server.url}api/sessions?instance=${fix.sourceId}&limit=0`)).json()) as {
      sessions: unknown[];
    };
    expect(limited.sessions).toHaveLength(0);

    const one = (await (await fetch(`${server.url}api/sessions/${fix.sourceId}/${fix.runId}`)).json()) as {
      session: { id: string; sourceId: string; finalText: string };
    };
    expect(one.session.id).toBe("run-http-1");
    expect(one.session.sourceId).toBe(fix.sourceId);
    expect(one.session.finalText).toBe("Pong.");

    const missing = await fetch(`${server.url}api/sessions/${fix.sourceId}/nope`);
    expect(missing.status).toBe(404);
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
    const frames: { t: string }[] = [];
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
            frames.push(JSON.parse(chunk.slice("data:".length).trim()) as { t: string });
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
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
