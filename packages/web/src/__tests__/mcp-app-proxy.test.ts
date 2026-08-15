import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { MCP_APP_PROXY_DOCUMENT } from "../mcp-app-proxy.js";

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

function createProxyHarness() {
  const parentWindow = { postMessage: vi.fn() };
  const unrelatedWindow = { postMessage: vi.fn() };
  const innerWindow = { postMessage: vi.fn() };
  const attributes = new Map<string, string>();
  let messageListener: ((event: ProxyMessageEvent) => void) | undefined;
  let loadListener: (() => void) | undefined;
  let intervalCallback: (() => void) | undefined;
  const frame = {
    contentWindow: innerWindow,
    referrerPolicy: "",
    srcdoc: "",
    setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
    addEventListener: vi.fn((name: string, listener: () => void) => {
      if (name === "load") loadListener = listener;
    }),
    remove: vi.fn(),
  };
  const root = {
    textContent: "",
    replaceChildren: vi.fn(),
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
      return frame;
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
    attributes,
    dispatch: (event: ProxyMessageEvent) => messageListener?.(event),
    frame,
    innerWindow,
    interval: () => intervalCallback?.(),
    load: () => loadListener?.(),
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
  it("locks the first valid direct-parent configuration and rejects every mismatched handshake", () => {
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

  it("mounts one allow-scripts srcdoc and forwards only source-bound opaque-origin RPC", () => {
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

    const securedHtml = "<!doctype html><script>window.started=true<\/script>";
    const resourceReady = {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: securedHtml },
    };
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: resourceReady });
    expect(harness.root.replaceChildren).toHaveBeenCalledExactlyOnceWith(harness.frame);
    expect(harness.attributes).toEqual(new Map([
      ["title", "MCP App content"],
      ["sandbox", "allow-scripts"],
      ["allow", "clipboard-write"],
    ]));
    expect(harness.frame.srcdoc).toBe(securedHtml);
    expect(harness.frame.referrerPolicy).toBe("no-referrer");
    expect([...harness.attributes.values()]).not.toContain("allow-same-origin");

    const appRpc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "refresh" } };
    harness.dispatch({ source: harness.unrelatedWindow, origin: "null", data: appRpc });
    harness.dispatch({ source: harness.innerWindow, origin: hostOrigin, data: appRpc });
    harness.dispatch({
      source: harness.innerWindow,
      origin: "null",
      data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" },
    });
    expect(harness.parentWindow.postMessage).not.toHaveBeenCalled();

    harness.dispatch({ source: harness.innerWindow, origin: "null", data: appRpc });
    expect(harness.parentWindow.postMessage).toHaveBeenCalledExactlyOnceWith(appRpc, hostOrigin);

    const hostRpc = { jsonrpc: "2.0", id: 8, method: "ui/notifications/tool-input", params: {} };
    harness.dispatch({ source: harness.parentWindow, origin: hostOrigin, data: hostRpc });
    expect(harness.innerWindow.postMessage).toHaveBeenCalledExactlyOnceWith(hostRpc, "*");

    harness.load();
    expect(harness.frame.remove).not.toHaveBeenCalled();
    harness.load();
    expect(harness.frame.remove).toHaveBeenCalledOnce();
    expect(harness.root.textContent).toBe("App navigation was blocked.");
  });
});
