#!/usr/bin/env node
// Isolated built-service proof; never reads an owner's console or calls a model.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startWebServer } from "../dist/server.js";

const cache = new URL("../../../node_modules/.cache/", import.meta.url);
await mkdir(cache, { recursive: true });
const root = await mkdtemp(new URL("pdf-smoke-", cache).pathname);
let server;
try {
  const at = "2025-04-12T10:00:00Z";
  server = await startWebServer({ port: 0, stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [{ source: { schema: "agent-runtime.trace-source.v1", sourceId: "fictional-pdf-agent",
      label: "Fictional garden assistant", artifactDir: root, pid: process.pid, status: "running", health: "running",
      startedAt: at, updatedAt: at, warnings: [] }, baseUrl: "http://127.0.0.1:49999/gui" }],
    fetchImpl: async (input) => {
      assert.ok(String(input).endsWith("/v1/info"), "No provider or media call expected");
      return Response.json({ schema: 1, label: "Fictional garden assistant", model: "fixture/model", models: ["fixture/model"], capabilities: {} });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const created = await fetch(`${base}/api/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "fictional-pdf-agent" }) });
  assert.equal(created.status, 201);
  const { thread } = await created.json();
  const database = new DatabaseSync(join(server.stateDir, "state.sqlite"));
  try {
    const insert = database.prepare("INSERT INTO messages (id, thread_id, role, parts_json, created_at, updated_at, status) VALUES (?, ?, 'user', ?, ?, ?, 'complete')");
    for (let i = 0; i < 110; i++) insert.run(`fixture-${i}`, thread.id, JSON.stringify([{ type: "text", text: `Garden message ${i}: ąęłńóśźż Grüße` }]), at, at);
  } finally { database.close(); }
  const response = await fetch(`${base}/api/v1/threads/${thread.id}/export/pdf`, { method: "POST", headers: { origin: base } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition"), /^attachment;/u);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  const task = getDocument({ data: bytes });
  try {
    const document = await task.promise; let text = "";
    for (let i = 1; i <= document.numPages; i++) text += (await (await document.getPage(i)).getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
    assert.ok(text.includes("Garden message 0:")); assert.ok(text.includes("Garden message 109:"));
    assert.ok(text.includes("ąęłńóśźż Grüße"));
    console.log(`PDF smoke passed: real built service/worker, ${document.numPages} parsed pages, 110 durable messages, Unicode and download headers.`);
  } finally { await task.destroy(); }
} finally { await server?.stop(); await rm(root, { recursive: true, force: true }); }
