import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { request, createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startWebServer, type WebServerHandle } from "../server.js";
import { WebService } from "../service.js";
import * as worker from "../pdf-worker-client.js";
import { PDF_LIMITS } from "../pdf-model.js";
import { fakeDiscoveredAgent, operatorFetch } from "./helpers.js";
import { isPdfImageOperator } from "./pdf-test-helpers.js";

const handles: WebServerHandle[] = []; const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(handles.splice(0).map((s) => s.stop())); await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
async function setup() {
  const cache = new URL("../../../../node_modules/.cache/", import.meta.url);
  await mkdir(cache, { recursive: true }); const root = await mkdtemp(fileURLToPath(new URL("pdf-test-", cache))); roots.push(root);
  const fetchImpl = vi.fn(operatorFetch());
  const handle = await startWebServer({ port: 0, stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent()], fetchImpl }); handles.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;
  const created = await fetch(`${base}/api/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one", title: "Żółć / garden" }) });
  const id = ((await created.json()) as { thread: { id: string } }).thread.id;
  await fetch(`${base}/api/v1/threads/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Żółć / garden" }) });
  const database = new DatabaseSync(join(handle.stateDir, "state.sqlite"));
  const insert = (key: string, role: string, parts: unknown[], suppressed = 0): void => {
    database.prepare("INSERT INTO messages (id, thread_id, role, parts_json, created_at, updated_at, status, cron_suppressed) VALUES (?, ?, ?, ?, ?, ?, 'complete', ?)")
      .run(key, id, role, JSON.stringify(parts), "2025-04-12T10:00:00Z", "2025-04-12T10:00:00Z", suppressed);
  };
  const post = (threadId = id, headers: Record<string, string> = { origin: base }) => fetch(`${base}/api/v1/threads/${threadId}/export/pdf`, { method: "POST", headers });
  return { handle, base, id, database, insert, post, fetchImpl };
}

