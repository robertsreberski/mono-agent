import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebServer } from "../dist/index.js";

// Built-dist, loopback-only proof. Requires the real synthetic Chromium recording
// emitted by VoiceConversation.browser.test.tsx with VITE_VOICE_SHOTS enabled.
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
  const options = { host: "127.0.0.1", port: 0, stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    voice: { transcription: { endpoint: `${provider}/v1/audio/transcriptions`, model: "fixture-whisper", timeoutMs: 500 } },
    discoverImpl: async () => [{ source: { schema: "agent-runtime.trace-source.v1", sourceId: "fixture-agent", label: "Fixture operator", artifactDir: join(root, "artifacts"), pid: process.pid, status: "running", health: "running", startedAt: now, updatedAt: now, warnings: [] }, baseUrl: `${operator}/gui` }],
  };
  consoleServer = await startWebServer(options);
  let base = `http://127.0.0.1:${consoleServer.port}`;
  const headers = { origin: base, "content-type": "application/json" };
  const created = await fetch(`${base}/api/v1/threads`, { method: "POST", headers, body: JSON.stringify({ sourceId: "fixture-agent" }) });
  assert.equal(created.status, 201);
  const { thread } = await created.json();
  const transcriptionUrl = `${base}/api/v1/threads/${thread.id}/transcriptions`;
  const transcribe = (signal) => fetch(transcriptionUrl, { method: "POST", headers: { origin: base, "content-type": "audio/webm;codecs=opus" }, body: audio, ...(signal ? { signal } : {}) });
  assert.equal((await (await fetch(`${base}/api/v1/bootstrap`)).json()).voice.maxSeconds, undefined);
  async function stage(name, contentType, content) {
    const reserved = await fetch(`${base}/api/v1/uploads`, { method: "POST", headers, body: JSON.stringify({ name, contentType, sizeBytes: content.length }) });
    assert.equal(reserved.status, 201);
    const { attachment } = await reserved.json();
    assert.equal(attachment.status, "staged");
    const uploaded = await fetch(`${base}/api/v1/uploads/${attachment.id}/content`, { method: "PUT", headers: { origin: base, "content-type": "application/octet-stream" }, body: content });
    assert.equal(uploaded.status, 200);
    return attachment;
  }
  const recording = await stage("recording.webm", "audio/webm", audio);
  const note = await stage("plants.txt", "text/plain", Buffer.from("A fictional herb list."));
  const removed = await stage("discarded.webm", "audio/webm", audio);
  assert.equal((await fetch(`${base}/api/v1/uploads/${removed.id}`, { method: "DELETE", headers: { origin: base } })).status, 204);
  assert.equal((await fetch(`${base}/api/v1/uploads/${removed.id}/content`)).status, 404);
  providerMode = "fail";
  assert.equal((await transcribe()).status, 502);
  assert.equal(operatorRequests.length, 0, "Failed preparation must not dispatch or consume staged files");
  assert.equal((await fetch(`${base}/api/v1/uploads/${recording.id}/content`)).status, 200);
  providerMode = "ok";
  const transcribed = await transcribe();
  assert.equal(transcribed.status, 200);
  const transcript = (await transcribed.json()).text;
  const text = `Plan an easy-care garden.\n\nAudio transcript 1 ("recording.webm"):\n${transcript}`;
  const preparedProviderRequests = providerRequests;
  assert.equal(operatorRequests.length, 0, "Transcription alone must not dispatch");
  const submissionId = randomUUID();
  const body = JSON.stringify({ submissionId, text, attachmentIds: [recording.id, note.id], model: "fixture/model", inheritRunSettings: false });
  for (let repeat = 0; repeat < 2; repeat++) {
    const submitted = await fetch(`${base}/api/v1/threads/${thread.id}/submissions`, { method: "POST", headers, body });
    assert.equal(submitted.status, 202);
  }
  assert.equal(providerRequests, preparedProviderRequests, "Exact prepared retry must not transcribe again");
  const receipt = await fetch(`${base}/api/v1/threads/${thread.id}/submissions/${submissionId}`);
  assert.equal(receipt.status, 200);
  let detail;
  await until(async () => {
    detail = await (await fetch(`${base}/api/v1/threads/${thread.id}`)).json();
    return detail.messages.some((message) => message.role === "assistant" && message.status === "complete");
  });
  assert.equal(operatorRequests.length, 1);
  assert.equal(operatorRequests[0].attachments.length, 2);
  const retained = detail.messages.find((message) => message.role === "user").attachments;
  assert.deepEqual(retained.map((value) => value.id), [recording.id, note.id]);
  assert(retained.every((value) => value.status === "committed"));
  async function download() {
    const response = await fetch(`${base}/api/v1/uploads/${recording.id}/content`);
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-disposition"), /^attachment;/u);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  }
  await download();
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
  assert((await readdir(join(root, "state", "uploads"))).length > 0, "Committed audio/files must be retained normally");
  await consoleServer.stop(); consoleServer = await startWebServer(options);
  base = `http://127.0.0.1:${consoleServer.port}`;
  await download();
  const final = await (await fetch(`${base}/api/v1/threads/${thread.id}`)).json();
  assert.equal(final.messages.filter((message) => message.role === "user").length, 1);
  console.log(JSON.stringify({ proof: "built-dist-loopback-recorded-attachments", syntheticAudioBytes: audio.length, multipartValidated: true, providerRequests, normalRequests: operatorRequests.length, userMessages: 1, assistantReplies: 1, replayDeduplicated: true, failureTimeoutCancelAdditionalRequests: 0, retainedAudioAndTextAttachments: 2, retainedThroughTestServiceReopen: true, forcedDownloadNoSniff: true, removedDraftUnavailable: true, fixedDurationClaimAbsent: true, realProviderAccuracy: "unverified" }));
} finally {
  await consoleServer?.stop();
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); }
  await rm(root, { recursive: true, force: true });
}
