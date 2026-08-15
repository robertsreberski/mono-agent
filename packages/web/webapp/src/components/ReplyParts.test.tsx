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
import type { McpAppPart as McpAppPartValue } from "../types";
import {
  McpAppPart,
  ReplyAttachmentPart,
  ReplyFailurePart,
  mcpAppContentSecurityPolicy,
  mcpAppArgumentPreview,
  openExternalMcpAppLink,
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

afterEach(() => {
  bridgeHarness.instances.length = 0;
  bridgeHarness.capabilities.length = 0;
  bridgeHarness.resources.length = 0;
  for (const key of Object.keys(bridgeHarness.failures)) delete bridgeHarness.failures[key];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    fireEvent.click(await screen.findByRole("button", { name: "Refresh app access for Quarterly report" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Refresh app access for Quarterly report" }));

    expect(await screen.findByTitle("Quarterly report interactive app")).toHaveAttribute("sandbox", "allow-scripts");
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Starting the isolated app");
  });
});
