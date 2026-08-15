import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeHarness = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }));
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
    constructor() { bridgeHarness.instances.push(this as unknown as Record<string, unknown>); }
    async connect() {}
    async sendSandboxResourceReady() {}
    async sendToolInput() {}
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
  mcpAppSandboxProxyDocument,
  openExternalMcpAppLink,
  safeMcpAppResourceMetadata,
  secureMcpAppHtml,
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
}

const connectRenderedApp = async (
  frame: HTMLIFrameElement,
  part: McpAppPartValue,
): Promise<TestAppBridgeInstance> => {
  const nonce = JSON.parse(frame.getAttribute("srcdoc")?.match(/const config = (\{.*\});/u)?.[1] ?? "{}").nonce;
  await waitFor(() => {
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        type: "mono-agent:mcp-app-proxy-ready",
        nonce,
        invocationId: part.invocationId,
        connectionId: part.connectionId,
      },
    }));
    expect(bridgeHarness.instances[0]).toBeDefined();
  });
  return bridgeHarness.instances[0] as TestAppBridgeInstance;
};

afterEach(() => {
  bridgeHarness.instances.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
});

describe("assistant reply files", () => {
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

  it("binds each opaque proxy to one nonce, invocation, connection, and origin", () => {
    const first = mcpAppSandboxProxyDocument({
      nonce: "nonce-one",
      invocationId: "invocation-one",
      connectionId: "connection-one",
      hostOrigin: "https://console.example",
      allow: "clipboard-write",
    });
    const second = mcpAppSandboxProxyDocument({
      nonce: "nonce-two",
      invocationId: "invocation-two",
      connectionId: "connection-two",
      hostOrigin: "https://console.example",
      allow: "",
    });

    expect(first).toContain("nonce-one");
    expect(first).toContain("invocation-one");
    expect(first).toContain("connection-one");
    expect(first).not.toContain("nonce-two");
    expect(second).toContain("nonce-two");
    expect(first).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(first).not.toContain("allow-same-origin");
    expect(first).toContain("event.source !== appFrame.contentWindow");
    expect(first).toContain('event.origin !== "null"');
    expect(first).toContain("appFrameLoads += 1");
    expect(first).toContain("App navigation was blocked.");
    expect(first).toContain("child-src 'self'");
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
    expect(frame).not.toHaveAttribute("allow", expect.stringContaining("camera"));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(document.body).not.toHaveAttribute("data-pwned");
    expect(frame.getAttribute("srcdoc")).not.toContain("document.body.dataset.pwned");
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
