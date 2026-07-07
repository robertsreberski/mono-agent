/**
 * Hermetic test helpers: real trace-source manifests + real recorded-run
 * artifacts written to tmp dirs via `@mono-agent/observability`'s own writers, so
 * the tests exercise the true read/map path rather than fixtures of a shape the
 * code never really sees.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunEventBus, RunEventFrame } from "@mono-agent/agent-contracts";
import {
  createJsonlRunRecorder,
  registerTraceSource,
  type RunArtifactKind,
  type RunSummary,
} from "@mono-agent/observability";

export async function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `session-web-${prefix}-`));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface RegisterSourceInput {
  readonly registryDir: string;
  readonly sourceId: string;
  readonly label: string;
  readonly artifactDir: string;
  readonly configPath?: string;
  readonly liveBaseUrl?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Write a real, running trace-source manifest (no heartbeat timer to clean up). */
export async function registerSource(input: RegisterSourceInput): Promise<void> {
  await registerTraceSource({
    registryDir: input.registryDir,
    sourceId: input.sourceId,
    label: input.label,
    artifactDir: input.artifactDir,
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    ...(input.liveBaseUrl === undefined && input.metadata === undefined
      ? {}
      : {
          metadata: {
            ...(input.metadata ?? {}),
            ...(input.liveBaseUrl === undefined
              ? {}
              : { channels: { live: { kind: "running", baseUrl: input.liveBaseUrl } } }),
          },
        }),
  });
}

export interface SeedRunInput {
  readonly artifactDir: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly userInput?: string;
  readonly text: string;
  readonly source?: string;
  readonly artifactKind?: RunArtifactKind;
  readonly providerSessionId?: string;
  readonly isolated?: boolean;
  /** Compiled system prompt persisted on the summary (drives `Session.sysPrompt`). */
  readonly systemPrompt?: string;
  /** A raw `turn_context` event body (minus `type`/`timestamp`) recorded before the turn. */
  readonly turnContext?: Record<string, unknown>;
  /** Fixed clock (ms) — controls `startedAt`, so multiple runs sort deterministically. */
  readonly at: number;
}

/** Write one real recorded run (summary + events) via the JSONL recorder. */
export async function seedRun(input: SeedRunInput): Promise<RunSummary> {
  await mkdir(input.artifactDir, { recursive: true });
  const recorder = createJsonlRunRecorder({
    runId: input.runId,
    conversationId: input.conversationId,
    artifactDir: input.artifactDir,
    clock: () => input.at,
    ...(input.userInput === undefined ? {} : { userInput: input.userInput }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.artifactKind === undefined ? {} : { artifactKind: input.artifactKind }),
  });
  if (input.turnContext !== undefined) {
    recorder.onEvent({
      type: "turn_context",
      timestamp: new Date(input.at).toISOString(),
      ...input.turnContext,
    });
  }
  recorder.onEvent({
    type: "assistant",
    timestamp: new Date(input.at).toISOString(),
    message: { content: [{ type: "text", text: input.text }] },
  });
  return await recorder.finish({
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "pi:ollama:qwen",
    ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
    ...(input.isolated === undefined ? {} : { isolated: input.isolated }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
  });
}

/** Write one real recorded run that is still marked running on disk. */
export async function seedRunningRun(input: SeedRunInput): Promise<RunSummary> {
  await mkdir(input.artifactDir, { recursive: true });
  const recorder = createJsonlRunRecorder({
    runId: input.runId,
    conversationId: input.conversationId,
    artifactDir: input.artifactDir,
    clock: () => input.at,
    ...(input.userInput === undefined ? {} : { userInput: input.userInput }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.artifactKind === undefined ? {} : { artifactKind: input.artifactKind }),
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: new Date(input.at).toISOString(),
    message: { content: [{ type: "text", text: input.text }] },
  });
  const summary = await recorder.start?.();
  if (summary === undefined) {
    throw new Error("JSONL run recorder did not expose start().");
  }
  return summary;
}

export interface TinySseServer {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/**
 * A minimal SSE server replicating the operator-adapter live `/v1/events` contract
 * (replay the ring buffer, then stream every published frame as `data: <json>`).
 * Stands in for the real adapter, which this operator-surface package may not
 * import — the live client reaches it over HTTP exactly as it would the real one.
 */
export async function startTinySseServer(bus: RunEventBus): Promise<TinySseServer> {
  const openResponses = new Set<{ end(): void }>();
  const server: Server = createServer((req, res) => {
    if (req.url === undefined || !req.url.endsWith("/v1/events")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const write = (frame: RunEventFrame): void => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    };
    for (const frame of bus.recentFrames()) {
      write(frame);
    }
    const unsubscribe = bus.subscribe(write);
    const entry = { end: () => res.end() };
    openResponses.add(entry);
    res.on("close", () => {
      unsubscribe();
      openResponses.delete(entry);
    });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Tiny SSE server did not receive a TCP address.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/live`;

  return {
    baseUrl,
    async stop() {
      for (const entry of openResponses) {
        entry.end();
      }
      openResponses.clear();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/** Poll `predicate` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  predicate: () => T | undefined,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const intervalMs = options.intervalMs ?? 10;
  const start = Date.now();
  for (;;) {
    const result = predicate();
    if (result !== undefined && result !== false) {
      return result;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out.");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

/** Open an SSE URL and collect the first `count` `data:` frames, then abort. */
export async function readSseFrames(
  url: string,
  count: number,
  headers: Record<string, string> = {},
): Promise<unknown[]> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("SSE response had no body.");
  }
  const decoder = new TextDecoder();
  const frames: unknown[] = [];
  let buffer = "";
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (chunk.startsWith("data:")) {
          frames.push(JSON.parse(chunk.slice("data:".length).trim()));
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
  return frames;
}
