import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Socket } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { productionModules } from "../lib/continuity-runner.mjs";
import { guardedLookupModels, createTestOnlyLookupPermitSource, LOOKUP_GUARD_CONTRACT as C } from "../lib/continuity-lookup-guard.mjs";

it("runs the real host turn with decorator, guarded installed Codex SSE, and a real tool across two rounds", async () => {
  const network = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw Error("test_egress_denied"); });
  const globalFetch = vi.fn(() => { throw Error("test_global_fetch_denied"); }); vi.stubGlobal("fetch", globalFetch);
  vi.stubGlobal("WebSocket", class { constructor() { throw Error("test_websocket_denied"); } });
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const temp = join(root, ".worklab-tmp"); await mkdir(temp, { recursive: true });
  const work = await mkdtemp(join(temp, "lookup-turn-"));
  try {
    await writeFile(join(work, "fictional.txt"), "Fictional tool evidence.");
    const modules = await productionModules(root);
    const encode = x => Buffer.from(JSON.stringify(x)).toString("base64url");
    const access = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "FAKE-TEST-ACCOUNT-NOT-REAL" } })}.FAKE-TEST-SIGNATURE`;
    const credential = { type: "oauth", access, refresh: "FAKE-TEST-REFRESH-NOT-REAL", expires: Date.now() + 3600000 };
    const resolver = Object.assign(async () => access, { readCredential: async () => credential,
      modifyCredential: async () => { throw Error("test_refresh_denied"); } });
    const permit = createTestOnlyLookupPermitSource(); let rounds = 0, sawToolResult = false;
    const send = vi.fn(async (url, init) => {
      expect(String(url)).toBe(`${C.baseUrl}/codex/responses`); rounds++;
      const bytes = new Headers(init.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(init.body) : Buffer.from(init.body);
      const body = JSON.parse(bytes.toString("utf8"));
      let output;
      if (rounds === 1) {
        const tool = body.tools.find(t => t.name.toLowerCase() === "read"); expect(tool).toBeTruthy();
        output = { type: "function_call", id: "fc_fictional", call_id: "call_fictional", name: tool.name,
          arguments: JSON.stringify({ file_path: join(work, "fictional.txt") }), status: "completed" };
      } else {
        expect(rounds).toBe(2);
        const result = body.input.find(item => item.type === "function_call_output");
        expect(result?.output).toContain("Fictional tool evidence."); sawToolResult = true;
        output = { type: "message", id: "msg_fictional", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Fictional final answer.", annotations: [] }] };
      }
      const added = output.type === "message" ? { ...output, content: [] } : { ...output, arguments: "" };
      const events = [{ type: "response.output_item.added", output_index: 0, item: added },
        ...(output.type === "message" ? [{ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: output.id, part: { type: "output_text", text: "", annotations: [] } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: output.id, delta: "Fictional final answer." }] : []),
        { type: "response.output_item.done", output_index: 0, item: output },
        { type: "response.completed", response: { id: `fictional-response-${rounds}`, status: "completed", output: [output], service_tier: "priority", usage: { input_tokens: 10, output_tokens: 5 } } }];
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const decorator = vi.fn(models => guardedLookupModels(models, { contract: { ...C, runId: "fictional-turn", slotId: "fictional-slot" }, permit, send }));
    // Same public host entry used by continuity-runner's controlled runtime.
    const runtime = modules.host.createMonoRuntime({ workspace: work, resolvePiApiKey: resolver });
    const result = await runtime.run("Fictional instructions.", { model: modules.host.parseMonoRuntimeModelReference(`${C.provider}:${C.model}`),
      cwd: work, messages: [{ role: "user", content: "Read fictional.txt, then answer." }], allowedTools: ["Read"],
      effort: "high", piTransport: "sse", piMaxRetries: 0, compaction: { enabled: false }, piModelsDecorator: decorator });
    expect(result.error).toBeNull(); expect(result.text).toBe("Fictional final answer.");
    expect(decorator).toHaveBeenCalledOnce(); expect(rounds).toBe(2); expect(sawToolResult).toBe(true);
    expect(permit.events.filter(e => e.type === "consume")).toHaveLength(2);
    expect(permit.events.filter(e => e.type === "settle").map(e => e.outcome.kind)).toEqual(["settled", "settled"]);
    expect(network).not.toHaveBeenCalled(); expect(globalFetch).not.toHaveBeenCalled();
  } finally { await rm(work, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
}, 30000);
