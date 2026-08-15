import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  MCP_APP_SECURED_HTML_MAX_BYTES,
  secureMcpAppHtml,
} from "../mcp-app-document.js";
import {
  MCP_APP_PROXY_CONTENT_SECURITY_POLICY,
  MCP_APP_PROXY_DOCUMENT,
} from "../mcp-app-proxy.js";

interface ProxyMessageEvent {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

function proxyScript(): string {
  const match = /<script>\s*([\s\S]*?)\s*<\/script>/u.exec(MCP_APP_PROXY_DOCUMENT);
  if (match?.[1] === undefined) throw new Error("The MCP App proxy bootstrap script is missing.");
  return match[1];
}

const metadataForOrigin = (origin: string | undefined) => origin === undefined ? {} : {
  csp: {
    connectDomains: [origin],
    resourceDomains: [origin],
    frameDomains: [origin],
    baseUriDomains: [origin],
  },
};

const sandboxResourceReady = (
  html: string,
  metadata: ReturnType<typeof metadataForOrigin> = {},
  clipboardWrite = false,
) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/sandbox-resource-ready",
  params: {
    html,
    sandbox: "allow-scripts",
    ...(metadata.csp === undefined ? {} : { csp: metadata.csp }),
    ...(clipboardWrite ? { permissions: { clipboardWrite: {} } } : {}),
  },
});

function createProxyHarness() {
  const parentWindow = { postMessage: vi.fn() };
  const unrelatedWindow = { postMessage: vi.fn() };
  const operations: string[] = [];
  const frames: Array<{
    readonly attributes: Map<string, string>;
    readonly element: {
      readonly contentWindow: { readonly postMessage: ReturnType<typeof vi.fn> };
      referrerPolicy: string;
      srcdoc: string;
      readonly setAttribute: ReturnType<typeof vi.fn>;
      readonly addEventListener: ReturnType<typeof vi.fn>;
      readonly remove: ReturnType<typeof vi.fn>;
    };
    readonly innerWindow: { readonly postMessage: ReturnType<typeof vi.fn> };
    readonly load: () => void;
    setConnected(value: boolean): void;
  }> = [];
  let messageListener: ((event: ProxyMessageEvent) => void) | undefined;
  let intervalCallback: (() => void) | undefined;
  const createFrame = () => {
    const index = frames.length;
    const innerWindow = { postMessage: vi.fn() };
    const attributes = new Map<string, string>();
    let connected = false;
    let loadListener: (() => void) | undefined;
    let srcdoc = "";
    const element = {
      contentWindow: innerWindow,
      referrerPolicy: "",
      setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
      addEventListener: vi.fn((name: string, listener: () => void) => {
        if (name === "load") {
          operations.push(`frame:${index}:listen-load`);
          loadListener = listener;
        }
      }),
      remove: vi.fn(() => {
        operations.push(`frame:${index}:remove`);
        connected = false;
      }),
    };
    Object.defineProperty(element, "srcdoc", {
      configurable: true,
      get: () => srcdoc,
      set: (value: string) => {
        operations.push(`frame:${index}:srcdoc`);
        srcdoc = value;
        if (connected) loadListener?.();
      },
    });
    const frame = {
      attributes,
      element: element as typeof element & { srcdoc: string },
      innerWindow,
      load: () => loadListener?.(),
      setConnected: (value: boolean) => {
        connected = value;
      },
    };
    frames.push(frame);
    return frame.element;
  };
  const root = {
    textContent: "",
    replaceChildren: vi.fn((...children: unknown[]) => {
      operations.push("root:replaceChildren");
      for (const frame of frames) frame.setConnected(false);
      const mounted = frames.find((frame) => frame.element === children[0]);
      if (mounted !== undefined) {
        mounted.setConnected(true);
        mounted.load();
      }
    }),
  };
  const windowObject = {
    parent: parentWindow,
    addEventListener: vi.fn((name: string, listener: (event: ProxyMessageEvent) => void) => {
      if (name === "message") messageListener = listener;
    }),
    setInterval: vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return 17;
    }),
    clearInterval: vi.fn(),
  };
  const documentObject = {
    getElementById: vi.fn((id: string) => id === "root" ? root : null),
    createElement: vi.fn((name: string) => {
      if (name !== "iframe") throw new Error(`Unexpected element: ${name}`);
      return createFrame();
    }),
  };

  runInNewContext(proxyScript(), {
    document: documentObject,
    TextEncoder,
    URL,
    window: windowObject,
  });
  if (messageListener === undefined) throw new Error("The proxy did not install its message listener.");

  return {
    dispatch: (event: ProxyMessageEvent) => messageListener?.(event),
    frames,
    interval: () => intervalCallback?.(),
    load: (index = frames.length - 1) => frames[index]?.load(),
    operations,
    parentWindow,
    root,
    unrelatedWindow,
    windowObject,
  };
}

