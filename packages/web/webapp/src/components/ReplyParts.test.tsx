import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeHarness = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  capabilities: [] as unknown[],
  resources: [] as unknown[],
  failures: {} as Record<string, Error | undefined>,
}));
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/ext-apps/app-bridge")>();
  class TestAppBridge {
    oncalltool?: (params: { name: string; arguments?: unknown }) => Promise<unknown>;
    onreadresource?: (params: unknown) => Promise<unknown>;
    onopenlink?: (params: unknown) => Promise<unknown>;
    onupdatemodelcontext?: (params: unknown) => Promise<unknown>;
    onsandboxready?: () => void;
    oninitialized?: () => void;
    onsizechange?: (params: { height?: number }) => void;
    onrequestteardown?: () => void;
    onerror?: (error: Error) => void;
    constructor(_client: unknown, _hostInfo: unknown, capabilities: unknown) {
      bridgeHarness.instances.push(this as unknown as Record<string, unknown>);
      bridgeHarness.capabilities.push(capabilities);
    }
    async connect() {
      if (bridgeHarness.failures.connect !== undefined) throw bridgeHarness.failures.connect;
    }
    async sendSandboxResourceReady(params: unknown) {
      bridgeHarness.resources.push(params);
      if (bridgeHarness.failures.sandbox !== undefined) throw bridgeHarness.failures.sandbox;
    }
    async sendToolInput() {
      if (bridgeHarness.failures.initialize !== undefined) throw bridgeHarness.failures.initialize;
    }
    async sendToolResult() {}
    setHostContext() {}
    async teardownResource() {}
  }
  class TestPostMessageTransport {
    async close() {}
  }
  return { ...actual, AppBridge: TestAppBridge, PostMessageTransport: TestPostMessageTransport };
});

import { ApiError, api, type ReplyAccessRefreshHandler } from "../api";
import { writeDataModeSetting } from "../data-mode";
import { dataUsage, resetDataUsage } from "../data-usage";
import { ReplyAccessProvider } from "./reply-access";
import type { McpAppPart as McpAppPartValue } from "../types";
import { REPLY_IMAGE_REQUEST_TIMEOUT_MS, clearReplyImageBlobs } from "./reply-image-cache";
import {
  McpAppPart,
  ReplyAttachmentPart,
  ReplyFailurePart,
  mcpAppContentSecurityPolicy,
  mcpAppArgumentPreview,
  mcpAppPreferredHeight,
  openExternalMcpAppLink,
  REPLY_IMAGE_RETRY_LIMIT,
  safeMcpAppResourceMetadata,
  secureMcpAppHtml,
  startReplyAttachmentDownload,
} from "./ReplyParts";

type AttachmentProps = Parameters<typeof ReplyAttachmentPart>[0];
type FailureProps = Parameters<typeof ReplyFailurePart>[0];
type AppProps = Parameters<typeof McpAppPart>[0];

const attachment = (data: unknown) =>
  <ReplyAttachmentPart {...({ data } as unknown as AttachmentProps)} />;
const failure = (data: unknown) =>
  <ReplyFailurePart {...({ data } as unknown as FailureProps)} />;
const app = (data: unknown) => <McpAppPart {...({ data } as unknown as AppProps)} />;

const appPart: McpAppPartValue = {
  type: "mcp_app",
  id: "app-1",
  invocationId: "11111111-1111-4111-8111-111111111111",
  connectionId: "connection-1",
  serverName: "reports",
  toolName: "render_report",
  resourceUri: "ui://reports/result",
  mediaType: "text/html;profile=mcp-app",
  protocolVersion: "2026-01-26",
  title: "Quarterly report",
  resourceUrl: "/api/v1/threads/t/messages/m/mcp-apps/app-1?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  bridgeUrl: "/api/v1/threads/t/messages/m/mcp-apps/app-1/requests?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const attachmentPart = {
  type: "attachment" as const,
  id: "file-1",
  artifactId: "artifact-1",
  name: "report.txt",
  mediaType: "text/plain",
  sizeBytes: 6,
  integrityId: "sha256:abc",
  contentUrl: "/api/v1/threads/t/messages/m/reply-attachments/file-1/content?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const imagePart = {
  type: "attachment" as const,
  id: "cover-part",
  artifactId: "artifact-cover",
  name: "cover.png",
  mediaType: "image/png",
  sizeBytes: 4,
  integrityId: "sha256:cover",
  contentUrl: "/api/v1/threads/t/messages/m/reply-attachments/cover-part/content?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

/** The same picture, re-projected with a freshly minted capability. */
const rotatedImagePart = {
  ...imagePart,
  contentUrl: imagePart.contentUrl
    .replace("1234567890", "2234567890")
    .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
};

const imageResponse = () => new Response("abcd", {
  headers: {
    "content-length": String(imagePart.sizeBytes),
    "content-type": "image/png",
    "x-mono-agent-integrity-id": imagePart.integrityId,
  },
});

const stubImageObjectUrls = () => {
  const createObjectUrl = vi.fn(() => "blob:cover-image");
  const revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
  return { createObjectUrl, revokeObjectUrl };
};

const attachmentResponse = (value = attachmentPart, content = "report") => new Response(content, {
  headers: {
    "content-length": String(value.sizeBytes),
    "content-type": "application/octet-stream",
    "x-mono-agent-integrity-id": value.integrityId,
  },
});

interface TestAppBridgeInstance {
  readonly oncalltool?: (params: { name: string; arguments?: unknown }) => Promise<unknown>;
  readonly onreadresource?: (params: unknown) => Promise<unknown>;
  readonly onopenlink?: (params: unknown) => Promise<unknown>;
  readonly onupdatemodelcontext?: (params: unknown) => Promise<unknown>;
  readonly onsandboxready?: () => void;
  readonly onrequestteardown?: () => void;
  readonly onsizechange?: (params: { height?: number }) => void;
  readonly oninitialized?: () => void;
  readonly onerror?: (error: Error) => void;
  readonly teardownResource: () => Promise<void>;
}

interface TestProxyConfiguration {
  readonly type: "mono-agent:mcp-app-proxy-config";
  readonly nonce: string;
  readonly invocationId: string;
  readonly connectionId: string;
  readonly clipboardWrite: boolean;
}

const configureRenderedApp = async (frame: HTMLIFrameElement): Promise<TestProxyConfiguration> => {
  if (frame.contentWindow === null) throw new Error("Expected an iframe window.");
  const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "mono-agent:mcp-app-proxy-config" }),
    "*",
  ));
  const call = postMessage.mock.calls.find(([value]) =>
    typeof value === "object" && value !== null
      && (value as { type?: unknown }).type === "mono-agent:mcp-app-proxy-config");
  if (call === undefined) throw new Error("Expected a proxy configuration message.");
  return call[0] as TestProxyConfiguration;
};

const connectRenderedApp = async (
  frame: HTMLIFrameElement,
  part: McpAppPartValue,
): Promise<TestAppBridgeInstance> => {
  const config = await configureRenderedApp(frame);
  return await connectConfiguredApp(frame, part, config);
};

const connectConfiguredApp = async (
  frame: HTMLIFrameElement,
  part: McpAppPartValue,
  config: TestProxyConfiguration,
): Promise<TestAppBridgeInstance> => {
  await waitFor(() => {
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        type: "mono-agent:mcp-app-proxy-ready",
        nonce: config.nonce,
        invocationId: part.invocationId,
        connectionId: part.connectionId,
      },
    }));
    expect(bridgeHarness.instances[0]).toBeDefined();
  });
  return bridgeHarness.instances[0] as unknown as TestAppBridgeInstance;
};

/**
 * jsdom has no `IntersectionObserver`, so the console loads eagerly there and
 * every case that predates viewport gating keeps its behaviour. A case that
 * wants the gate installs this one and decides when something is on screen.
 */
const stubIntersectionObserver = () => {
  const live = new Set<StubIntersectionObserver>();
  let disconnects = 0;
  class StubIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [];
    readonly targets: Element[] = [];
    readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      live.add(this);
    }
    observe(target: Element): void {
      this.targets.push(target);
    }
    unobserve(): void {}
    // A disconnected observer delivers nothing ever again, so the stub has to
    // leave the set: an assertion about "one request" is worthless if the stub
    // keeps calling a callback the component has already let go of.
    disconnect(): void {
      disconnects += 1;
      this.targets.length = 0;
      live.delete(this);
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  const report = async (isIntersecting: boolean) => {
    await act(async () => {
      for (const observer of [...live]) {
        observer.callback(
          observer.targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
          observer as unknown as IntersectionObserver,
        );
      }
      await Promise.resolve();
    });
  };
  return {
    observing: () => live.size,
    disconnects: () => disconnects,
    report,
    intersect: async () => report(true),
  };
};

afterEach(() => {
  bridgeHarness.instances.length = 0;
  bridgeHarness.capabilities.length = 0;
  bridgeHarness.resources.length = 0;
  for (const key of Object.keys(bridgeHarness.failures)) delete bridgeHarness.failures[key];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Shared image blobs outlive the components that fetched them, so one case's
  // picture must not silently satisfy the next case's fetch.
  clearReplyImageBlobs();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
});

