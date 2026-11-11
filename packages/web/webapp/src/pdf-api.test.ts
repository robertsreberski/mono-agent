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
