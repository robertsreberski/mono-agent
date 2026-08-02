import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  connectWithSafeAcpSdkDiagnostics,
  createBoundedAcpStdioStream,
} from "../../ai/providers/acp-transport.js";

function createTransport() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return {
    stdin,
    stdout,
    ...createBoundedAcpStdioStream({ stdin, stdout }),
  };
}

describe("bounded ACP stdio transport", () => {
  it("drops SDK payload arguments only within the connection async context", async () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const errors = [];
    const warnings = [];
    console.error = (...args) => errors.push(args);
    console.warn = (...args) => warnings.push(args);

    let closeConnection;
    let scopedDiagnostics;
    const closed = new Promise((resolve) => { closeConnection = resolve; });
    try {
      connectWithSafeAcpSdkDiagnostics(() => {
        scopedDiagnostics = new Promise((resolve) => {
          queueMicrotask(() => {
            console.error("Error handling notification", { secret: "private-form-value" });
            console.warn("Skipping JSON line that is not an object:", "private-url-value");
            resolve();
          });
        });
        return { closed };
      });

      await scopedDiagnostics;
      console.error("Error handling notification", { outside: "unchanged" });
      console.warn("Skipping JSON line that is not an object:", "outside-unchanged");

      expect(errors).toEqual([
        ["Error handling notification"],
        ["Error handling notification", { outside: "unchanged" }],
      ]);
      expect(warnings).toEqual([
        ["Skipping JSON line that is not an object:"],
        ["Skipping JSON line that is not an object:", "outside-unchanged"],
      ]);
    } finally {
      closeConnection();
      await closed;
      await Promise.resolve();
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it("destroys child stdin on abort without emitting the Web Stream reason as a Node error", async () => {
    const transport = createTransport();
    const errors = [];
    transport.stdin.on("error", (error) => errors.push(error));

    await transport.writable.abort(new Error("cancelled"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.stdin.destroyed).toBe(true);
    expect(errors).toEqual([]);
    transport.stdout.destroy();
  });

  it("pauses child stdout instead of enqueueing a burst beyond Web Stream demand", async () => {
    const transport = createTransport();
    const messages = Array.from({ length: 1_000 }, (_, id) => ({
      jsonrpc: "2.0",
      method: "session/update",
      params: { id },
    }));
    const reader = transport.readable.getReader();

    transport.stdout.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.stdout.isPaused()).toBe(true);
    for (const message of messages) {
      await expect(reader.read()).resolves.toEqual({ done: false, value: message });
    }
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    transport.stdin.destroy();
  });

  it("accepts valid JSON-RPC requests, notifications, success responses, and error responses", async () => {
    const transport = createTransport();
    const messages = [
      { jsonrpc: "2.0", method: "session/update", params: { value: true } },
      { jsonrpc: "2.0", method: "session/get", id: null, params: [] },
      { jsonrpc: "2.0", id: "request-1", result: null },
      { jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Invalid request", data: null } },
    ];
    const reader = transport.readable.getReader();

    transport.stdout.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);

    for (const message of messages) {
      await expect(reader.read()).resolves.toEqual({ done: false, value: message });
    }
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    transport.stdin.destroy();
  });

  it.each([
    ["an invalid request id", { jsonrpc: "2.0", method: "session/get", id: true }],
    ["scalar request params", { jsonrpc: "2.0", method: "session/get", params: "invalid" }],
    ["a result on a request", { jsonrpc: "2.0", method: "session/get", id: 1, result: {} }],
    ["an error on a notification", { jsonrpc: "2.0", method: "session/update", error: {} }],
    ["an invalid response id", { jsonrpc: "2.0", id: {}, result: true }],
    ["response params", { jsonrpc: "2.0", id: 1, params: {}, result: true }],
    ["both response result and error", {
      jsonrpc: "2.0",
      id: 1,
      result: true,
      error: { code: -32603, message: "Internal error" },
    }],
    ["neither response result nor error", { jsonrpc: "2.0", id: 1 }],
    ["a scalar response error", { jsonrpc: "2.0", id: 1, error: "invalid" }],
    ["a non-integer response error code", {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600.5, message: "Invalid request" },
    }],
    ["a non-string response error message", {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: 7 },
    }],
  ])("rejects %s before enqueueing it", async (_label, message) => {
    const transport = createTransport();
    const reader = transport.readable.getReader();

    transport.stdout.end(`${JSON.stringify(message)}\n`);

    await expect(reader.read()).rejects.toMatchObject({ code: "invalid_jsonrpc" });
    transport.stdin.destroy();
    transport.stdout.destroy();
  });
});
