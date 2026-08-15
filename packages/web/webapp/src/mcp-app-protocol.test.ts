import {
  AppBridge,
  SUPPORTED_PROTOCOL_VERSIONS as EXT_APPS_SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { describe, expect, it, vi } from "vitest";

import {
  MCP_APP_PROTOCOL_VERSIONS,
  enableMcpAppProtocolCompatibility,
} from "./mcp-app-protocol";

interface TestTransport {
  onmessage?: (message: unknown) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
}

const initializeBridge = async (protocolVersion: string): Promise<Record<string, unknown>> => {
  const sent: unknown[] = [];
  const transport: TestTransport = {
    start: vi.fn(async () => {}),
    send: vi.fn(async (message) => { sent.push(message); }),
    close: vi.fn(async () => {}),
  };
  const bridge = new AppBridge(
    null,
    { name: "mono-agent protocol test", version: "1.0.0" },
    { serverTools: {}, serverResources: {} },
  );
  try {
    await bridge.connect(transport as never);
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        appInfo: { name: "test app", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion,
      },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    return sent[0] as Record<string, unknown>;
  } finally {
    await bridge.close();
  }
};

describe("MCP App protocol compatibility", () => {
  it("extends the ext-apps bridge with the two reviewed revisions idempotently", () => {
    enableMcpAppProtocolCompatibility();
    enableMcpAppProtocolCompatibility();
    for (const version of MCP_APP_PROTOCOL_VERSIONS) {
      expect(EXT_APPS_SUPPORTED_PROTOCOL_VERSIONS.filter((candidate) => candidate === version)).toHaveLength(1);
    }
  });

  it.each(MCP_APP_PROTOCOL_VERSIONS)("negotiates %s through the real AppBridge initialize handler", async (version) => {
    const response = await initializeBridge(version);
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: version },
    });
  });
});
