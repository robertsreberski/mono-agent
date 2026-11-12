import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pdfConversation } from "../pdf-model.js";
import { renderPdfWorker } from "../pdf-worker-client.js";

const workers = vi.hoisted(() => [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }>);
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
    constructor() { super(); workers.push(this); }
  } };
});

beforeEach(() => { workers.length = 0; });
const conversation = pdfConversation("Unlogged conversation title", "2025-04-12T10:00:00.000Z", []);
const signal = (): AbortSignal => new AbortController().signal;

describe("PDF worker diagnostics", () => {
  it("logs only the failure message/code server-side and gives a neutral client error", async () => {
    const logger = { error: vi.fn() };
    const result = renderPdfWorker(conversation, [], signal(), logger);
    const error = Object.assign(new Error("Cannot find package 'fixture-renderer'"), { code: "ERR_MODULE_NOT_FOUND" });
    workers[0]!.emit("error", error);
    workers[0]!.emit("exit", 1);
    await expect(result).rejects.toMatchObject({
      code: "pdf_render_failed", status: 500, message: "PDF export failed. Try again.",
    });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("PDF worker failed.", {
      error: error.message, code: "ERR_MODULE_NOT_FOUND",
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(conversation.title);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it.each([0, 1])("logs an unexpected exit with code %i, even without a worker error event", async (code) => {
    const logger = { error: vi.fn() };
    const result = renderPdfWorker(conversation, [], signal(), logger);
    workers[0]!.emit("exit", code);
    await expect(result).rejects.toMatchObject({ message: "PDF export failed. Try again.", status: 500 });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("PDF worker exited before producing a result.", { code });
  });

  it("does not log termination after a successful render", async () => {
    const logger = { error: vi.fn() };
    const result = renderPdfWorker(conversation, [], signal(), logger);
    workers[0]!.emit("message", { bytes: Uint8Array.from(Buffer.from("%PDF-fixture")) });
    await expect(result).resolves.toEqual(Buffer.from("%PDF-fixture"));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("still rejects and terminates when the injected logger throws", async () => {
    const logger = { error: vi.fn(() => { throw new Error("logger unavailable"); }) };
    const result = renderPdfWorker(conversation, [], signal(), logger);
    workers[0]!.emit("error", new Error("worker import failed"));
    await expect(result).rejects.toMatchObject({ code: "pdf_render_failed", message: "PDF export failed. Try again." });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("keeps real size failures as 413 without logging transcript data", async () => {
    const logger = { error: vi.fn() };
    const result = renderPdfWorker(conversation, [], signal(), logger);
    workers[0]!.emit("message", { error: "pdf_too_large" });
    await expect(result).rejects.toMatchObject({ code: "pdf_too_large", status: 413 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a renderer failure code without changing the neutral error", async () => {
    const logger = { error: vi.fn() };
    const result = renderPdfWorker(conversation, [], signal(), logger);
    workers[0]!.emit("message", { error: "pdf_render_failed" });
    await expect(result).rejects.toMatchObject({ message: "PDF export failed. Try again." });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("PDF worker failed.", { code: "pdf_render_failed" });
  });

  it("does not log deliberate termination after cancellation", async () => {
    const logger = { error: vi.fn() };
    const controller = new AbortController();
    const result = renderPdfWorker(conversation, [], controller.signal, logger);
    controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
    expect(logger.error).not.toHaveBeenCalled();
  });
});
