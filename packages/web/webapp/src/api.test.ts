import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, uploadContent } from "./api";
import { attachment } from "./test/fixtures";

class FakeXMLHttpRequest {
  static latest: FakeXMLHttpRequest;
  readonly headers = new Map<string, string>();
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  responseType: XMLHttpRequestResponseType = "";
  response: unknown = null;
  status = 0;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  aborted = false;

  constructor() {
    FakeXMLHttpRequest.latest = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

describe("uploadContent", () => {
  beforeEach(() => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads opaque bytes while preserving the declared MIME on the reservation", async () => {
    const reservation = attachment("upload one", {
      name: "notes.md",
      contentType: "text/markdown",
    });
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });
    const onProgress = vi.fn();
    const result = uploadContent(reservation, file, onProgress);
    const xhr = FakeXMLHttpRequest.latest;

    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("/api/v1/uploads/upload%20one/content");
    expect(xhr.headers.get("content-type")).toBe("application/octet-stream");
    expect(xhr.headers.get("accept")).toBe("application/json");
    expect(xhr.body).toBe(file);

    const uploaded = { ...reservation, uploaded: true };
    xhr.status = 200;
    xhr.response = { attachment: uploaded };
    xhr.onload?.();

    await expect(result).resolves.toEqual(uploaded);
    expect(onProgress).toHaveBeenLastCalledWith(100);
  });

  it("aborts the XHR when its attachment context is disposed", async () => {
    const reservation = attachment("abort-me");
    const controller = new AbortController();
    const result = uploadContent(
      reservation,
      new File(["data"], "data.txt", { type: "text/plain" }),
      vi.fn(),
      controller.signal,
    );

    controller.abort();

    expect(FakeXMLHttpRequest.latest.aborted).toBe(true);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("turn overrides", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits model and effort when Provider default is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread: {}, turn: { id: "turn", status: "running" } }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.startTurn("thread", { text: "hello", model: undefined, effort: undefined });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ text: "hello" });
  });
});
