import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { ApiError, api } from "../api";
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

afterEach(() => {
  bridgeHarness.instances.length = 0;
  vi.restoreAllMocks();
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
      expect(screen.getByRole("status")).toHaveTextContent("Download started with refreshed access");
    });
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
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data: {
          type: "mono-agent:mcp-app-proxy-ready",
          nonce: JSON.parse(frame.getAttribute("srcdoc")?.match(/const config = (\{.*\});/u)?.[1] ?? "{}").nonce,
          invocationId: appPart.invocationId,
          connectionId: appPart.connectionId,
        },
      }));
      await Promise.resolve();
    });
    const bridge = bridgeHarness.instances[0] as {
      oncalltool?: (params: { name: string; arguments?: unknown }) => Promise<unknown>;
    } | undefined;
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

  it("uses textual error state when an app has no private endpoints", () => {
    render(app({ ...appPart, resourceUrl: undefined, bridgeUrl: undefined }));
    expect(screen.getByRole("status")).toHaveTextContent("does not have a valid private host endpoint");
    expect(screen.queryByTitle("Quarterly report interactive app")).not.toBeInTheDocument();
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
