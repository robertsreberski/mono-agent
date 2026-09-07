import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCompositeRunRecorder, createJsonlRunRecorder } from "@mono-agent/observability";
import { describe, expect, it } from "vitest";

import { createPhoenixRunExporter } from "../index.js";

// Real local HTTP and filesystem boundaries: no hosted collector or provider calls.
describe("optional Phoenix and local recorder integration", () => {
  it.each([200, 503])("keeps completed local artifacts when the collector returns %s", async (responseStatus) => {
    const artifactDir = await mkdtemp(join(tmpdir(), "mono-agent-phoenix-export-"));
    const requests: Array<{ contentType: string | undefined; body: Buffer }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      requests.push({ contentType: request.headers["content-type"], body: Buffer.concat(chunks) });
      response.writeHead(responseStatus).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
      const warnings: Array<{ phase: string; message: string }> = [];
      const recorder = createCompositeRunRecorder({
        recorder: createJsonlRunRecorder({ runId: "integration", conversationId: "test", artifactDir }),
        exporter: createPhoenixRunExporter({
          type: "phoenix", endpoint: `http://127.0.0.1:${address.port}/v1/traces`, timeoutMs: 2_000,
        }),
        context: { runId: "integration", conversationId: "test", includeSensitiveData: false },
        timeoutMs: 2_000,
        onWarning: (warning) => { warnings.push(warning); },
      });
      await recorder.start?.();
      recorder.onEvent({ type: "assistant", text: "local integration response" });
      const summary = await recorder.finish({ model: "test:model" });
      expect(summary.status).toBe("succeeded");
      const saved = JSON.parse(await readFile(join(artifactDir, "integration.summary.json"), "utf8"));
      expect(saved.status).toBe("succeeded");
      expect(await readFile(join(artifactDir, "integration.events.jsonl"), "utf8"))
        .toContain("local integration response");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.contentType).toBe("application/x-protobuf");
      expect(requests[0]?.body.byteLength).toBeGreaterThan(0);
      expect(warnings).toHaveLength(responseStatus === 200 ? 0 : 1);
      if (responseStatus === 503) expect(warnings[0]?.message).toContain("responded 503");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await rm(artifactDir, { recursive: true, force: true });
    }
  });
});
