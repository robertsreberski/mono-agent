import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it, vi } from "vitest";

const { adapterSendToolsMcpServerSpec } = await import("../../dist/delivery/send-tools/host-extension.js");

it("runs the compiled adapter child over stdio and cancels its bridge ask independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adapter-child-fixture-"));
  const configPath = join(directory, "mono-agent.config.json");
  await writeFile(configPath, "{}\n");
  const requests: Array<{ method: string | undefined; authorization: string | undefined }> = [];
  let created = 0;
  let blockedPoll = false;
  let deleted = false;
  const bridge = createServer((request, response) => {
    requests.push({ method: request.method, authorization: request.headers.authorization });
    request.resume();
    request.on("end", () => {
      if (request.method === "POST") {
        created += 1;
        response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ interactionId: String(created) }));
      } else if (request.method === "DELETE") {
        deleted = true;
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      } else if (request.url?.includes("/1?")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          status: "answered", questions: [{ id: "q", header: "Fixture", options: [{ id: "a", label: "First" }] }],
          answers: [{ questionId: "q", selectedOptionIds: ["a"] }],
        }));
      } else {
        blockedPoll = true;
        // Deliberately leave the long poll pending until MCP cancellation closes it.
      }
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address();
  if (address === null || typeof address === "string") throw new Error("Fictional bridge did not bind.");
  const spec = adapterSendToolsMcpServerSpec(configPath, directory, ["AskUser"], {
    conversationId: "web:fixture", interactionConversationId: "web:fixture", runId: "fixture-run",
  }, { bridgeUrl: `http://127.0.0.1:${address.port}`, bridgeToken: "fictional-bridge-token", timeoutMs: null });
  const expectedChild = fileURLToPath(new URL("../../dist/delivery/send-tools/adapter-send-tools-main.js", import.meta.url));
  const transport = new StdioClientTransport({ command: spec.command as string, args: spec.args as string[],
    cwd: spec.cwd as string, env: spec.env as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "compiled-adapter-fixture", version: "1.0.0" });
  const args = { questions: [{ header: "Fixture", question: "Choose a fictional option.", options: [
    { label: "First", description: "First fictional choice." }, { label: "Second", description: "Second fictional choice." },
  ] }] };
  try {
    expect(spec.args).toEqual(["--use-bundled-ca", expectedChild]);
    expect(Object.getOwnPropertyDescriptor(spec, Symbol.for("@mono-agent/app-owned-local-binding")))
      .toMatchObject({ value: true, enumerable: false });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["AskUser"]);
    const answer = await client.callTool({ name: "AskUser", arguments: args });
    expect(answer.structuredContent).toMatchObject({ ok: true, answered: true, interactionId: "1" });
    const controller = new AbortController();
    const pending = client.callTool({ name: "AskUser", arguments: args }, undefined, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(blockedPoll).toBe(true), { timeout: 5_000 });
    controller.abort(new Error("Fictional cancellation."));
    await rejected;
    await vi.waitFor(() => expect(deleted).toBe(true), { timeout: 5_000 });
    expect(requests.every((request) => request.authorization === "Bearer fictional-bridge-token")).toBe(true);
  } finally {
    await client.close();
    await transport.close();
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
