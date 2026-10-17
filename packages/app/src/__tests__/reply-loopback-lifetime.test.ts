import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const endpoint = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../mcp/loopback-transport.js", () => ({ createLoopbackMcpEndpoint: endpoint.create }));
import { createReplyArtifactService, REPLY_ARTIFACT_MCP_SERVER_NAME } from "../artifacts/reply-artifacts.js";

describe("reply publication endpoint policy", () => {
  it("throws startup failure instead of silently omitting publication", async () => {
    const root = await mkdtemp(join(process.cwd(), "node_modules/reply-lifetime-"));
    try {
      const error = new Error("loopback unavailable");
      endpoint.create.mockRejectedValueOnce(error);
      const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace: root });
      await expect(service.createExtension({ runId: "failed-start", request: { conversationId: "thread" }, context: {} } as never)).rejects.toBe(error);
      expect(endpoint.create).toHaveBeenLastCalledWith(expect.objectContaining({
        startingResponse: { status: 404, message: "Not found" },
        bodyLimitMessage: "Reply artifact MCP request exceeds 1 MB.",
        unavailableTransportMessage: "Reply artifact MCP transport is unavailable.",
      }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains hidden capability URL and separate endpoint/settlement cleanup", async () => {
    const root = await mkdtemp(join(process.cwd(), "node_modules/reply-lifetime-"));
    try {
      const url = "http://127.0.0.1:1234/mcp/fictional-capability";
      const close = vi.fn(async () => {});
      endpoint.create.mockResolvedValueOnce({ url, close });
      const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace: root });
      const extension = await service.createExtension({ runId: "publication", request: { conversationId: "thread" }, context: {} } as never);
      const servers = extension.runtimeOptions?.mcpServers as Record<string, { url: string }>;
      const spec = servers[REPLY_ARTIFACT_MCP_SERVER_NAME]!;
      expect(spec.url).toBe(url);
      expect(Object.getOwnPropertyDescriptor(spec, "url")?.enumerable).toBe(false);
      expect(JSON.stringify(spec)).not.toContain(url);
      expect(extension.settleCleanup).toBeTypeOf("function");
      await extension.cleanup?.();
      expect(close).toHaveBeenCalledOnce();
      await extension.settleCleanup?.();
      expect(close).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