describe("assistant reply files", () => {
  it("revokes the object URL after the attachment download timer settles", async () => {
    vi.useFakeTimers();
    const createObjectUrl = vi.fn(() => "blob:reply-file");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const blob = new Blob(["report"]);

    startReplyAttachmentDownload(blob, "report.txt");

    expect(createObjectUrl).toHaveBeenCalledExactlyOnceWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.instances[0]).toMatchObject({
      download: "report.txt",
      href: "blob:reply-file",
    });
    expect(document.querySelector('a[href="blob:reply-file"]')).toBeNull();
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith("blob:reply-file");
  });

  it("shows a generated image as a bare picture, without a card or a capability", () => {
    const value = {
      type: "attachment",
      id: "cover-part",
      artifactId: "artifact-cover",
      name: "cover.png",
      mediaType: "image/png",
      sizeBytes: 2_048,
      integrityId: "sha256:abc",
      storedUrl: "/api/v1/uploads/reply%3Amsg%3Acover-part/content",
      contentUrl: "/api/v1/threads/t/messages/m/reply-attachments/cover-part/content?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as const;
    const fetchContent = vi.spyOn(api, "replyAttachmentContent");
    render(attachment(value));

    const image = screen.getByRole("img", { name: "cover.png" });
    expect(image).toHaveAttribute("src", value.storedUrl);
    // The durable copy is the whole point: no token is spent, so the image keeps
    // rendering once the capability window and the retention deadline are gone.
    expect(fetchContent).not.toHaveBeenCalled();

    // The picture is the content. None of the file record survives around it —
    // no name, no media type, no size, no download button, and no live region to
    // announce a download that is no longer offered here.
    expect(screen.queryByRole("region", { name: "File attachment: cover.png" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download cover.png" })).toBeNull();
    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(screen.queryByText(/image\/png/u)).toBeNull();
    // The lightbox is where the full image and its download live.
    expect(screen.getByRole("button", { name: "View cover.png" })).toBeVisible();
  });

  it("never inlines an SVG reply, which is active content rather than a raster image", () => {
    const value = {
      type: "attachment",
      id: "cover-part",
      artifactId: "artifact-cover",
      name: "diagram.svg",
      mediaType: "image/svg+xml",
      sizeBytes: 2_048,
      integrityId: "sha256:abc",
      storedUrl: "/api/v1/uploads/reply%3Amsg%3Acover-part/content",
      contentUrl: "/api/v1/threads/t/messages/m/reply-attachments/cover-part/content?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as const;
    render(attachment(value));

    expect(screen.getByRole("region", { name: "File attachment: diagram.svg" })).toBeVisible();
    expect(document.querySelector("img, object, embed, iframe")).toBeNull();
  });

  it("refuses an off-origin durable copy and falls back to the capability path", async () => {
    const value = {
      type: "attachment",
      id: "cover-part",
      artifactId: "artifact-cover",
      name: "cover.png",
      mediaType: "image/png",
      sizeBytes: 4,
      integrityId: "sha256:abc",
      storedUrl: "https://attacker.example/cover.png",
      contentUrl: "/api/v1/threads/t/messages/m/reply-attachments/cover-part/content?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as const;
    vi.spyOn(api, "replyAttachmentContent").mockResolvedValue(new Response("abcd", {
      headers: { "content-length": "4", "content-type": "image/png", "x-mono-agent-integrity-id": "sha256:abc" },
    }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:reply-image") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const view = render(attachment(value));

    // Nothing outside our own upload route may ever become an image source.
    await waitFor(() => expect(screen.getByRole("img", { name: "cover.png" })).toHaveAttribute("src", "blob:reply-image"));
    expect(document.querySelector('img[src^="https://attacker.example"]')).toBeNull();
    // Unmount here, while the object-URL stub is still installed: the shared
    // teardown restores jsdom's own (absent) implementation.
    view.unmount();
  });

  it("does not inline an image whose bytes contradict the declared integrity", async () => {
    const value = {
      type: "attachment",
      id: "cover-part",
      artifactId: "artifact-cover",
      name: "cover.png",
      mediaType: "image/png",
      sizeBytes: 4,
      integrityId: "sha256:abc",
      contentUrl: "/api/v1/threads/t/messages/m/reply-attachments/cover-part/content?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as const;
    vi.spyOn(api, "replyAttachmentContent").mockResolvedValue(new Response("abcd", {
      headers: { "content-length": "4", "x-mono-agent-integrity-id": "sha256:wrong" },
    }));
    const createObjectUrl = vi.fn(() => "blob:reply-image");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    render(attachment(value));

    await waitFor(() => expect(api.replyAttachmentContent).toHaveBeenCalled());
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(document.querySelector("img")).toBeNull();
  });

  it("keeps one download of a picture across every re-mint of its capability", async () => {
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());
    const { createObjectUrl } = stubImageObjectUrls();
    const view = render(attachment(imagePart));

    const image = await screen.findByRole("img", { name: "cover.png" });
    expect(image).toHaveAttribute("src", "blob:cover-image");
    expect(fetchContent).toHaveBeenCalledTimes(1);

    // The service re-mints `contentUrl` on every projection of the message. A
    // picture keyed on that URL is re-downloaded once a second on a live turn.
    view.rerender(attachment(rotatedImagePart));
    await act(async () => { await Promise.resolve(); });

    expect(fetchContent).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "cover.png" })).toBe(image);
    expect(image).toHaveAttribute("src", "blob:cover-image");
    view.unmount();
  });

  it("re-shows a picture from the bytes it already holds after a conversation switch", async () => {
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());
    const { createObjectUrl, revokeObjectUrl } = stubImageObjectUrls();
    const first = render(attachment(imagePart));
    await screen.findByRole("img", { name: "cover.png" });

    // Leaving the conversation and coming back remounts the same part.
    first.unmount();
    const second = render(attachment(imagePart));

    expect(await screen.findByRole("img", { name: "cover.png" })).toHaveAttribute("src", "blob:cover-image");
    expect(fetchContent).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    second.unmount();
  });

  it("spends nothing on a picture that has not reached the viewport", async () => {
    const viewport = stubIntersectionObserver();
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());
    stubImageObjectUrls();
    const offscreen = render(attachment(imagePart));

    expect(fetchContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "cover.png" })).toBeNull();
    // The placeholder keeps the picture's place and stays reachable, so a
    // reader that moves to it brings it into view and loads it — and says it is
    // busy rather than presenting itself as the picture.
    const placeholder = screen.getByRole("img", { name: "Loading cover.png" });
    expect(placeholder).toBeVisible();
    expect(placeholder).toHaveAttribute("aria-busy", "true");
    // Nothing of the file record is shown for a picture that is still coming.
    expect(screen.queryByRole("button", { name: "Download cover.png" })).toBeNull();
    expect(viewport.observing()).toBe(1);

    // A message scrolled past and then evicted takes its observer with it.
    offscreen.unmount();
    expect(viewport.disconnects()).toBe(1);
    expect(viewport.observing()).toBe(0);
    expect(fetchContent).not.toHaveBeenCalled();

    render(attachment(imagePart));
    await viewport.intersect();

    expect(await screen.findByRole("img", { name: "cover.png" })).toHaveAttribute("src", "blob:cover-image");
    expect(fetchContent).toHaveBeenCalledTimes(1);
    // Arriving in view is the end of the gate's job: it lets its observer go.
    expect(viewport.observing()).toBe(0);
  });

  it("tries a picture again on the next capability, but only after a transient failure", async () => {
    const fetchContent = vi.spyOn(api, "replyAttachmentContent")
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockImplementation(async () => imageResponse());
    stubImageObjectUrls();
    const view = render(attachment(imagePart));

    // A dropped connection is not the picture's verdict, but until something
    // changes there is nothing to retry with, so the card takes over.
    expect(await screen.findByRole("button", { name: "Download cover.png" })).toBeVisible();
    expect(fetchContent).toHaveBeenCalledTimes(1);

    view.rerender(attachment(rotatedImagePart));

    expect(await screen.findByRole("img", { name: "cover.png" })).toHaveAttribute("src", "blob:cover-image");
    expect(fetchContent).toHaveBeenCalledTimes(2);

    // And a settled picture is not re-fetched by any later re-mint.
    view.rerender(attachment(imagePart));
    await act(async () => { await Promise.resolve(); });
    expect(fetchContent).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("stops re-asking for a picture that keeps failing, however often the token turns", async () => {
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockRejectedValue(new Error("connection lost"));
    stubImageObjectUrls();
    const view = render(attachment(imagePart));
    expect(await screen.findByRole("button", { name: "Download cover.png" })).toBeVisible();
    expect(fetchContent).toHaveBeenCalledTimes(1);

    // A live turn re-mints the capability about once a second, which is not a
    // reason to re-download a picture that has failed every time so far.
    for (let mint = 1; mint <= 5; mint += 1) {
      view.rerender(attachment({
        ...imagePart,
        contentUrl: imagePart.contentUrl
          .replace("1234567890", `${String(1234567890 + mint)}`)
          .replace(/token=[^&]+/u, `token=${String(mint).repeat(43)}`),
      }));
      await act(async () => { await Promise.resolve(); });
    }

    expect(fetchContent).toHaveBeenCalledTimes(1 + REPLY_IMAGE_RETRY_LIMIT);
    expect(screen.getByRole("button", { name: "Download cover.png" })).toBeVisible();
    view.unmount();
  });

  it("never re-asks for bytes that already contradicted their declaration", async () => {
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockResolvedValue(new Response("abcd", {
      headers: { "content-length": "4", "x-mono-agent-integrity-id": "sha256:wrong" },
    }));
    stubImageObjectUrls();
    const view = render(attachment(imagePart));

    expect(await screen.findByRole("button", { name: "Download cover.png" })).toBeVisible();
    expect(fetchContent).toHaveBeenCalledTimes(1);

    // The bytes are the verdict here, and a fresh token cannot change them.
    view.rerender(attachment(rotatedImagePart));
    await act(async () => { await Promise.resolve(); });

    expect(fetchContent).toHaveBeenCalledTimes(1);
  });

  it("asks once under StrictMode's discarded first mount", async () => {
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());
    stubImageObjectUrls();
    const view = render(<StrictMode>{attachment(imagePart)}</StrictMode>);

    expect(await screen.findByRole("img", { name: "cover.png" })).toHaveAttribute("src", "blob:cover-image");
    expect(fetchContent).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("gives up on a picture whose request never answers and offers the file instead", async () => {
    vi.useFakeTimers();
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(
      (_url, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      }),
    );
    stubImageObjectUrls();
    render(attachment(imagePart));

    await act(async () => { await vi.advanceTimersByTimeAsync(REPLY_IMAGE_REQUEST_TIMEOUT_MS - 1); });
    expect(screen.queryByRole("button", { name: "Download cover.png" })).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    // A picture that never arrives must not leave the operator with a shimmer
    // and no way to get the file.
    expect(screen.getByRole("button", { name: "Download cover.png" })).toBeVisible();
    expect(fetchContent).toHaveBeenCalledTimes(1);
  });

  it("asks once for a picture two parts of one conversation both carry", async () => {
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());
    stubImageObjectUrls();
    const twin = { ...imagePart, id: "twin-part", artifactId: "artifact-twin" };
    render(<>{attachment(imagePart)}{attachment(twin)}</>);

    const shown = await screen.findAllByRole("img", { name: "cover.png" });
    expect(shown).toHaveLength(2);
    for (const image of shown) expect(image).toHaveAttribute("src", "blob:cover-image");
    expect(fetchContent).toHaveBeenCalledTimes(1);
  });

  it("still offers the file card for a picture whose bytes never arrive", async () => {
    vi.spyOn(api, "replyAttachmentContent").mockRejectedValue(new Error("connection lost"));
    stubImageObjectUrls();
    render(attachment(imagePart));

    expect(await screen.findByRole("button", { name: "Download cover.png" })).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders an accessible download-only reference without inlining active content", () => {
    const value = {
      type: "attachment",
      id: "file-1",
      artifactId: "artifact-1",
      name: "report.html",
      mediaType: "text/html",
      sizeBytes: 2_048,
      integrityId: "sha256:abc",
      contentUrl: "/api/v1/threads/t/messages/m/reply-attachments/file-1/content?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as const;
    vi.spyOn(api, "replyAttachmentContent").mockResolvedValue(new Response("x".repeat(value.sizeBytes), {
      headers: {
        "content-length": String(value.sizeBytes),
        "content-type": "application/octet-stream",
        "x-mono-agent-integrity-id": value.integrityId,
      },
    }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:reply-file") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { container } = render(attachment(value));

    expect(screen.getByRole("region", { name: "File attachment: report.html" })).toBeVisible();
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const button = screen.getByRole("button", { name: "Download report.html" });
    fireEvent.click(button);
    expect(screen.getByText("text/html · 2 KiB")).toBeVisible();
    expect(container.querySelector("img, object, embed, iframe")).toBeNull();
    return waitFor(() => {
      expect(click).toHaveBeenCalledTimes(1);
      expect(click.mock.instances[0]).toMatchObject({
        download: "report.html",
        href: "blob:reply-file",
      });
      expect(screen.getByRole("status")).toBe(status);
      expect(status).toHaveTextContent("Download started with refreshed access");
      expect(screen.getAllByRole("status")).toHaveLength(1);
    });
  });

  it("validates decoded attachment bytes when Content-Length is unavailable", async () => {
    vi.spyOn(api, "replyAttachmentContent").mockResolvedValue(new Response("report", {
      headers: { "x-mono-agent-integrity-id": attachmentPart.integrityId },
    }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:reply-file") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(attachment(attachmentPart));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("Download started");
  });

  it("keeps a headerless short read retryable and completes a later retry", async () => {
    const download = vi.spyOn(api, "replyAttachmentContent")
      .mockResolvedValueOnce(new Response("rep", {
        headers: { "x-mono-agent-integrity-id": attachmentPart.integrityId },
      }))
      .mockResolvedValueOnce(attachmentResponse());
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:reply-file") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(attachment(attachmentPart));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    const retry = await screen.findByRole("button", { name: "Try again report.txt" });
    expect(screen.getByRole("status")).toHaveTextContent("Check your connection and try again");
    expect(click).not.toHaveBeenCalled();
    fireEvent.click(retry);

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(download).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Download started");
  });

  it.each([
    {
      name: "declared length mismatch",
      response: new Response("report", {
        headers: {
          "content-length": "7",
          "x-mono-agent-integrity-id": attachmentPart.integrityId,
        },
      }),
    },
    {
      name: "integrity mismatch",
      response: new Response("report", {
        headers: {
          "content-length": String(attachmentPart.sizeBytes),
          "x-mono-agent-integrity-id": "sha256:changed",
        },
      }),
    },
    {
      name: "headerless oversized body",
      response: new Response("reports", {
        headers: { "x-mono-agent-integrity-id": attachmentPart.integrityId },
      }),
    },
  ])("fails closed on $name", async ({ response }) => {
    vi.spyOn(api, "replyAttachmentContent").mockResolvedValue(response);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(attachment(attachmentPart));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("failed integrity validation"));
    expect(screen.queryByRole("button", { name: /Download|Try again|Refresh access/u })).not.toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  });

  it("fails closed when a stored private endpoint points off origin", () => {
    render(attachment({
      type: "attachment",
      id: "file-1",
      artifactId: "artifact-1",
      name: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 10,
      integrityId: "sha256:abc",
      contentUrl: "https://attacker.example/file",
    }));

    expect(screen.getByRole("status")).toHaveTextContent("no longer available");
    expect(screen.queryByRole("button", { name: /Download/u })).not.toBeInTheDocument();
  });

  it("announces expired download access and exposes a clear refresh action", async () => {
    vi.spyOn(api, "replyAttachmentContent").mockRejectedValue(
      new ApiError("Reply access expired.", 410, "reply_access_expired"),
    );
    render(attachment({
      type: "attachment",
      id: "file-1",
      artifactId: "artifact-1",
      name: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 10,
      integrityId: "sha256:abc",
      contentUrl: "/api/v1/threads/t/messages/m/reply-attachments/file-1/content?expires=1234567890&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));

    fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Download access expired");
      expect(screen.getByRole("button", { name: "Refresh access report.pdf" })).toBeVisible();
    });
  });

  it("keeps one pre-mounted live region when retention makes a file unavailable", () => {
    const view = render(attachment(attachmentPart));
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    view.rerender(attachment({ ...attachmentPart, contentUrl: undefined }));

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("This file is no longer available.");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Download/u })).not.toBeInTheDocument();
  });

  it("aborts a held fetch on unmount and prevents duplicate or late downloads across remount", async () => {
    const held: Array<{
      readonly signal: AbortSignal | undefined;
      readonly resolve: (response: Response) => void;
    }> = [];
    const download = vi.spyOn(api, "replyAttachmentContent").mockImplementation(
      (_url, signal) => new Promise((resolve) => held.push({ signal, resolve })),
    );
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:reply-file") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const first = render(attachment(attachmentPart));

    const firstButton = screen.getByRole("button", { name: "Download report.txt" });
    fireEvent.click(firstButton);
    fireEvent.click(firstButton);
    expect(download).toHaveBeenCalledTimes(1);
    expect(held[0]?.signal?.aborted).toBe(false);

    first.unmount();
    expect(held[0]?.signal?.aborted).toBe(true);

    render(attachment(attachmentPart));
    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    expect(download).toHaveBeenCalledTimes(2);
    expect(held[1]?.signal?.aborted).toBe(false);

    await act(async () => {
      held[0]?.resolve(attachmentResponse());
      await Promise.resolve();
    });
    expect(click).not.toHaveBeenCalled();

    await act(async () => {
      held[1]?.resolve(attachmentResponse());
      await Promise.resolve();
    });
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  });

  it("aborts a held fetch on part replacement and rejects its late capability adoption", async () => {
    const held: Array<{
      readonly signal: AbortSignal | undefined;
      readonly adopt: ReplyAccessRefreshHandler<"attachment"> | undefined;
      readonly resolve: (response: Response) => void;
    }> = [];
    const download = vi.spyOn(api, "replyAttachmentContent").mockImplementation(
      (_url, signal, onAccessRefreshed) => new Promise((resolve) => {
        held.push({ signal, adopt: onAccessRefreshed, resolve });
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const replacement = {
      ...attachmentPart,
      id: "file-2",
      artifactId: "artifact-2",
      name: "replacement.txt",
      contentUrl: attachmentPart.contentUrl.replaceAll("file-1", "file-2"),
    };
    const view = render(attachment(attachmentPart));
    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    view.rerender(attachment(replacement));
    expect(held[0]?.signal?.aborted).toBe(true);
    await act(async () => {
      held[0]?.adopt?.({
        ...attachmentPart,
        contentUrl: attachmentPart.contentUrl.replace("1234567890", "2234567890"),
      });
      held[0]?.resolve(attachmentResponse());
      await Promise.resolve();
    });
    expect(click).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Download replacement.txt" }));
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls[1]?.[0]).toBe(replacement.contentUrl);
    view.unmount();
    expect(held[1]?.signal?.aborted).toBe(true);
  });

  it("keeps an in-flight download and status across token rotation while preferring the new declaration", async () => {
    const rotated = {
      ...attachmentPart,
      contentUrl: attachmentPart.contentUrl
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
    };
    const lateOlderAdoption = {
      ...attachmentPart,
      contentUrl: attachmentPart.contentUrl
        .replace("1234567890", "1734567890")
        .replace(/token=[^&]+/u, `token=${"c".repeat(43)}`),
    };
    let held: {
      readonly signal: AbortSignal | undefined;
      readonly adopt: ReplyAccessRefreshHandler<"attachment"> | undefined;
      readonly resolve: (response: Response) => void;
    } | undefined;
    const requestedUrls: string[] = [];
    vi.spyOn(api, "replyAttachmentContent")
      .mockImplementationOnce((url, signal, onAccessRefreshed) => {
        requestedUrls.push(url);
        return new Promise((resolve) => {
          held = { signal, adopt: onAccessRefreshed, resolve };
        });
      })
      .mockImplementationOnce(async (url) => {
        requestedUrls.push(url);
        return attachmentResponse();
      });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:reply-file") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const view = render(attachment(attachmentPart));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    await waitFor(() => expect(held).toBeDefined());
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Refreshing download access");

    view.rerender(attachment(rotated));
    expect(held?.signal?.aborted).toBe(false);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Refreshing download access");
    await act(async () => {
      held?.adopt?.(lateOlderAdoption);
      held?.resolve(attachmentResponse());
      await Promise.resolve();
    });
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    expect(requestedUrls).toEqual([attachmentPart.contentUrl, rotated.contentUrl]);
  });

  it("adopts refreshed attachment access for the next download without another stale attempt", async () => {
    const fresh = {
      ...attachmentPart,
      contentUrl: attachmentPart.contentUrl
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
    };
    const requestedUrls: string[] = [];
    const download = vi.spyOn(api, "replyAttachmentContent").mockImplementation(
      async (url, _signal, onAccessRefreshed) => {
        requestedUrls.push(url);
        if (requestedUrls.length === 1) onAccessRefreshed?.(fresh);
        return attachmentResponse();
      },
    );
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:reply-file") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(attachment(attachmentPart));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Download started"));
    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));

    expect(requestedUrls).toEqual([attachmentPart.contentUrl, fresh.contentUrl]);
  });

  it.each([
    {
      name: "expired retention",
      error: new ApiError("Expired at /private/agent/report.txt?token=must-not-leak", 410, "reply_part_expired"),
      message: "The reply part has expired. (reply_part_expired)",
      privateDetail: "/private/agent",
    },
    {
      name: "offline or incompatible source",
      error: new ApiError("The attachment source is offline or incompatible.", 409, "reply_attachment_unavailable"),
      message: "The attachment source is offline or incompatible. (reply_attachment_unavailable)",
      privateDetail: undefined,
    },
  ])("presents $name as a terminal server state without a retry action", async ({ error, message, privateDetail }) => {
    vi.spyOn(api, "replyAttachmentContent").mockRejectedValue(error);
    render(attachment(attachmentPart));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Try again|Download|Refresh access/u })).not.toBeInTheDocument();
    if (privateDetail !== undefined) expect(document.body).not.toHaveTextContent(privateDetail);
  });

  it("keeps transient failures retryable without exposing internal error details", async () => {
    vi.spyOn(api, "replyAttachmentContent").mockRejectedValue(
      new Error("read /private/agent/report.txt?token=should-not-leak failed"),
    );
    render(attachment(attachmentPart));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Check your connection and try again"));
    expect(screen.getByRole("button", { name: "Try again report.txt" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("/private/agent");
    expect(document.body).not.toHaveTextContent("should-not-leak");
  });

  it("keeps an unclassified 4xx response retryable without exposing its details", async () => {
    vi.spyOn(api, "replyAttachmentContent").mockRejectedValue(
      new ApiError("Rejected for /private/agent/report.txt?token=must-not-leak", 403, "origin_rejected"),
    );
    render(attachment(attachmentPart));

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Try again report.txt" })).toBeVisible());
    expect(screen.getByRole("status")).toHaveTextContent("Check your connection and try again");
    expect(document.body).not.toHaveTextContent("/private/agent");
    expect(document.body).not.toHaveTextContent("must-not-leak");
  });

  it("announces per-part publication failures without hiding successful siblings", () => {
    render(failure({ type: "failure", id: "bad-file", code: "artifact_missing", message: "File expired." }));
    expect(screen.getByRole("alert")).toHaveTextContent("artifact_missing");
    expect(screen.getByRole("alert")).toHaveTextContent("File expired.");
  });
});

describe("MCP App sandbox", () => {
  it("intersects declared CSP and permissions with the host's safe subset", () => {
    const metadata = safeMcpAppResourceMetadata({
      ui: {
        csp: {
          connectDomains: ["https://api.example.com", "https://evil.com", "javascript:alert(1)", "https://example.com/path"],
          resourceDomains: ["https://cdn.example.com", "https://evil.com"],
          frameDomains: ["http://not-local.example"],
          baseUriDomains: ["https://assets.example.com", "https://evil.com"],
        },
        permissions: { camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} },
      },
    }, {
      connectOrigins: ["https://api.example.com"],
      resourceOrigins: ["https://cdn.example.com"],
      baseUriOrigins: ["https://assets.example.com"],
    });

    expect(metadata).toEqual({
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
        baseUriDomains: ["https://assets.example.com"],
      },
      permissions: { clipboardWrite: {} },
    });
    const csp = mcpAppContentSecurityPolicy(metadata);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("javascript:");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("evil.com");
    expect(csp).toContain("script-src 'unsafe-inline';");
    expect(csp).not.toContain("script-src 'unsafe-inline' https://cdn.example.com");
  });

  it("defaults remote server declarations to no network, image, or script grants", () => {
    const metadata = safeMcpAppResourceMetadata({
      ui: {
        csp: {
          connectDomains: ["https://evil.com"],
          resourceDomains: ["https://evil.com"],
          frameDomains: ["https://evil.com"],
        },
      },
    });
    const csp = mcpAppContentSecurityPolicy(metadata);
    expect(csp).not.toContain("evil.com");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("img-src data: blob:");
  });

  it("puts the enforced CSP before untrusted markup", () => {
    const html = "<script>top.location='https://attacker.example'</script>";
    const secured = secureMcpAppHtml(html, safeMcpAppResourceMetadata(undefined));
    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(secured.indexOf("top.location"));
    expect(secured).toContain("frame-src 'none'");
    expect(secured).toContain("base-uri 'none'");
    expect(secured).toContain("navigate-to 'none'");
  });

  it.each([
    {
      name: "empty metadata",
      metadata: safeMcpAppResourceMetadata(undefined),
    },
    {
      name: "capability-bearing metadata",
      metadata: safeMcpAppResourceMetadata({
        ui: {
          csp: {
            connectDomains: ["https://api.example.com"],
            resourceDomains: ["https://cdn.example.com"],
            frameDomains: ["https://frame.example.com"],
            baseUriDomains: ["https://base.example.com"],
          },
          permissions: { clipboardWrite: {} },
        },
      }, {
        connectOrigins: ["https://api.example.com"],
        resourceOrigins: ["https://cdn.example.com"],
        frameOrigins: ["https://frame.example.com"],
        baseUriOrigins: ["https://base.example.com"],
      }),
    },
  ])("bounds the final secured document exactly for $name", ({ metadata }) => {
    const limit = 2 * 1024 * 1024;
    const prefixBytes = new TextEncoder().encode(secureMcpAppHtml("", metadata)).byteLength;
    const bodyBytesAtLimit = limit - prefixBytes;
    expect(bodyBytesAtLimit).toBeGreaterThan(0);

    const atLimit = secureMcpAppHtml("x".repeat(bodyBytesAtLimit), metadata);
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(limit);
    expect(() => secureMcpAppHtml("x".repeat(bodyBytesAtLimit + 1), metadata))
      .toThrow("The MCP App resource is too large.");
  });

  it("sends escaping-heavy shared-producer output at the exact cap to the sandbox bridge", async () => {
    const metadata = safeMcpAppResourceMetadata(undefined);
    const limit = 2 * 1024 * 1024;
    const prefixBytes = new TextEncoder().encode(secureMcpAppHtml("", metadata)).byteLength;
    const bodyBytes = limit - prefixBytes;
    const escapingPattern = ['"', "\\", "\n", "\t"].join("");
    const html = escapingPattern.repeat(Math.floor(bodyBytes / escapingPattern.length))
      + "x".repeat(bodyBytes % escapingPattern.length);
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html,
      connected: true,
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);
    await act(async () => {
      bridge.onsandboxready?.();
      await Promise.resolve();
    });

    expect(bridgeHarness.resources).toHaveLength(1);
    const params = bridgeHarness.resources[0] as { readonly html: string; readonly sandbox: string };
    expect(params.sandbox).toBe("allow-scripts");
    expect(new TextEncoder().encode(params.html).byteLength).toBe(limit);
    expect(new TextEncoder().encode(JSON.stringify({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params,
    })).byteLength).toBeGreaterThan(limit + 64 * 1024);
  });

  it("reports an oversized final document before constructing a bridge transport", async () => {
    const metadata = safeMcpAppResourceMetadata(undefined);
    const limit = 2 * 1024 * 1024;
    const prefixBytes = new TextEncoder().encode(secureMcpAppHtml("", metadata)).byteLength;
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "x".repeat(limit - prefixBytes + 1),
      connected: true,
    });

    render(app(appPart));

    await waitFor(() => expect(screen.getByRole("status"))
      .toHaveTextContent("The MCP App resource is too large."));
    expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();
    expect(bridgeHarness.instances).toHaveLength(0);
  });

  it("loads a fixed same-origin proxy and sends its per-instance binding only after load", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>interactive</p>",
      connected: true,
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    expect(frame).toHaveAttribute("src", "/api/v1/mcp-app-proxy");
    expect(frame).not.toHaveAttribute("srcdoc");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame).not.toHaveAttribute("allow");
    const config = await configureRenderedApp(frame);

    expect(config).toEqual({
      type: "mono-agent:mcp-app-proxy-config",
      nonce: expect.any(String),
      invocationId: appPart.invocationId,
      connectionId: appPart.connectionId,
      clipboardWrite: false,
    });
    expect(config).not.toHaveProperty("hostOrigin");
    expect(config).not.toHaveProperty("resourceUrl");
    expect(config).not.toHaveProperty("bridgeUrl");
    await connectConfiguredApp(frame, appPart, config);
    const capabilities = bridgeHarness.capabilities[0] as {
      readonly sandbox?: { readonly permissions?: { readonly clipboardWrite?: {} } };
    };
    expect(capabilities.sandbox?.permissions).toBeUndefined();
  });

  it("delegates only clipboard-write through the trusted outer frame when granted", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>interactive</p>",
      resourceMetadata: { ui: { permissions: { clipboardWrite: {} } } },
      connected: true,
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame).toHaveAttribute("allow", "clipboard-write");
    const config = await configureRenderedApp(frame);
    expect(config).toMatchObject({ clipboardWrite: true });
    await connectConfiguredApp(frame, appPart, config);
    const capabilities = bridgeHarness.capabilities[0] as {
      readonly sandbox?: { readonly permissions?: { readonly clipboardWrite?: {} } };
    };
    expect(capabilities.sandbox?.permissions).toEqual({ clipboardWrite: {} });
  });

  it("sends matching configuration to re-arm an already-loaded proxy", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>interactive</p>",
      connected: true,
    });
    const proxyWindow = { postMessage: vi.fn() };
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get")
      .mockReturnValue(proxyWindow as unknown as Window);

    render(app(appPart));
    await screen.findByTitle("Quarterly report interactive app");
    await waitFor(() => expect(proxyWindow.postMessage).toHaveBeenCalledWith({
      type: "mono-agent:mcp-app-proxy-config",
      nonce: expect.any(String),
      invocationId: appPart.invocationId,
      connectionId: appPart.connectionId,
      clipboardWrite: false,
    }, "*"));
  });

  it("fails closed on a ready message with the wrong window, origin, nonce, invocation, or connection", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>interactive</p>",
      connected: true,
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const config = await configureRenderedApp(frame);
    const dispatchReady = (overrides: Record<string, unknown> = {}, source: MessageEventSource | null = frame.contentWindow) => {
      window.dispatchEvent(new MessageEvent("message", {
        source,
        origin: "null",
        data: {
          type: "mono-agent:mcp-app-proxy-ready",
          nonce: config.nonce,
          invocationId: config.invocationId,
          connectionId: config.connectionId,
          ...overrides,
        },
      }));
    };

    dispatchReady({}, window);
    dispatchReady({ type: "wrong-ready" }, frame.contentWindow);
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { ...config, type: "mono-agent:mcp-app-proxy-ready" },
    }));
    dispatchReady({ nonce: "wrong-nonce" });
    dispatchReady({ invocationId: "wrong-invocation" });
    dispatchReady({ connectionId: "wrong-connection" });
    await act(async () => await Promise.resolve());
    expect(bridgeHarness.instances).toHaveLength(0);

    dispatchReady();
    await waitFor(() => expect(bridgeHarness.instances).toHaveLength(1));
  });

  it("treats window.open returning null under noopener as a successful safe open", () => {
    const opener = vi.fn(() => null);
    expect(openExternalMcpAppLink("https://example.com/report", opener)).toBe(true);
    expect(opener).toHaveBeenCalledWith(
      "https://example.com/report",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("bounds and redacts confirmation argument previews", () => {
    const preview = mcpAppArgumentPreview({
      query: "visible",
      apiKey: "must-not-appear",
      nested: { authorization: "Bearer secret", values: Array.from({ length: 30 }, (_, index) => index) },
    });
    if (preview === undefined) throw new Error("Expected an argument preview.");
    expect(preview).toContain("visible");
    expect(preview).toContain("[redacted]");
    expect(preview).not.toContain("must-not-appear");
    expect(preview).not.toContain("Bearer secret");
    expect(new TextEncoder().encode(preview).byteLength).toBeLessThanOrEqual(2_048);
  });

  it("keeps app markup out of the normal document and labels the sandbox for assistive tech", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: '<img src=x onerror="document.body.dataset.pwned=1"><script>document.body.dataset.pwned=1</script>',
      toolInput: { reportId: 7 },
      toolResult: { content: [{ type: "text", text: "ready" }] },
      connected: true,
    });

    const { container } = render(app(appPart));
    const region = screen.getByRole("region", { name: "Interactive app: Quarterly report" });
    expect(region).toBeVisible();
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame).not.toHaveAttribute("allow", expect.stringContaining("camera"));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(document.body).not.toHaveAttribute("data-pwned");
    expect(frame).toHaveAttribute("src", "/api/v1/mcp-app-proxy");
    expect(frame).not.toHaveAttribute("srcdoc");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Starting the isolated app"));
  });

  it("accepts the legacy ext-apps protocol revision for the isolated bridge", async () => {
    const legacy = { ...appPart, protocolVersion: "2025-11-21" as const };
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: legacy,
      html: "<!doctype html><p>legacy</p>",
      connected: true,
    });

    render(app(legacy));

    expect(await screen.findByTitle("Quarterly report interactive app")).toHaveAttribute(
      "sandbox",
      "allow-scripts",
    );
  });

  it("shows redacted arguments, traps focus, and makes the app inert while confirmation is pending", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>interactive</p>",
      connected: true,
    });
    const { container } = render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    frame.focus();
    const bridge = await connectRenderedApp(frame, appPart);
    expect(bridge?.oncalltool).toBeTypeOf("function");
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = bridge!.oncalltool!({
        name: "refresh_chart",
        arguments: { query: "visible", apiKey: "hidden-secret" },
      });
      await Promise.resolve();
    });

    const dialog = screen.getByRole("dialog", { name: "Allow app tool call?" });
    expect(dialog).toHaveTextContent("visible");
    expect(dialog).toHaveTextContent("[redacted]");
    expect(dialog).not.toHaveTextContent("hidden-secret");
    expect(screen.getByRole("button", { name: "Allow once" })).toHaveFocus();
    expect(frame).toHaveAttribute("inert");
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(container.querySelector("header")).toHaveAttribute("inert");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await expect(pending).rejects.toThrow("declined");
    await waitFor(() => {
      expect(frame).not.toHaveAttribute("inert");
      expect(frame).toHaveAttribute("tabindex", "0");
      expect(frame).toHaveFocus();
    });
  });

  it("keeps one app instance and an open confirmation across token rotation, then uses the latest capability", async () => {
    const rotated = {
      ...appPart,
      resourceUrl: appPart.resourceUrl!
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
      bridgeUrl: appPart.bridgeUrl!
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
    };
    const lateOlderAdoption = {
      ...appPart,
      resourceUrl: appPart.resourceUrl!
        .replace("1234567890", "1734567890")
        .replace(/token=[^&]+/u, `token=${"c".repeat(43)}`),
      bridgeUrl: appPart.bridgeUrl!
        .replace("1234567890", "1734567890")
        .replace(/token=[^&]+/u, `token=${"c".repeat(43)}`),
    };
    let lateAdopt: ReplyAccessRefreshHandler<"mcp_app"> | undefined;
    const load = vi.spyOn(api, "mcpAppResource").mockImplementation(
      async (_url, _signal, onAccessRefreshed) => {
        lateAdopt = onAccessRefreshed;
        return {
          app: appPart,
          html: "<!doctype html><p>interactive</p>",
          connected: true,
        };
      },
    );
    const request = vi.spyOn(api, "mcpAppRequest").mockResolvedValue({ content: [] });
    const view = render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);
    const teardown = vi.spyOn(bridge, "teardownResource");
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = bridge.oncalltool!({ name: "refresh_chart" });
      await Promise.resolve();
    });
    const dialog = screen.getByRole("dialog", { name: "Allow app tool call?" });
    expect(screen.getByRole("button", { name: "Allow once" })).toHaveFocus();

    view.rerender(app(rotated));
    await act(async () => {
      lateAdopt?.(lateOlderAdoption);
      await Promise.resolve();
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle("Quarterly report interactive app")).toBe(frame);
    expect(screen.getByRole("dialog", { name: "Allow app tool call?" })).toBe(dialog);
    expect(screen.getByRole("button", { name: "Allow once" })).toHaveFocus();
    expect(teardown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await act(async () => {
      await pending;
    });

    expect(request).toHaveBeenCalledWith(
      rotated.bridgeUrl,
      "tools/call",
      { name: "refresh_chart" },
      true,
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("declines an outstanding confirmation when the app identity changes", async () => {
    const replacement: McpAppPartValue = {
      ...appPart,
      id: "app-2",
      invocationId: "22222222-2222-4222-8222-222222222222",
      connectionId: "connection-2",
      resourceUri: "ui://reports/replacement",
      title: "Replacement",
      resourceUrl: appPart.resourceUrl!.replaceAll("app-1", "app-2"),
      bridgeUrl: appPart.bridgeUrl!.replaceAll("app-1", "app-2"),
    };
    vi.spyOn(api, "mcpAppResource").mockImplementation(async (url) => {
      const value = url.includes("app-2") ? replacement : appPart;
      return {
        app: value,
        html: "<!doctype html><p>interactive</p>",
        connected: true,
      };
    });
    const request = vi.spyOn(api, "mcpAppRequest").mockResolvedValue({});
    const view = render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);
    const teardown = vi.spyOn(bridge, "teardownResource");
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = bridge.oncalltool!({ name: "refresh_chart" });
      await Promise.resolve();
    });
    expect(screen.getByRole("dialog", { name: "Allow app tool call?" })).toBeVisible();

    view.rerender(app(replacement));

    await expect(pending).rejects.toThrow("declined");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(request).not.toHaveBeenCalled();
    await waitFor(() => expect(teardown).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      screen.getByRole("region", { name: "Interactive app: Replacement" }),
    ).toHaveFocus());
    expect(await screen.findByTitle("Replacement interactive app")).toBeVisible();
  });

  it("uses textual error state when an app has no private endpoints", () => {
    render(app({ ...appPart, resourceUrl: undefined, bridgeUrl: undefined }));
    expect(screen.getByRole("status")).toHaveTextContent("does not have a valid private host endpoint");
    expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();
  });

  it("renders a canned MCP App load failure without exposing server-controlled paths or tokens", async () => {
    vi.spyOn(api, "mcpAppResource").mockRejectedValue(new ApiError(
      "read /private/agents/report.html?token=must-not-leak: upstream said hostile detail",
      502,
      "invalid_operator_mcp_app",
    ));

    render(app(appPart));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The MCP App could not be loaded."));
    expect(document.body).not.toHaveTextContent("/private/agents");
    expect(document.body).not.toHaveTextContent("must-not-leak");
    expect(document.body).not.toHaveTextContent("hostile detail");
  });

  it.each([
    { path: "sandbox", message: "The app sandbox rejected its resource." },
    { path: "initialize", message: "The app could not be initialized." },
    { path: "reported", message: "The app bridge reported an error." },
    { path: "connect", message: "The app bridge could not start." },
  ] as const)("renders a canned $path bridge failure without exposing untrusted text", async ({ path, message }) => {
    const privateError = new Error(
      `read /private/agents/report.html?token=must-not-leak: ${path} library secret`,
    );
    if (path !== "reported") bridgeHarness.failures[path] = privateError;
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>interactive</p>",
      connected: true,
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);
    await act(async () => {
      if (path === "sandbox") bridge.onsandboxready?.();
      if (path === "initialize") bridge.oninitialized?.();
      if (path === "reported") bridge.onerror?.(privateError);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
    expect(document.body).not.toHaveTextContent("/private/agents");
    expect(document.body).not.toHaveTextContent("must-not-leak");
    expect(document.body).not.toHaveTextContent("library secret");
  });

  it("keeps StrictMode resource fetches generation-owned across identity change and unmount", async () => {
    const replacement: McpAppPartValue = {
      ...appPart,
      id: "app-2",
      invocationId: "22222222-2222-4222-8222-222222222222",
      connectionId: "connection-2",
      resourceUri: "ui://reports/replacement",
      title: "Replacement",
      resourceUrl: appPart.resourceUrl!.replaceAll("app-1", "app-2"),
      bridgeUrl: appPart.bridgeUrl!.replaceAll("app-1", "app-2"),
    };
    const held: Array<{
      readonly signal: AbortSignal | undefined;
      readonly resolve: (response: Response) => void;
    }> = [];
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        held.push({ signal: init?.signal as AbortSignal | undefined, resolve });
      }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<StrictMode>{app(appPart)}</StrictMode>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(appPart.resourceUrl);
    expect(held[0]?.signal?.aborted).toBe(false);

    view.rerender(<StrictMode>{app(replacement)}</StrictMode>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(held[0]?.signal?.aborted).toBe(true);
    expect(held[1]?.signal?.aborted).toBe(false);
    await act(async () => {
      held[0]?.resolve(Response.json({
        app: appPart,
        html: "<!doctype html><p>late</p>",
        connected: true,
      }));
      await Promise.resolve();
    });
    expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();

    await act(async () => {
      held[1]?.resolve(Response.json({
        app: replacement,
        html: "<!doctype html><p>replacement</p>",
        connected: true,
      }));
      await Promise.resolve();
    });
    expect(await screen.findByTitle("Replacement interactive app")).toBeVisible();
    view.unmount();
    expect(held[1]?.signal?.aborted).toBe(true);
  });

  it("aborts an expired bridge refresh on identity change and ignores its late capability", async () => {
    const replacement: McpAppPartValue = {
      ...appPart,
      id: "app-2",
      invocationId: "22222222-2222-4222-8222-222222222222",
      connectionId: "connection-2",
      resourceUri: "ui://reports/replacement",
      title: "Replacement",
      resourceUrl: appPart.resourceUrl!.replaceAll("app-1", "app-2"),
      bridgeUrl: appPart.bridgeUrl!.replaceAll("app-1", "app-2"),
    };
    const refreshedOld = {
      ...appPart,
      resourceUrl: appPart.resourceUrl!
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
      bridgeUrl: appPart.bridgeUrl!
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
    };
    let heldAccess: {
      readonly signal: AbortSignal | undefined;
      readonly resolve: (response: Response) => void;
    } | undefined;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/mcp-apps/app-1/access")) {
        return new Promise((resolve) => {
          heldAccess = { signal: init?.signal as AbortSignal | undefined, resolve };
        });
      }
      if (url.includes("/mcp-apps/app-1/requests")) {
        return Promise.resolve(Response.json(
          { error: { code: "reply_access_expired", message: "Expired." } },
          { status: 410 },
        ));
      }
      const resourcePart = url.includes("/mcp-apps/app-2") ? replacement : appPart;
      return Promise.resolve(Response.json({
        app: resourcePart,
        html: `<!doctype html><p>${resourcePart.title}</p>`,
        connected: true,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = bridge.onreadresource!({ uri: "ui://reports/data" });
      await Promise.resolve();
    });
    await waitFor(() => expect(heldAccess).toBeDefined());
    expect(heldAccess?.signal?.aborted).toBe(false);

    view.rerender(app(replacement));
    expect(heldAccess?.signal?.aborted).toBe(true);
    await act(async () => {
      heldAccess?.resolve(Response.json({ part: refreshedOld }));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });

    expect(await screen.findByTitle("Replacement interactive app")).toHaveAttribute("sandbox", "allow-scripts");
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(refreshedOld.bridgeUrl);
    expect(screen.getByRole("status")).toHaveTextContent("Starting the isolated app");
  });

  it("routes every app forward method through adopted bridge access", async () => {
    const fresh = {
      ...appPart,
      resourceUrl: appPart.resourceUrl!
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
      bridgeUrl: appPart.bridgeUrl!
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
    };
    const load = vi.spyOn(api, "mcpAppResource").mockImplementation(
      async (_url, _signal, onAccessRefreshed) => {
        onAccessRefreshed?.(fresh);
        return {
          app: fresh,
          html: "<!doctype html><p>interactive</p>",
          connected: true,
        };
      },
    );
    const request = vi.spyOn(api, "mcpAppRequest").mockImplementation(async (_url, method) => {
      if (method === "resources/read") return { contents: [] };
      if (method === "tools/call") return { content: [{ type: "text", text: "done" }] };
      if (method === "ui/open-link") return { allowed: false };
      return { accepted: true };
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);
    expect(bridge?.onreadresource).toBeTypeOf("function");

    await act(async () => {
      await bridge!.onreadresource!({ uri: "ui://reports/data" });
    });
    const allow = async (operation: () => Promise<unknown>) => {
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = operation();
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
      await act(async () => {
        await pending;
      });
    };
    await allow(() => bridge!.oncalltool!({ name: "refresh_chart", arguments: { range: "week" } }));
    await allow(() => bridge!.onopenlink!({ url: "https://example.com/report" }));
    await allow(() => bridge!.onupdatemodelcontext!({ content: [{ type: "text", text: "context" }] }));

    expect(load).toHaveBeenCalledWith(appPart.resourceUrl, expect.any(AbortSignal), expect.any(Function));
    expect(request.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [fresh.bridgeUrl, "resources/read"],
      [fresh.bridgeUrl, "tools/call"],
      [fresh.bridgeUrl, "ui/open-link"],
      [fresh.bridgeUrl, "ui/update-model-context"],
    ]);
  });

  it("does not adopt refreshed URLs from a different app identity", async () => {
    const crossIdentity = {
      ...appPart,
      connectionId: "connection-2",
      resourceUrl: appPart.resourceUrl!.replace("1234567890", "2234567890"),
      bridgeUrl: appPart.bridgeUrl!.replace("1234567890", "2234567890"),
    };
    vi.spyOn(api, "mcpAppResource").mockImplementation(async (_url, _signal, onAccessRefreshed) => {
      onAccessRefreshed?.(crossIdentity);
      return {
        app: appPart,
        html: "<!doctype html><p>interactive</p>",
        connected: true,
      };
    });
    const request = vi.spyOn(api, "mcpAppRequest").mockResolvedValue({ contents: [] });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);

    await act(async () => {
      await bridge!.onreadresource!({ uri: "ui://reports/data" });
    });

    expect(request).toHaveBeenCalledWith(
      appPart.bridgeUrl,
      "resources/read",
      { uri: "ui://reports/data" },
      false,
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("uses adopted resource access for an explicit app refresh after bridge expiry", async () => {
    const fresh = {
      ...appPart,
      resourceUrl: appPart.resourceUrl!
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
      bridgeUrl: appPart.bridgeUrl!
        .replace("1234567890", "2234567890")
        .replace(/token=[^&]+/u, `token=${"b".repeat(43)}`),
    };
    const resource = {
      app: fresh,
      html: "<!doctype html><p>interactive</p>",
      connected: true,
    };
    const load = vi.spyOn(api, "mcpAppResource")
      .mockImplementationOnce(async (_url, _signal, onAccessRefreshed) => {
        onAccessRefreshed?.(fresh);
        return resource;
      })
      .mockResolvedValueOnce(resource);
    vi.spyOn(api, "mcpAppRequest").mockRejectedValue(
      new ApiError("Reply access expired.", 410, "reply_access_expired"),
    );

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);

    await act(async () => {
      await expect(bridge!.onreadresource!({ uri: "ui://reports/data" })).rejects.toMatchObject({
        code: "reply_access_expired",
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reopen Quarterly report" }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]?.[0]).toBe(fresh.resourceUrl);
  });

  it("announces exhausted app access recovery and reconnects from an explicit refresh action", async () => {
    const resource = {
      app: appPart,
      html: "<!doctype html><p>reconnected</p>",
      connected: true,
    };
    const load = vi.spyOn(api, "mcpAppResource")
      .mockRejectedValueOnce(new ApiError("Reply access expired.", 410, "reply_access_expired"))
      .mockResolvedValueOnce(resource);

    render(app(appPart));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Interactive app access expired"));
    fireEvent.click(screen.getByRole("button", { name: "Reopen Quarterly report" }));

    expect(await screen.findByTitle("Quarterly report interactive app")).toHaveAttribute("sandbox", "allow-scripts");
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Starting the isolated app");
  });
  it("never lends one app's document to the card that replaced it", async () => {
    const replacement: McpAppPartValue = {
      ...appPart,
      id: "app-2",
      invocationId: "22222222-2222-4222-8222-222222222222",
      connectionId: "connection-2",
      resourceUri: "ui://reports/replacement",
      title: "Replacement",
      resourceUrl: appPart.resourceUrl!.replaceAll("app-1", "app-2"),
      bridgeUrl: appPart.bridgeUrl!.replaceAll("app-1", "app-2"),
    };
    const viewport = stubIntersectionObserver();
    const load = vi.spyOn(api, "mcpAppResource").mockImplementation(async (url) => (url.includes("app-2")
      ? { app: replacement, html: "<!doctype html><p>second-document</p>", connected: true }
      : { app: appPart, html: "<!doctype html><p>first-document</p>", connected: true }));

    const view = render(app(appPart));
    await viewport.intersect();
    expect(await screen.findByTitle("Quarterly report interactive app")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide Quarterly report" }));
    await waitFor(() => {
      expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();
    });
    bridgeHarness.instances.length = 0;
    bridgeHarness.resources.length = 0;

    // The same slot in the transcript, now holding a different app entirely.
    view.rerender(app(replacement));

    // Nothing of the previous app survives into this card: no frame, no bridge,
    // and no inherited status.
    expect(screen.queryByTitle("Replacement interactive app")).not.toBeInTheDocument();
    expect(bridgeHarness.instances).toHaveLength(0);
    expect(screen.getByRole("status")).not.toHaveTextContent("Hidden. Choose Show");
    expect(load).toHaveBeenCalledTimes(1);

    // The card is watched again from scratch, and says what it is once the
    // answer is in.
    await viewport.report(false);
    expect(screen.getByRole("status")).toHaveTextContent("Tap Show to load the app");
    expect(load).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Show Replacement" }));
    const frame = await screen.findByTitle("Replacement interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, replacement);
    await act(async () => {
      bridge.onsandboxready?.();
      await Promise.resolve();
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(bridgeHarness.resources).toHaveLength(1);
    const delivered = (bridgeHarness.resources[0] as { readonly html: string }).html;
    expect(delivered).toContain("second-document");
    expect(delivered).not.toContain("first-document");
  });

  it("waits to know where the card is before telling the operator to tap Show", async () => {
    const viewport = stubIntersectionObserver();
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>gallery</p>",
      connected: true,
    });

    render(app(appPart));

    // The first observation lands a frame after mount. Until it does, the card
    // has no business claiming the operator has to do something.
    expect(screen.getByRole("status")).not.toHaveTextContent("Tap Show to load the app");

    await viewport.report(false);

    expect(screen.getByRole("status")).toHaveTextContent("Tap Show to load the app");
  });

  it("stops waiting for an observation the mode change cancelled", async () => {
    // Switching to Lean tears the reveal observer down before it has ever
    // reported. The card was left waiting for an answer that is no longer
    // coming, and rendered an empty status line for the rest of its life.
    const viewport = stubIntersectionObserver();
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>gallery</p>",
      connected: true,
    });

    render(app(appPart));
    expect(screen.getByRole("status")).not.toHaveTextContent("Tap Show to load the app");

    await act(async () => { writeDataModeSetting("lean"); });

    expect(screen.getByRole("status")).toHaveTextContent("Tap Show to load the app");
    expect(viewport.disconnects()).toBeGreaterThan(0);
  });

  it("leaves an off-screen app document unrequested until it is asked for", async () => {
    const viewport = stubIntersectionObserver();
    const load = vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>gallery</p>",
      connected: true,
    });

    render(app(appPart));
    await viewport.report(false);

    // An app the operator has not reached is a document, a bridge and a sandbox
    // that nobody asked for. Scrolling past it must cost nothing.
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Tap Show to load the app");
    expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Quarterly report" }));

    expect(await screen.findByTitle("Quarterly report interactive app")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("opens an app when it first scrolls in and then leaves the control to the operator", async () => {
    const viewport = stubIntersectionObserver();
    const load = vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>gallery</p>",
      connected: true,
    });

    render(app(appPart));
    await act(async () => { await Promise.resolve(); });
    expect(load).not.toHaveBeenCalled();

    await viewport.intersect();

    expect(await screen.findByTitle("Quarterly report interactive app")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Hide Quarterly report" }));
    await waitFor(() => {
      expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();
    });

    // Still on screen, and staying there: the viewport must not reopen an app
    // the operator just closed.
    await viewport.intersect();
    expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Hidden. Choose Show to bring the app back.");

    fireEvent.click(screen.getByRole("button", { name: "Show Quarterly report" }));

    expect(await screen.findByTitle("Quarterly report interactive app")).toBeInTheDocument();
    // Re-showing what is already loaded does not fetch the document again.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("hides and restores the app from one reversible header control", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>gallery</p>",
      connected: true,
    });

    render(app(appPart));
    expect(await screen.findByTitle("Quarterly report interactive app")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide Quarterly report" }));
    await waitFor(() => {
      expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();
    });

    // The control must survive collapsing. A card that can be closed but not
    // reopened is the dead end this replaced.
    const show = screen.getByRole("button", { name: "Show Quarterly report" });
    expect(show).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(show);
    expect(await screen.findByTitle("Quarterly report interactive app")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Quarterly report" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("offers Reopen after the app tears itself down", async () => {
    const load = vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>torn down</p>",
      connected: true,
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);

    await act(async () => {
      bridge.onrequestteardown?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen Quarterly report" }));

    expect(await screen.findByTitle("Quarterly report interactive app")).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("clamps an app-reported height into the host bounds", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>tall</p>",
      connected: true,
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);

    await act(async () => {
      bridge.onsizechange?.({ height: 99_999 });
      await Promise.resolve();
    });
    await waitFor(() => expect(frame.style.height).toBe("1600px"));

    await act(async () => {
      bridge.onsizechange?.({ height: 1 });
      await Promise.resolve();
    });
    await waitFor(() => expect(frame.style.height).toBe("160px"));
  });

  it("keeps the sandbox ready message to its exact allowed keys", async () => {
    vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>keys</p>",
      connected: true,
    });

    render(app(appPart));
    const frame = await screen.findByTitle("Quarterly report interactive app") as HTMLIFrameElement;
    const bridge = await connectRenderedApp(frame, appPart);
    await act(async () => {
      bridge.onsandboxready?.();
      await Promise.resolve();
    });

    // The proxy validates this payload with an exact-key check and fails closed on
    // anything unknown, so a stray layout hint here would break every app render.
    expect(bridgeHarness.resources).toHaveLength(1);
    for (const key of Object.keys(bridgeHarness.resources[0] as Record<string, unknown>)) {
      expect(["html", "sandbox", "csp", "permissions"]).toContain(key);
    }
  });

  it("treats preferredSize as a clamped hint and ignores unusable values", () => {
    expect(mcpAppPreferredHeight({ ui: { preferredSize: { height: 600 } } })).toBe(600);
    expect(mcpAppPreferredHeight({ ui: { preferredSize: { height: 99_999 } } })).toBe(1600);
    expect(mcpAppPreferredHeight({ ui: { preferredSize: { height: 10 } } })).toBe(160);
    for (const height of [0, -600, Number.NaN, Number.POSITIVE_INFINITY, "600", null]) {
      expect(mcpAppPreferredHeight({ ui: { preferredSize: { height } } })).toBeUndefined();
    }
    expect(mcpAppPreferredHeight(undefined)).toBeUndefined();
    expect(mcpAppPreferredHeight({ ui: {} })).toBeUndefined();
  });
  it("offers Reopen rather than Hide when the app never loaded", async () => {
    // The common shape of this: an older conversation whose originating
    // connection was evicted, so the resource fetch fails outright.
    const load = vi.spyOn(api, "mcpAppResource")
      .mockRejectedValueOnce(new Error("connection gone"))
      .mockResolvedValueOnce({
        app: appPart,
        html: "<!doctype html><p>recovered</p>",
        connected: true,
      });

    render(app(appPart));
    await waitFor(() => expect(screen.getByRole("status")).toHaveClass("is-error"));

    // Hide would be useless here: nothing is rendered, and re-expanding does not
    // re-fetch the resource.
    expect(screen.queryByRole("button", { name: "Hide Quarterly report" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen Quarterly report" }));

    expect(await screen.findByTitle("Quarterly report interactive app")).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

describe("a lean link, and a device that kept the picture but not the key", () => {
  afterEach(() => {
    localStorage.clear();
    clearReplyImageBlobs();
  });

  it("spends nothing on a picture until the operator asks for it", async () => {
    writeDataModeSetting("lean");
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());
    stubImageObjectUrls();

    render(attachment(imagePart));

    // Nothing has been asked for, and the tile says what asking will cost.
    expect(fetchContent).not.toHaveBeenCalled();
    const tile = screen.getByRole("button", { name: "Load cover.png, 4 B" });
    expect(tile).toBeVisible();
    expect(screen.queryByRole("img", { name: "cover.png" })).toBeNull();

    fireEvent.click(tile);

    expect(await screen.findByRole("img", { name: "cover.png" })).toHaveAttribute("src", "blob:cover-image");
    expect(fetchContent).toHaveBeenCalledTimes(1);
  });

  it("leaves an app closed on a lean link however far up the transcript it is", async () => {
    writeDataModeSetting("lean");
    const load = vi.spyOn(api, "mcpAppResource").mockResolvedValue({
      app: appPart,
      html: "<!doctype html><p>gallery</p>",
      connected: true,
    });

    render(app(appPart));

    // No IntersectionObserver here, so in full mode this card would have opened
    // itself and bought its document on arrival.
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Tap Show to load the app");

    fireEvent.click(screen.getByRole("button", { name: "Show Quarterly report" }));

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1); });
  });

  it("asks for a fresh key for a picture the device restored without one", async () => {
    // What PR 5 persists deliberately carries no capability URL, so a restored
    // picture used to render as a dead file card. It is not dead: the console
    // can mint a new capability for exactly this part.
    const { contentUrl: _dropped, ...restored } = imagePart;
    const access = vi.fn().mockResolvedValue(imagePart);
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());
    stubImageObjectUrls();

    render(
      <ReplyAccessProvider refreshAttachment={access}>
        {attachment(restored)}
      </ReplyAccessProvider>,
    );

    expect(await screen.findByRole("img", { name: "cover.png" })).toHaveAttribute("src", "blob:cover-image");
    expect(access).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledWith("cover-part");
    expect(fetchContent).toHaveBeenCalledTimes(1);
  });

  it("offers a restored file its download rather than calling it gone", async () => {
    const { contentUrl: _dropped, ...restored } = attachmentPart;
    const access = vi.fn().mockResolvedValue(attachmentPart);
    const fetchContent = vi.spyOn(api, "replyAttachmentContent")
      .mockImplementation(async () => attachmentResponse());

    render(
      <ReplyAccessProvider refreshAttachment={access}>
        {attachment(restored)}
      </ReplyAccessProvider>,
    );

    expect(screen.queryByText("This file is no longer available.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    await waitFor(() => { expect(fetchContent).toHaveBeenCalledTimes(1); });
    expect(access).toHaveBeenCalledWith("file-1");
  });

  it("says so, once, when a restored file really cannot be reached again", async () => {
    const { contentUrl: _dropped, ...restored } = attachmentPart;
    const access = vi.fn().mockRejectedValue(
      new ApiError("The reply part is unavailable.", 404, "reply_part_not_found"),
    );

    render(
      <ReplyAccessProvider refreshAttachment={access}>
        {attachment(restored)}
      </ReplyAccessProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));

    // The refusal is reported as the refusal it was, and the offer is withdrawn
    // because there is nothing left to offer.
    expect(await screen.findByText("The reply part is unavailable. (reply_part_not_found)")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download report.txt" })).toBeNull();
    expect(access).toHaveBeenCalledTimes(1);
  });
});

describe("a lean link, second look", () => {
  afterEach(() => {
    localStorage.clear();
    clearReplyImageBlobs();
  });

  it("just shows a picture it is already holding, rather than offering to load it again", async () => {
    // Scrolling a picture out of the strip and back unmounts and remounts the
    // tile, and the bytes are still in the shared store for the retention
    // window. Offering "Load cover.png" for bytes already held is a tap target
    // that lies about what it costs.
    writeDataModeSetting("lean");
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());
    stubImageObjectUrls();

    const first = render(attachment(imagePart));
    fireEvent.click(screen.getByRole("button", { name: "Load cover.png, 4 B" }));
    expect(await screen.findByRole("img", { name: "cover.png" })).toBeInTheDocument();
    first.unmount();

    render(attachment(imagePart));

    expect(await screen.findByRole("img", { name: "cover.png" })).toHaveAttribute("src", "blob:cover-image");
    expect(screen.queryByRole("button", { name: /^Load cover\.png/u })).toBeNull();
    expect(fetchContent).toHaveBeenCalledTimes(1);
  });

  it("never mints a key for a picture whose own endpoint was refused", async () => {
    // A part that DECLARES a capability the console rejects is not a part that
    // lost its key: it is a payload trying to move a private read somewhere
    // else. Only a part carrying no `contentUrl` at all -- what this device
    // stores -- is offered a fresh one.
    const offOrigin = { ...imagePart, contentUrl: "https://elsewhere.example/steal" };
    const access = vi.fn().mockResolvedValue(imagePart);
    const fetchContent = vi.spyOn(api, "replyAttachmentContent").mockImplementation(async () => imageResponse());

    render(
      <ReplyAccessProvider refreshAttachment={access}>
        {attachment(offOrigin)}
      </ReplyAccessProvider>,
    );

    expect(await screen.findByText("This file is no longer available.")).toBeVisible();
    expect(access).not.toHaveBeenCalled();
    expect(fetchContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "cover.png" })).toBeNull();
  });
});

describe("the durable copy on a lean link", () => {
  const storedImagePart = {
    type: "attachment" as const,
    id: "cover-part",
    artifactId: "artifact-cover",
    name: "cover.png",
    mediaType: "image/png",
    sizeBytes: 2_048,
    integrityId: "sha256:abc",
    storedUrl: "/api/v1/uploads/reply%3Amsg%3Acover-part/content",
    contentUrl: imagePart.contentUrl,
  };

  afterEach(() => {
    localStorage.clear();
    resetDataUsage();
  });

  it("prices the console's own copy too, because the browser still fetches it", async () => {
    // The service persists a durable copy of nearly every raster reply image, so
    // this -- not the capability path -- is the ORDINARY picture. Left ungated
    // it downloaded at full resolution near the viewport while the indicator and
    // the Lean offer both said pictures load only when you ask for them.
    writeDataModeSetting("lean");
    resetDataUsage();
    render(attachment(storedImagePart));

    expect(screen.queryByRole("img", { name: "cover.png" })).toBeNull();
    const tile = screen.getByRole("button", { name: "Load cover.png, 2 KiB" });

    fireEvent.click(tile);

    expect(await screen.findByRole("img", { name: "cover.png" }))
      .toHaveAttribute("src", storedImagePart.storedUrl);
    // Bytes the browser fetches for an `<img>` are invisible to the body-length
    // estimate, so the tile -- which knows the size -- counts them where there
    // is no resource timing to do it instead.
    expect(dataUsage().bytes).toBe(storedImagePart.sizeBytes);
  });

  it("shows the console's own copy straight away on a full link", () => {
    // With an observer, which is the branch production takes: a durable copy is
    // not gated on the viewport either, because there is nothing to fetch.
    stubIntersectionObserver();
    render(attachment(storedImagePart));

    expect(screen.getByRole("img", { name: "cover.png" }))
      .toHaveAttribute("src", storedImagePart.storedUrl);
    expect(screen.queryByRole("button", { name: /^Load cover\.png/u })).toBeNull();
  });

  it("never takes back a picture the operator is already looking at", () => {
    // Switching to Lean cannot un-spend bytes. A picture already on screen has
    // been paid for -- and under PR 1's immutable headers a second view is a
    // cache hit -- so re-pricing it as "Load cover.png, 2 KiB" would be a tap
    // target that lies about its cost, and would take the picture away to do it.
    stubIntersectionObserver();
    render(attachment(storedImagePart));
    expect(screen.getByRole("img", { name: "cover.png" })).toBeInTheDocument();

    act(() => { writeDataModeSetting("lean"); });

    expect(screen.getByRole("img", { name: "cover.png" }))
      .toHaveAttribute("src", storedImagePart.storedUrl);
    expect(screen.queryByRole("button", { name: /^Load cover\.png/u })).toBeNull();
  });
});
