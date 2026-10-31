import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVoiceConfig, parseVoiceConfig } from "../voice-config.js";
import { WebTranscriptions, voiceFormat, validateVoiceAudio, WEB_VOICE_LIMITS } from "../transcription.js";
import { readVoiceUpload } from "../voice-upload.js";
import { prepareWebStatePaths } from "../state-paths.js";
import { WebService } from "../service.js";
import { startWebServer, type WebServerHandle } from "../server.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const config = { transcription: { endpoint: "http://127.0.0.1:50123/v1/audio/transcriptions", model: "fixture-whisper", language: "en", timeoutMs: 100 } };
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
const roots: string[] = [];
const servers: WebServerHandle[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() { const path = await temporaryRoot(); roots.push(path); return path; }

async function server(fetchImpl: typeof fetch = async () => Response.json({ text: "Write a short greeting." }), enabled = true) {
  const directory = await root();
  const staticDir = join(directory, "static");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Fixture</title>");
  const turns = vi.fn();
  const handle = await startWebServer({ stateDir: join(directory, "state"), staticDir, host: "127.0.0.1", port: 0, voice: enabled ? { transcription: { ...config.transcription, timeoutMs: 120_000 } } : false,
    transcriptionFetchImpl: fetchImpl, fetchImpl: operatorFetch({ onTurn: turns }), discoverImpl: async () => [fakeDiscoveredAgent()], discoveryIntervalMs: 0, purgeIntervalMs: 0 });
  servers.push(handle);
  const url = `http://127.0.0.1:${handle.port}`;
  const created = await fetch(`${url}/api/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one" }) });
  const thread = ((await created.json()) as { thread: { id: string } }).thread;
  const post = (body: NonNullable<Parameters<typeof fetch>[1]>["body"] = webm, headers: Record<string, string> = {}) => fetch(`${url}/api/v1/threads/${thread.id}/transcriptions`, { method: "POST", headers: { origin: url, "content-type": "audio/webm;codecs=opus", ...headers }, body });
  return { url, thread, post, turns, directory, handle };
}

describe("voice configuration", () => {
  it("is opt-in, private, bounded and symlink-safe", async () => {
    const directory = await root();
    expect(await loadVoiceConfig(directory)).toBeUndefined();
    await writeFile(join(directory, "voice.json"), JSON.stringify(config), { mode: 0o600 });
    expect(await loadVoiceConfig(directory)).toEqual(config);
    await chmod(join(directory, "voice.json"), 0o644);
    await expect(loadVoiceConfig(directory)).rejects.toMatchObject({ code: "invalid_voice_config" });
    expect(await loadVoiceConfig(directory, false)).toBeUndefined();
    await rm(join(directory, "voice.json"));
    await writeFile(join(directory, "other.json"), JSON.stringify(config), { mode: 0o600 });
    await symlink(join(directory, "other.json"), join(directory, "voice.json"));
    await expect(loadVoiceConfig(directory)).rejects.toMatchObject({ code: "invalid_voice_config" });
  });
  it.each([
    { transcription: { ...config.transcription, endpoint: "file:///tmp/audio" } },
    { transcription: { ...config.transcription, endpoint: "http://user:secret@localhost/audio" } },
    { transcription: { ...config.transcription, endpoint: "http://localhost/audio#secret" } },
    { transcription: { ...config.transcription, endpoint: "http://localhost/audio?key=secret" } },
    { transcription: { ...config.transcription, timeoutMs: 120001 } },
    { transcription: { ...config.transcription, language: "bad\nvalue" } },
    { transcription: { ...config.transcription, model: "" } },
    { transcription: { ...config.transcription, apiKey: "secret" } },
    null,
  ])("sanitizes invalid explicit configuration", (value) => {
    expect(() => parseVoiceConfig(value)).toThrow("Invalid voice configuration.");
    try { parseVoiceConfig(value); } catch (error) { expect(String(error)).not.toContain("secret"); }
  });
  it("invalid file does not strand the service lease", async () => {
    const stateDir = join(await root(), "state");
    await prepareWebStatePaths({ stateDir });
    await writeFile(join(stateDir, "voice.json"), "{", { mode: 0o600 });
    await expect(WebService.create({ stateDir })).rejects.toMatchObject({ code: "invalid_voice_config" });
    const service = await WebService.create({ stateDir, voice: false, discoverImpl: async () => [], discoveryIntervalMs: 0, purgeIntervalMs: 0 });
    await service.stop();
  });
});

describe("transcription protocol", () => {
  it.each([
    ["audio/webm;codecs=opus", "webm", webm],
    ['audio/ogg; codecs="opus"', "ogg", Buffer.from("OggSfixture")],
    ["audio/mp4;codecs=mp4a.40.2", "m4a", Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom")])],
  ] as const)("sends bounded multipart for %s", async (type, extension, bytes) => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      const body = init?.body as FormData;
      const file = body.get("file") as File;
      expect(file.name).toBe(`recording.${extension}`);
      expect(file.type).toBe(type.split(";")[0]);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
      expect(body.get("model")).toBe("fixture-whisper");
      expect(body.get("language")).toBe("en");
      expect([...body.keys()]).toEqual(["file", "model", "language"]);
      return Response.json({ text: "  A fictional request.  " });
    });
    const manager = new WebTranscriptions(config, fetchImpl);
    const operation = manager.reserve("one");
    try { expect(await operation.transcribe(bytes, voiceFormat(type))).toEqual({ text: "A fictional request." }); }
    finally { operation.release(); }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "audio/mpeg", "video/webm", "audio/webm;codecs=h264", "audio/mp4;other=value"])("rejects unsupported MIME %s", (type) => {
    expect(() => voiceFormat(type)).toThrow();
  });
  it("validates containers, empty and actual byte limits", () => {
    expect(() => validateVoiceAudio(Buffer.alloc(0), voiceFormat("audio/webm"))).toThrow("empty");
    expect(() => validateVoiceAudio(webm, voiceFormat("audio/ogg"))).toThrow("does not match");
    expect(() => validateVoiceAudio(Buffer.alloc(WEB_VOICE_LIMITS.maxBytes + 1), voiceFormat("audio/webm"))).toThrow("10 MiB");
  });
  it.each([
    () => Response.json({ text: "" }), () => Response.json({ text: "a".repeat(8001) }),
    () => Response.json({ text: 42 }), () => new Response("not JSON"),
    () => new Response("private diagnostic", { status: 503 }),
    () => new Response("a".repeat(65537)),
    () => new Response("a", { headers: { "content-length": "65537" } }),
  ])("rejects invalid provider results without leaking diagnostics or fallback", async (response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const operation = new WebTranscriptions(config, fetchImpl).reserve("one");
    try { await expect(operation.transcribe(webm, voiceFormat("audio/webm"))).rejects.toMatchObject({ code: "voice_provider_failed" }); }
    finally { operation.release(); }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("aborts provider on timeout, cancel and shutdown and releases concurrency", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private")), { once: true });
    }));
    const manager = new WebTranscriptions(config, fetchImpl);
    const one = manager.reserve("one");
    expect(() => manager.reserve("one")).toThrow("Another recording");
    const two = manager.reserve("two");
    expect(() => manager.reserve("three")).toThrow("Another recording");
    const pending = one.transcribe(webm, voiceFormat("audio/webm"));
    const assertion = expect(pending).rejects.toMatchObject({ code: "voice_aborted" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    one.release(); one.release();
    const three = manager.reserve("three");
    three.abort();
    await expect(three.transcribe(webm, voiceFormat("audio/webm"))).rejects.toMatchObject({ code: "voice_aborted" });
    manager.stop();
    expect(two.signal.aborted).toBe(true);
    two.release(); three.release();
    expect(() => manager.reserve("four")).toThrow("stopping");
  });
  it("bounds slow uploads and releases listeners on abort", async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const controller = new AbortController();
    const pending = readVoiceUpload(stream as unknown as IncomingMessage, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "voice_upload_timeout" });
    stream.write(webm);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(stream.listenerCount("data")).toBe(0);
    const cancelled = readVoiceUpload(new PassThrough() as unknown as IncomingMessage, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "voice_aborted" });
  });
});

describe("ephemeral raw audio HTTP boundary", () => {
  it("advertises only capability limits; transcription creates no messages, turns or upload files", async () => {
    const { url, thread, post, turns, directory } = await server();
    const bootstrap = await (await fetch(`${url}/api/v1/bootstrap`)).json() as { voice: unknown };
    expect(bootstrap.voice).toEqual({ enabled: true, ...WEB_VOICE_LIMITS });
    expect(JSON.stringify(bootstrap)).not.toContain("fixture-whisper");
    const result = await post();
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(await result.json()).toEqual({ text: "Write a short greeting." });
    expect(turns).not.toHaveBeenCalled();
    const detail = await (await fetch(`${url}/api/v1/threads/${thread.id}`)).json() as { messages: unknown[] };
    expect(detail.messages).toEqual([]);
    expect(await readdir(join(directory, "state", "uploads"))).toEqual([]);
  });
  it("requires actual exact Origin and rejects unwritable/unknown targets before provider", async () => {
    const provider = vi.fn<typeof fetch>(async () => Response.json({ text: "Hello" }));
    const { url, thread, post, turns } = await server(provider);
    for (const headers of [{ origin: "" }, { origin: "http://localhost:9999" }, { origin: url, "sec-fetch-site": "cross-site" }]) {
      expect((await post(webm, headers)).status).toBe(403);
    }
    expect((await fetch(`${url}/api/v1/threads/missing/transcriptions`, { method: "POST", headers: { origin: url, "content-type": "audio/webm" }, body: webm })).status).toBe(404);
    await fetch(`${url}/api/v1/threads/${thread.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
    expect((await post()).status).toBe(409);
    expect(provider).not.toHaveBeenCalled();
    expect(turns).not.toHaveBeenCalled();
  });
  it("rejects invalid formats/encoding/empty/oversized bodies without requests", async () => {
    const provider = vi.fn<typeof fetch>(async () => Response.json({ text: "Hello" }));
    const { post, turns } = await server(provider);
    expect((await post(webm, { "content-type": "application/json" })).status).toBe(415);
    expect((await post(webm, { "content-encoding": "gzip" })).status).toBe(415);
    expect((await post(Buffer.alloc(0))).status).toBe(400);
    expect((await post(Buffer.from("not audio"))).status).toBe(415);
    expect((await post(Buffer.alloc(WEB_VOICE_LIMITS.maxBytes + 1))).status).toBe(413);
    expect(provider).not.toHaveBeenCalled();
    expect(turns).not.toHaveBeenCalled();
  });
  it("caps actual chunked bytes", async () => {
    const { url, thread, turns } = await server();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/api/v1/threads/${thread.id}/transcriptions`, { method: "POST", headers: { origin: url, "content-type": "audio/webm" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject);
      req.write(Buffer.alloc(WEB_VOICE_LIMITS.maxBytes));
      req.end(webm);
    });
    expect(status).toBe(413);
    expect(turns).not.toHaveBeenCalled();
  });
  it("holds one reservation per thread, aborts on disconnect, and permits retry without persistence", async () => {
    let activeSignal: AbortSignal | undefined;
    const provider = vi.fn<typeof fetch>(async (_input, init) => {
      activeSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => activeSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const { url, thread, post, turns } = await server(provider);
    const controller = new AbortController();
    const pending = fetch(`${url}/api/v1/threads/${thread.id}/transcriptions`, { method: "POST", headers: { origin: url, "content-type": "audio/webm" }, body: webm, signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    expect((await post()).status).toBe(429);
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(activeSignal?.aborted).toBe(true));
    provider.mockImplementation(async () => Response.json({ text: "A retry" }));
    await vi.waitFor(async () => expect((await post()).status).toBe(200));
    expect(turns).not.toHaveBeenCalled();
  });
  it("releases an interrupted partial upload before any provider call", async () => {
    const provider = vi.fn<typeof fetch>(async () => Response.json({ text: "A retry" }));
    const { url, thread, post, turns } = await server(provider);
    const req = request(`${url}/api/v1/threads/${thread.id}/transcriptions`, { method: "POST", headers: { origin: url, "content-type": "audio/webm" } });
    req.on("error", () => undefined);
    await new Promise<void>((resolve) => req.write(webm.subarray(0, 2), () => resolve()));
    // The missing end keeps this operation in the upload phase.
    await vi.waitFor(async () => expect((await post()).status).toBe(429));
    const probes = provider.mock.calls.length;
    req.destroy();
    await vi.waitFor(async () => expect((await post()).status).toBe(200));
    expect(provider).toHaveBeenCalledTimes(probes + 1);
    expect(turns).not.toHaveBeenCalled();
  });
  it("service shutdown aborts the provider and finishes bounded operations", async () => {
    let signal: AbortSignal | undefined;
    const provider = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const { post, handle, turns } = await server(provider);
    const pending = post().catch(() => undefined);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    await handle.stop();
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(turns).not.toHaveBeenCalled();
  });
  it("is disabled without configuration", async () => {
    const { post } = await server(undefined, false);
    expect((await post()).status).toBe(409);
  });
});


describe("immutable captured execution settings", () => {
  it.each([
    { name: "captured selections", input: { model: "provider/default", effort: "medium", context1M: false, inheritRunSettings: false }, expectedModel: "provider/default", expectedEffort: "medium", expectedContext: false },
    { name: "no effort on a plain model", input: { model: "provider/plain", inheritRunSettings: false }, expectedModel: "provider/plain", expectedEffort: undefined, expectedContext: undefined },
    { name: "ordinary omitted selections still inherit", input: {}, expectedModel: "provider/fallback", expectedEffort: "high", expectedContext: true },
    { name: "explicit context null does not inherit", input: { model: "provider/default", context1M: null, inheritRunSettings: false }, expectedModel: "provider/default", expectedEffort: undefined, expectedContext: undefined },
  ])("$name", async ({ input, expectedModel, expectedEffort, expectedContext }) => {
    const seen: Record<string, unknown>[] = [];
    const upstream = operatorFetch({ onTurn: (body) => seen.push(body) });
    const service = await WebService.create({ stateDir: join(await root(), "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
      discoverImpl: async () => [fakeDiscoveredAgent()], fetchImpl: async (url, init) => {
        const response = await upstream(url, init);
        if (!String(url).endsWith("/v1/info")) return response;
        const info = await response.json() as Record<string, unknown>;
        return Response.json({ ...info, models: ["provider/default", "provider/fallback", "provider/plain"], modelOptions: {
          "provider/default": { reasoning: true, effortLevels: ["low", "medium", "high"], supportsContext1M: true },
          "provider/fallback": { reasoning: true, effortLevels: ["low", "high"], supportsContext1M: true },
          "provider/plain": { reasoning: false, effortLevels: [] },
        } });
      },
    });
    try {
      const thread = service.createThread("agent-one");
      service.patchThread(thread.id, { model: "provider/fallback", effort: "high", context1M: true });
      const submission = { submissionId: "11111111-1111-4111-8111-111111111111", text: "A synthetic captured request.", ...input };
      service.submit(thread.id, submission);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      const web = (seen[0]?.metadata as { web?: { model?: string; effort?: string; context1M?: boolean } })?.web;
      expect(web?.model).toBe(expectedModel);
      expect(web?.effort).toBe(expectedEffort);
      expect(web?.context1M).toBe(expectedContext);
      if (input.inheritRunSettings === false) {
        expect(() => service.submit(thread.id, { ...submission, inheritRunSettings: true })).toThrow("different content");
      }
    } finally { await service.stop(); }
  });
});
