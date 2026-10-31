import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebServer } from "../dist/index.js";

// Built-dist, loopback-only proof. Requires the real synthetic Chromium recording
// emitted by VoiceComposer.browser.test.tsx with VITE_VOICE_SHOTS enabled.
const audio = await readFile(resolve(process.argv[2] ?? "output/voice/chromium-synthetic-recording.webm"));
assert(audio.length > 100 && audio.length < 10 * 1024 * 1024);
const root = await realpath(await mkdtemp(join(tmpdir(), "mono-voice-smoke-")));
let providerMode = "ok";
let providerRequests = 0;
let providerAborted = false;
const operatorRequests = [];
const servers = [];
let consoleServer;
async function localServer(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function bytes(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
function json(res, value, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
async function until(check) {
  const end = Date.now() + 5000;
  while (!(await check())) { assert(Date.now() < end, "Timed out waiting for fixture"); await new Promise((resolveWait) => setTimeout(resolveWait, 10)); }
}
try {
  const provider = await localServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/audio/transcriptions");
      const body = await bytes(req);
      const form = await new Request("http://fixture.local", { method: "POST", headers: req.headers, body }).formData();
      assert.equal(form.get("model"), "fixture-whisper");
      const file = form.get("file");
      assert.equal(file.name, "recording.webm");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio);
      providerRequests++;
      if (providerMode === "fail") { json(res, { error: "synthetic decode failure" }, 422); return; }
      if (providerMode === "hang") { res.on("close", () => { providerAborted = true; }); return; }
      json(res, { text: "Write a short fictional greeting." });
    } catch { json(res, { error: "fixture assertion failed" }, 500); }
  });
  const operator = await localServer(async (req, res) => {
    if (req.url === "/gui/v1/info") {
      json(res, { schema: 1, label: "Fixture operator", model: "fixture/model", models: ["fixture/model"], capabilities: { attachments: true } }); return;
    }
    if (req.url === "/gui/v1/turns") {
      operatorRequests.push(JSON.parse((await bytes(req)).toString("utf8")));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ kind: "append", delta: "Hello from the fixture." })}\n${JSON.stringify({ kind: "finish", finalText: "Hello from the fixture." })}\n`); return;
    }
    json(res, { error: "not found" }, 404);
  });
  const now = new Date().toISOString();
  consoleServer = await startWebServer({ host: "127.0.0.1", port: 0, stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    voice: { transcription: { endpoint: `${provider}/v1/audio/transcriptions`, model: "fixture-whisper", timeoutMs: 500 } },
    discoverImpl: async () => [{ source: { schema: "agent-runtime.trace-source.v1", sourceId: "fixture-agent", label: "Fixture operator", artifactDir: join(root, "artifacts"), pid: process.pid, status: "running", health: "running", startedAt: now, updatedAt: now, warnings: [] }, baseUrl: `${operator}/gui` }],
  });
  const base = `http://127.0.0.1:${consoleServer.port}`;
  const headers = { origin: base, "content-type": "application/json" };
  const created = await fetch(`${base}/api/v1/threads`, { method: "POST", headers, body: JSON.stringify({ sourceId: "fixture-agent" }) });
  assert.equal(created.status, 201);
  const { thread } = await created.json();
  const transcriptionUrl = `${base}/api/v1/threads/${thread.id}/transcriptions`;
  const transcribe = (signal) => fetch(transcriptionUrl, { method: "POST", headers: { origin: base, "content-type": "audio/webm;codecs=opus" }, body: audio, ...(signal ? { signal } : {}) });
  const transcribed = await transcribe();
  assert.equal(transcribed.status, 200);
  const { text } = await transcribed.json();
  assert.equal(operatorRequests.length, 0, "Transcription alone must not dispatch");
  const submissionId = randomUUID();
  const body = JSON.stringify({ submissionId, text, model: "fixture/model", inheritRunSettings: false });
  for (let repeat = 0; repeat < 2; repeat++) {
    const submitted = await fetch(`${base}/api/v1/threads/${thread.id}/submissions`, { method: "POST", headers, body });
    assert.equal(submitted.status, 202);
  }
  const receipt = await fetch(`${base}/api/v1/threads/${thread.id}/submissions/${submissionId}`);
  assert.equal(receipt.status, 200);
  let detail;
  await until(async () => {
    detail = await (await fetch(`${base}/api/v1/threads/${thread.id}`)).json();
    return detail.messages.some((message) => message.role === "assistant" && message.status === "complete");
  });
  assert.equal(operatorRequests.length, 1);
  assert.equal(detail.messages.filter((message) => message.role === "user").length, 1);
  assert(detail.messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === text)));
  assert(detail.messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === "Hello from the fixture.")));
  providerMode = "fail";
  assert.equal((await transcribe()).status, 502);
  providerMode = "hang";
  assert.equal((await transcribe()).status, 408);
  providerAborted = false;
  const beforeCancel = providerRequests;
  const abort = new AbortController();
  const cancelled = transcribe(abort.signal).catch(() => undefined);
  await until(() => providerRequests > beforeCancel);
  abort.abort(); await cancelled;
  await until(() => providerAborted);
  assert.equal(operatorRequests.length, 1, "Failure, timeout and cancel create zero additional requests");
  assert.deepEqual(await readdir(join(root, "state", "uploads")), []);
  const final = await (await fetch(`${base}/api/v1/threads/${thread.id}`)).json();
  assert.equal(final.messages.filter((message) => message.role === "user").length, 1);
  console.log(JSON.stringify({ proof: "built-dist-loopback-voice", syntheticAudioBytes: audio.length, multipartValidated: true, providerRequests, normalRequests: operatorRequests.length, userMessages: 1, assistantReplies: 1, replayDeduplicated: true, failureTimeoutCancelAdditionalRequests: 0, audioUploadFiles: 0, realProviderAccuracy: "unverified" }));
} finally {
  await consoleServer?.stop();
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); }
  await rm(root, { recursive: true, force: true });
}