describe("PDF HTTP public boundary", () => {
  it("exports the full durable transcript, including archived history, with safe download headers", async () => {
    const s = await setup();
    try {
      for (let i = 0; i < 110; i++) s.insert(`user-${i}`, "user", [{ type: "text", text: `Visible message ${i}` }]);
      s.insert("hidden", "assistant", [{ type: "text", text: "FORBIDDEN_SUPPRESSED" }], 1);
      s.insert("system", "system", [{ type: "text", text: "FORBIDDEN_SYSTEM" }]);
      s.insert("reply", "assistant", [{ type: "text", text: "Earlier narration" }, { type: "reasoning", text: "FORBIDDEN_THINKING" }, { type: "text", text: "Final shared reply" }]);
      await fetch(`${s.base}/api/v1/threads/${s.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
      const response = await s.post(); expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toMatch(/attachment; filename=".*\.pdf"; filename\*=UTF-8''%C5%BB/u);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      const bytes = new Uint8Array(await response.arrayBuffer()); expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
      const task = getDocument({ data: bytes }); const pdf = await task.promise; let text = "";
      for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
      expect(text).toContain("Visible message 0"); expect(text).toContain("Visible message 109"); expect(text).toContain("Final shared reply");
      expect(text).not.toContain("FORBIDDEN"); expect(text).not.toContain("Earlier narration"); await task.destroy();
    } finally { s.database.close(); }
  });

  it("enforces actual trusted Host / exact origin boundaries and missing-thread errors", async () => {
    const s = await setup(); s.database.close();
    for (const headers of [{ origin: "https://example.invalid" }, { origin: s.base, "sec-fetch-site": "cross-site" }, {}]) {
      expect((await s.post(s.id, headers)).status).toBe(403);
    }
    expect((await s.post("not-found")).status).toBe(404);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${s.base}/api/v1/threads/${s.id}/export/pdf`, { method: "POST", headers: { Host: "evil.invalid", Origin: "http://evil.invalid" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end();
    }); expect(status).toBe(421);
  });

  it("rejects excessive source before rendering and releases admission after failures", async () => {
    const s = await setup();
    try {
      const insert = s.database.prepare("INSERT INTO messages (id, thread_id, role, parts_json, created_at, updated_at, status) VALUES (?, ?, 'user', '[]', '2025-01-01', '2025-01-01', 'complete')");
      s.database.exec("BEGIN"); for (let i = 0; i <= PDF_LIMITS.rows; i++) insert.run(`row-${i}`, s.id); s.database.exec("COMMIT");
      const response = await s.post(); expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: "pdf_too_large" } });
      s.database.prepare("DELETE FROM messages WHERE thread_id = ?").run(s.id);
      expect((await s.post()).status).toBe(200);
    } finally { s.database.close(); }
  });

  it("serves named media placeholders without fetching arbitrary Markdown URLs", async () => {
    const s = await setup();
    const requests: string[] = [];
    const canary = createServer((req, res) => { requests.push(req.url ?? ""); res.end("Must not be requested"); });
    await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
    const address = canary.address(); if (address === null || typeof address === "string") throw new Error("Missing canary port");
    const remote = `http://127.0.0.1:${address.port}/private/markdown.png`;
    try {
      s.insert("image", "assistant", [{ type: "text", text: `![private](${remote})` },
        { type: "attachment", id: "missing", artifactId: "missing", name: "offline.png", mediaType: "image/png", sizeBytes: 100, integrityId: `sha256:${"0".repeat(64)}`, expiresAt: "2020-01-01T00:00:00Z" }]);
      const response = await s.post(); expect(response.status).toBe(200);
      const task = getDocument({ data: new Uint8Array(await response.arrayBuffer()) }); const pdf = await task.promise;
      const text = (await (await pdf.getPage(1)).getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
      expect(text).toContain("[Image unavailable: offline.png]"); await task.destroy();
      expect(s.fetchImpl).toHaveBeenCalled(); // Positive control: actual operator discovery used the spy.
      expect(s.fetchImpl.mock.calls.some(([url]) => String(url) === remote)).toBe(false);
      expect(requests).toEqual([]); // Real wire canary also covers a fetch inside the render worker.
    } finally { s.database.close(); await new Promise<void>((resolve, reject) => canary.close((error) => error ? reject(error) : resolve())); }
  });

  it("embeds owned stored PNGs but refuses cross-thread files", async () => {
    const s = await setup();
    try {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=", "base64");
      s.insert("owned-message", "user", [{ type: "text", text: "A fictional image" }]);
      await writeFile(join(s.handle.stateDir, "uploads", "fixture.bin"), png);
      s.database.prepare(`INSERT INTO attachments (id, thread_id, message_id, name, content_type, size_bytes, kind, status, uploaded, origin, storage_name, created_at, updated_at)
        VALUES ('owned-image', ?, 'owned-message', 'garden.png', 'image/png', ?, 'image', 'committed', 1, 'upload', 'fixture.bin', '2025-01-01', '2025-01-01')`).run(s.id, png.length);
      const countImages = async () => {
        const response = await s.post(); expect(response.status).toBe(200);
        const task = getDocument({ data: new Uint8Array(await response.arrayBuffer()) }); const pdf = await task.promise;
        let count = 0;
        for (let i = 1; i <= pdf.numPages; i++) count += (await (await pdf.getPage(i)).getOperatorList()).fnArray.filter(isPdfImageOperator).length;
        await task.destroy(); return count;
      };
      expect(await countImages()).toBe(1);
      const created = await fetch(`${s.base}/api/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one" }) });
      const foreign = ((await created.json()) as { thread: { id: string } }).thread.id;
      s.database.prepare("UPDATE attachments SET thread_id = ? WHERE id = 'owned-image'").run(foreign);
      expect(await countImages()).toBe(0);
    } finally { s.database.close(); }
  });

  it("bounds concurrent work and cancels the real worker without retaining the admission lock", async () => {
    const cache = new URL("../../../../node_modules/.cache/", import.meta.url); await mkdir(cache, { recursive: true });
    const root = await mkdtemp(fileURLToPath(new URL("pdf-service-", cache))); roots.push(root);
    const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()], fetchImpl: operatorFetch() });
    try {
      const thread = service.createThread("agent-one");
      const controller = new AbortController(); const pending = service.exportPdf(thread.id, controller.signal);
      await expect(service.exportPdf(thread.id)).rejects.toMatchObject({ code: "pdf_busy", status: 429 });
      controller.abort(new Error("cancelled")); await expect(pending).rejects.toThrow("cancelled");
      expect((await service.exportPdf(thread.id)).bytes.subarray(0, 5).toString()).toBe("%PDF-");
      vi.spyOn(worker, "renderPdfWorker").mockImplementation(async (_document, _images, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      vi.useFakeTimers();
      const timed = service.exportPdf(thread.id); const assertion = expect(timed).rejects.toMatchObject({ code: "pdf_timeout", status: 504 });
      await vi.advanceTimersByTimeAsync(PDF_LIMITS.timeoutMs); await assertion; vi.useRealTimers();
      const stopping = service.exportPdf(thread.id);
      const stopped = expect(stopping).rejects.toMatchObject({ code: "service_stopping" });
      await service.stop(); await stopped;
      await expect(service.exportPdf(thread.id)).rejects.toMatchObject({ status: 503 });
    } finally { vi.useRealTimers(); await service.stop(); }
  });
});
