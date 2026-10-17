import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "../session-store.js";
import { createRunDriver } from "../run-driver.js";

// No Core mock: these contracts belong to the installed loop, not a replacement.
const require = createRequire(import.meta.url);
const tool = (name: any, execute: any) => ({ name, description: "Fictional effect", parameters: { type: "object", properties: {} }, execute });
const result = (text: any) => ({ content: [{ type: "text", text }] });
function gate() {
  let enter: any, release: any;
  const entered = new Promise((resolve: any) => { enter = resolve; });
  const pending = new Promise((resolve: any) => { release = resolve; });
  return { entered, release, async wait() { enter(); await pending; } };
}
const yieldRound = () => new Promise((resolve: any) => setImmediate(resolve));
async function journal(raw: any) {
  return (await readFile(raw.metadata.path, "utf8")).trim().split("\n").map((line: any) => JSON.parse(line));
}
async function fixture(tools: any, responses: any, beforeDispatch: (...args: any[]) => any = () => {}) {
  expect(require("@earendil-works/pi-agent-core/package.json").version).toBe("1.2.0");
  const root = await mkdtemp(join(tmpdir(), "loop-contract-"));
  const raw: any = await new JsonlSessionRepo({ sessionsRoot: root }).create();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "fictional-loop" }] });
  const models: any = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
  const stream = models.streamSimple.bind(models);
  let requests = 0;
  models.streamSimple = async (...args: any[]) => {
    await beforeDispatch(++requests, args[1]);
    return stream(...args);
  };
  const driver: any = createRunDriver(raw, { models, model: faux.getModel(), tools,
    systemPrompt: "Fictional contract test.", thinkingLevel: "off", toolExecution: "parallel", retry: { enabled: false } });
  return { raw, driver, async close() { await driver.close(); await raw.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("installed Pi 1.2.0 loop contract through the run driver", () => {
  it.each(["admitted", "started"])("awaits beforeToolCall and the %s fsync before exactly one successful effect", async (phase: any) => {
    const hook = gate(), fsync = gate();
    let effects = 0, executionRecords: any;
    const syncedAdmissions = new Set();
    const { raw, driver, close } = await fixture([tool("Effect", async () => {
      effects += 1;
      expect([...syncedAdmissions]).toEqual(["admitted", "started"]);
      // Independent file read, not the driver's in-memory validator or record cache.
      executionRecords = await journal(raw);
      return result("Fictional effect completed.");
    })], [fauxAssistantMessage([fauxToolCall("Effect", {}, { id: "effect" })]), fauxAssistantMessage([fauxText("done")])]);
    driver.hooks.on("before_tool", () => hook.wait());
    // Reuse the raw.io sync seam from harness-run-driver.test.js:180-214,
    // retaining the real append/read/fsync implementation of this durable store.
    const sync = raw.io.sync.bind(raw.io);
    raw.io.sync = async () => {
      const record = (await journal(raw)).at(-1);
      if (record.kind === "tool_call" && record.payload.admission === phase) await fsync.wait();
      await sync();
      if (record.kind === "tool_call" && ["admitted", "started"].includes(record.payload.admission)) syncedAdmissions.add(record.payload.admission);
    };
    let pending: any;
    try {
      pending = driver.prompt("Fictional tool request.");
      await hook.entered; await yieldRound();
      expect(effects).toBe(0);
      hook.release();
      await Promise.race([fsync.entered, pending.then(() => { throw new Error("Loop finished before admission fsync"); })]);
      await yieldRound(); expect(effects).toBe(0);
      fsync.release();
      expect((await pending).status).toBe("completed");
      // Zero effects alone would also pass if Core stopped awaiting beforeToolCall.
      expect(effects).toBe(1);
      expect(executionRecords.filter((record: any) => record.kind === "tool_call" && record.payload.callId === "effect")
        .map((record: any) => record.payload.admission)).toEqual(["observed", "admitted", "started"]);
      const returned = (await raw.getEntries()).find((entry: any) => entry.message?.role === "toolResult").message;
      expect(returned).toMatchObject({ toolCallId: "effect", isError: false, ...result("Fictional effect completed.") });
    } finally {
      hook.release(); fsync.release();
      await pending?.catch(() => {}); await close();
    }
  });

  it("places steering and each parallel tool result before dispatch, with per-call start → update → end", async () => {
    const gates = [gate(), gate()];
    const events: any = [];
    const ids = ["one", "two"];
    const steering = "Fictional steering during the tool round.";
    const tools = ids.map((id: any, index: any) => tool(id, async (_callId: any, _args: any, _signal: any, onUpdate: any) => {
      await onUpdate(result(`Fictional ${id} progress.`));
      await gates[index]!.wait();
      return result(`Fictional ${id} outcome.`);
    }));
    const assertOrder = () => {
      for (const id of ids) {
        const perCall = events.filter((event: any) => event.toolCallId === id && event.type.startsWith("tool_execution_"));
        expect(perCall.map((event: any) => event.type)).toEqual(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);
        expect(perCall.at(-1).isError).toBe(false);
        const end = events.indexOf(perCall.at(-1));
        const placed = events.findIndex((event: any) => event.type === "message_end" && event.message.role === "toolResult" && event.message.toolCallId === id);
        expect(placed).toBeGreaterThan(end);
      }
    };
    let nextRequest: any;
    const { driver, raw, close } = await fixture(tools, [
      fauxAssistantMessage(ids.map((id: any) => fauxToolCall(id, {}, { id }))), fauxAssistantMessage([fauxText("done")]),
    ], async (request: any, context: any) => {
      if (request !== 2) return;
      nextRequest = structuredClone(context);
      // Inspect at streamSimple entry, before the provider is dispatched.
      assertOrder();
      expect(context.messages.filter((message: any) => message.role === "toolResult").map((message: any) => message.toolCallId).sort()).toEqual(ids);
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: steering }] });
      const persisted = await journal(raw);
      for (const id of ids) expect(persisted.some((record: any) => record.kind === "tool_result" && record.payload.callId === id && record.payload.messageId)).toBe(true);
    });
    driver.subscribe((event: any) => events.push(event));
    let pending: any;
    try {
      pending = driver.prompt("Fictional parallel tool request.");
      await Promise.race([Promise.all(gates.map((item: any) => item.entered)),
        pending.then(() => { throw new Error("Loop finished before parallel tool execution"); })]);
      await driver.steer(steering);
      // Deliberately finish the second tool first; impose no cross-tool order.
      gates[1]!.release(); await yieldRound(); gates[0]!.release();
      expect((await pending).status).toBe("completed");
      expect(nextRequest).toBeDefined(); assertOrder();
      expect(events.filter((event: any) => event.type === "message_end" && event.message.role === "toolResult")).toHaveLength(2);
    } finally {
      for (const item of gates) item.release();
      await pending?.catch(() => {}); await close();
    }
  });
});