const configuration = {
  type: "mono-agent:mcp-app-proxy-config",
  nonce: "11111111-1111-4111-8111-111111111111",
  invocationId: "22222222-2222-4222-8222-222222222222",
  connectionId: "connection-one",
  clipboardWrite: false,
} as const;

describe("MCP App proxy bootstrap", () => {
  it("leaves inner capability directives to the canonical meta policy", () => {
    const directives = new Set(MCP_APP_PROXY_CONTENT_SECURITY_POLICY
      .split("; ")
      .map((directive) => directive.split(" ", 1)[0]));
    for (const omitted of [
      "default-src",
      "connect-src",
      "style-src",
      "img-src",
      "font-src",
      "media-src",
      "frame-src",
      "child-src",
      "base-uri",
    ]) expect(directives.has(omitted)).toBe(false);
    expect(MCP_APP_PROXY_DOCUMENT).toContain("<style>html,body,#root");
  });

  it("locks the first valid configuration and idempotently ignores repeated host-ready", () => {
    const harness = createProxyHarness();
    const hostOrigin = "https://console.example";
    expect(harness.parentWindow.postMessage).not.toHaveBeenCalled();

    harness.dispatch({ source: harness.unrelatedWindow, origin: hostOrigin, data: configuration });
    harness.dispatch({ source: harness.parentWindow, origin: "null", data: configuration });
    harness.dispatch({ source: harness.parentWindow, origin: "file://", data: configuration });
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, clipboardWrite: "yes" },
    });
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, unexpected: true },
    });
    expect(harness.parentWindow.postMessage).not.toHaveBeenCalled();

    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: configuration });
    expect(harness.windowObject.setInterval).toHaveBeenCalledOnce();
    expect(harness.parentWindow.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "mono-agent:mcp-app-proxy-ready",
      nonce: configuration.nonce,
      invocationId: configuration.invocationId,
      connectionId: configuration.connectionId,
    }, hostOrigin);

    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, nonce: "replacement" },
    });
    harness.dispatch({
      source: harness.parentWindow,
      origin: "https://other.example",
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
    });
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready", invocationId: "wrong" },
    });
    expect(harness.parentWindow.postMessage).toHaveBeenCalledTimes(1);

    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
    });
    expect(harness.windowObject.clearInterval).toHaveBeenCalledWith(17);
    expect(harness.parentWindow.postMessage).toHaveBeenLastCalledWith({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-proxy-ready",
      params: {},
    }, hostOrigin);
    const settledCalls = harness.parentWindow.postMessage.mock.calls.length;
    harness.interval();
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
    });
    expect(harness.parentWindow.postMessage).toHaveBeenCalledTimes(settledCalls);
  });

  it.each([
    ["empty metadata", undefined],
    ["capability-bearing metadata", "http://127.0.0.1:6060"],
  ] as const)("accepts real secured-document producer output for %s", (_label, origin) => {
    const harness = createProxyHarness();
    const hostOrigin = "http://127.0.0.1:5050";
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: configuration });
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
    });
    const metadata = metadataForOrigin(origin);
    const html = secureMcpAppHtml("<p>producer contract</p>", metadata);

    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: sandboxResourceReady(html, metadata),
    });

    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]?.element.srcdoc).toBe(html);
  });

  it("mounts escaping-heavy producer output at the exact byte cap and visibly rejects one byte over", () => {
    const hostOrigin = "http://127.0.0.1:5050";
    const prefixBytes = new TextEncoder().encode(secureMcpAppHtml("", {})).byteLength;
    const bodyBytes = MCP_APP_SECURED_HTML_MAX_BYTES - prefixBytes;
    const escapingPattern = ['"', "\\", "\n", "\t"].join("");
    const escapingBody = escapingPattern.repeat(Math.floor(bodyBytes / escapingPattern.length))
      + "x".repeat(bodyBytes % escapingPattern.length);
    const atLimit = secureMcpAppHtml(
      escapingBody,
      {},
    );
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(MCP_APP_SECURED_HTML_MAX_BYTES);
    const atLimitPayload = sandboxResourceReady(atLimit);
    expect(new TextEncoder().encode(JSON.stringify(atLimitPayload)).byteLength)
      .toBeGreaterThan(MCP_APP_SECURED_HTML_MAX_BYTES + 64 * 1024);
    const mount = (html: string) => {
      const harness = createProxyHarness();
      harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: configuration });
      harness.dispatch({
        source: harness.parentWindow,
        origin: hostOrigin,
        data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
      });
      harness.dispatch({
        source: harness.parentWindow,
        origin: hostOrigin,
        data: sandboxResourceReady(html),
      });
      return harness;
    };

    expect(mount(atLimit).frames).toHaveLength(1);
    const rejected = mount(`${atLimit}x`);
    expect(rejected.frames).toHaveLength(0);
    expect(rejected.root.textContent).toBe("The app resource was rejected.");
  });

  it("mounts only canonical secured HTML with srcdoc before the load listener and attachment", () => {
    const harness = createProxyHarness();
    const hostOrigin = "http://127.0.0.1:5050";
    const configured = { ...configuration, clipboardWrite: true };
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: configured });
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configured, type: "mono-agent:mcp-app-host-ready" },
    });
    harness.parentWindow.postMessage.mockClear();

    const html = secureMcpAppHtml(
      "<script>window.started=true<\/script>",
      metadataForOrigin("http://127.0.0.1:6060"),
    );
    const resourceReady = sandboxResourceReady(
      html,
      metadataForOrigin("http://127.0.0.1:6060"),
      true,
    );
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: resourceReady });
    const mounted = harness.frames[0];
    if (mounted === undefined) throw new Error("Expected the canonical MCP App frame to mount.");
    expect(harness.root.replaceChildren).toHaveBeenCalledExactlyOnceWith(mounted.element);
    expect(mounted.attributes).toEqual(new Map([
      ["title", "MCP App content"],
      ["sandbox", "allow-scripts"],
      ["allow", "clipboard-write"],
    ]));
    expect(mounted.element.srcdoc).toBe(html);
    expect(mounted.element.referrerPolicy).toBe("no-referrer");
    expect(mounted.attributes.get("sandbox")).toBe("allow-scripts");
    expect([...mounted.attributes.values()].join(" ")).not.toContain("allow-same-origin");
    const srcdocOperation = harness.operations.indexOf("frame:0:srcdoc");
    const loadListenerOperation = harness.operations.indexOf("frame:0:listen-load");
    const attachmentOperation = harness.operations.indexOf("root:replaceChildren");
    expect(srcdocOperation).toBeGreaterThanOrEqual(0);
    expect(loadListenerOperation).toBeGreaterThan(srcdocOperation);
    expect(attachmentOperation).toBeGreaterThan(loadListenerOperation);
    // The harness fires the attachment's initial load synchronously. Because
    // srcdoc was already assigned, it consumes only the first-load allowance.
    expect(mounted.element.remove).not.toHaveBeenCalled();
    expect(harness.root.textContent).toBe("");

    const appRpc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "refresh" } };
    harness.dispatch({ source: harness.unrelatedWindow, origin: "null", data: appRpc });
    harness.dispatch({ source: mounted.innerWindow, origin: hostOrigin, data: appRpc });
    harness.dispatch({
      source: mounted.innerWindow,
      origin: "null",
      data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" },
    });
    expect(harness.parentWindow.postMessage).not.toHaveBeenCalled();

    harness.dispatch({ source: mounted.innerWindow, origin: "null", data: appRpc });
    expect(harness.parentWindow.postMessage).toHaveBeenCalledExactlyOnceWith(appRpc, hostOrigin);

    const hostRpc = { jsonrpc: "2.0", id: 8, method: "ui/notifications/tool-input", params: {} };
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: hostRpc });
    expect(mounted.innerWindow.postMessage).toHaveBeenCalledExactlyOnceWith(hostRpc, "*");
    mounted.innerWindow.postMessage.mockClear();
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: {
        ...hostRpc,
        params: { text: "x".repeat(1024 * 1024 + 64 * 1024) },
      },
    });
    expect(mounted.innerWindow.postMessage).not.toHaveBeenCalled();

    harness.load();
    expect(mounted.element.remove).toHaveBeenCalledOnce();
    expect(harness.root.textContent).toBe("App navigation was blocked.");
  });

  it("rejects raw, missing, misplaced, weakened, and noncanonical CSP prefixes before srcdoc assignment", () => {
    const harness = createProxyHarness();
    const hostOrigin = "http://127.0.0.1:5050";
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: configuration });
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
    });

    const canonical = secureMcpAppHtml("<p>safe</p>", {});
    const invalid = [
      "<p>raw app HTML</p>",
      canonical.replace('<meta http-equiv="Content-Security-Policy"', '<meta name="not-csp"'),
      canonical.replace("<!doctype html><head>", "<!doctype html><head><title>before policy</title>"),
      canonical.replace('<meta http-equiv="Content-Security-Policy"', '<META  HTTP-EQUIV = "Content-Security-Policy"'),
      canonical.replace("default-src 'none'", "default-src *"),
      canonical.replace("connect-src 'none'", "connect-src https://example.com/path"),
      `\n${canonical}`,
      `${secureMcpAppHtml("", {})}${"x".repeat(MCP_APP_SECURED_HTML_MAX_BYTES)}`,
    ];
    for (const html of invalid) {
      harness.dispatch({
        source: harness.parentWindow,
        origin: hostOrigin,
        data: sandboxResourceReady(html),
      });
    }

    expect(harness.frames).toHaveLength(0);
    expect(harness.root.replaceChildren).not.toHaveBeenCalled();
    expect(harness.operations).not.toContain("frame:0:srcdoc");
    expect(harness.root.textContent).toBe("The app resource was rejected.");
  });

  it("uses matching configuration to re-arm, while delayed host-ready leaves the live app intact", () => {
    const harness = createProxyHarness();
    const hostOrigin = "https://console.example";
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: configuration });
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
    });
    const mount = (body: string) => harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: sandboxResourceReady(secureMcpAppHtml(body, {})),
    });
    mount("<p>first</p>");
    const first = harness.frames[0];
    if (first === undefined) throw new Error("Expected the first MCP App frame.");

    harness.parentWindow.postMessage.mockClear();
    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
    });
    expect(first.element.remove).not.toHaveBeenCalled();
    expect(harness.parentWindow.postMessage).not.toHaveBeenCalled();

    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, clipboardWrite: true },
    });
    expect(first.element.remove).not.toHaveBeenCalled();

    harness.parentWindow.postMessage.mockClear();
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: configuration });
    expect(first.element.remove).toHaveBeenCalledOnce();
    expect(harness.root.textContent).toBe("");
    expect(harness.parentWindow.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "mono-agent:mcp-app-proxy-ready",
      nonce: configuration.nonce,
      invocationId: configuration.invocationId,
      connectionId: configuration.connectionId,
    }, hostOrigin);

    const staleRpc = { jsonrpc: "2.0", id: 9, method: "tools/call" };
    harness.parentWindow.postMessage.mockClear();
    harness.dispatch({ source: first.innerWindow, origin: "null", data: staleRpc });
    expect(harness.parentWindow.postMessage).not.toHaveBeenCalled();

    harness.dispatch({
      source: harness.parentWindow,
      origin: hostOrigin,
      data: { ...configuration, type: "mono-agent:mcp-app-host-ready" },
    });
    mount("<p>second</p>");
    const second = harness.frames[1];
    if (second === undefined) throw new Error("Expected the replacement MCP App frame.");
    expect(second.attributes.get("sandbox")).toBe("allow-scripts");
    expect(second.attributes.has("allow")).toBe(false);

    harness.load(0);
    harness.dispatch({ source: first.innerWindow, origin: "null", data: staleRpc });
    expect(second.element.remove).not.toHaveBeenCalled();
    expect(harness.root.textContent).toBe("");

    const currentRpc = { ...staleRpc, id: 10 };
    harness.dispatch({ source: second.innerWindow, origin: "null", data: currentRpc });
    expect(harness.parentWindow.postMessage).toHaveBeenLastCalledWith(currentRpc, hostOrigin);
  });
});
