import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("PDF binary API", () => {
  it("POSTs the captured thread and preserves RFC 5987 Unicode filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("%PDF-fixture", { headers: {
      "content-type": "application/pdf", "content-disposition": "attachment; filename=\"garden.pdf\"; filename*=UTF-8''%C5%BB%C3%B3%C5%82%C4%87.pdf",
    } })); vi.stubGlobal("fetch", fetchMock);
    const result = await api.exportPdf("thread/id");
    expect(result.filename).toBe("Żółć.pdf"); expect(result.blob.size).toBe(12);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/threads/thread%2Fid/export/pdf", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
  });
  it.each([
    { headers: new Headers({ "content-type": "text/html" }), expected: "did not return a PDF" },
    { headers: new Headers({ "content-type": "application/pdf", "content-length": "999999999" }), expected: "too large" },
  ])("cancels unread successful responses before rejecting ($expected)", async ({ headers, expected }) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(api.exportPdf("thread")).rejects.toThrow(expected);
    expect(cancel).toHaveBeenCalledOnce(); expect(response.body?.locked).toBe(false);
  });
  it("preserves the validation error when body cancellation rejects", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("Stream cancellation failed"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/html" } })));
    await expect(api.exportPdf("thread")).rejects.toThrow("did not return a PDF"); expect(cancel).toHaveBeenCalledOnce();
  });
  it("handles a missing body and releases the reader after invalid PDF data", async () => {
    const invalid = new Response("wrong", { headers: { "content-type": "application/pdf" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 204, headers: { "content-type": "application/pdf" } })).mockResolvedValueOnce(invalid));
    await expect(api.exportPdf("thread")).rejects.toThrow("unavailable");
    await expect(api.exportPdf("thread")).rejects.toThrow("invalid");
    expect(invalid.bodyUsed).toBe(true); expect(invalid.body?.locked).toBe(false);
  });
  it("decodes server failures and rejects invalid/oversize binary responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "pdf_busy", message: "Try shortly" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response("html", { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response("%PDF-", { headers: { "content-type": "application/pdf", "content-length": "999999999" } }))
      .mockResolvedValueOnce(new Response("wrong", { headers: { "content-type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.exportPdf("thread")).rejects.toMatchObject({ code: "pdf_busy", message: "Try shortly" });
    await expect(api.exportPdf("thread")).rejects.toThrow("did not return a PDF");
    await expect(api.exportPdf("thread")).rejects.toThrow("too large");
    await expect(api.exportPdf("thread")).rejects.toThrow("invalid");
  });
});
