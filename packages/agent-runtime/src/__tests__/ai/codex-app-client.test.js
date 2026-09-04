import { describe, expect, it, vi } from "vitest";

import { createCodexAppServerClient } from "../../ai/providers/codex/app-server-client.js";

describe("Codex app-server client", () => {
  it("settles a spawn failure even when no child close event follows", async () => {
    const client = createCodexAppServerClient({
      command: "mono-agent-codex-app-server-command-does-not-exist",
    });

    const error = await client.closed;

    expect(error).toMatchObject({ code: "ENOENT" });
    await expect(client.request("probe", {})).rejects.toThrow("codex app-server is not running");
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("rejects a silent request with the typed app-server timeout", async () => {
    const childSource = `
      const readline = require("node:readline");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
      readline.createInterface({ input: process.stdin });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      shutdownGraceMs: 25,
      killGraceMs: 500,
    });
    try {
      const error = await client.request("silent/probe", {}, { timeoutMs: 50 }).then(
        () => null,
        (reason) => reason,
      );

      expect(error).toMatchObject({
        code: "CODEX_APP_SERVER_REQUEST_TIMEOUT",
        method: "silent/probe",
        timeoutMs: 50,
      });
      expect(error.message).toBe("codex app-server request timed out: silent/probe");
    } finally {
      await client.close();
    }
  });

  it("writes a JSON-RPC response for inbound app-server requests", async () => {
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      let originalId;
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 9001 && (message.result !== undefined || message.error !== undefined)) {
          send({ id: originalId, result: { serverResult: message.result, serverError: message.error } });
          return;
        }
        originalId = message.id;
        send({ id: 9001, method: "item/commandExecution/requestApproval", params: {} });
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      onServerRequest: () => ({ action: "accept", content: {}, _meta: null }),
    });
    try {
      await expect(client.request("probe", {})).resolves.toEqual({
        serverResult: { action: "accept", content: {}, _meta: null },
      });
    } finally {
      await client.close();
    }
  });

  it("rejects an unsupported inbound server request instead of hanging the peer", async () => {
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      let originalId;
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 9001 && (message.result !== undefined || message.error !== undefined)) {
          send({ id: originalId, result: { serverResult: message.result, serverError: message.error } });
          return;
        }
        originalId = message.id;
        send({ id: 9001, method: "item/commandExecution/requestApproval", params: {} });
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
    });
    try {
      await expect(client.request("probe", {})).resolves.toEqual({
        serverError: {
          code: -32601,
          message: "Unsupported Codex app-server request: item/commandExecution/requestApproval",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("bounds and redacts JSON-RPC errors including the retained responseError", async () => {
    const secret = "fixture-rpc-sensitive-value-1234567890";
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          id: message.id,
          error: {
            code: -32000,
            message: "RPC rejected credential " + process.env.MCP_OPAQUE,
            data: { echo: process.env.MCP_OPAQUE, detail: "x".repeat(32 * 1024) },
          },
        }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      env: { MCP_OPAQUE: secret },
      // The server echoes only the payload, not the complete configured header.
      redactionValues: [`Bearer ${secret}`],
    });
    try {
      const error = await client.request("probe", {}).then(
        () => null,
        (reason) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("RPC rejected credential [REDACTED]");
      expect(error.message).not.toContain(secret);
      expect(error.responseError).toMatchObject({ code: -32000, diagnostic_truncated: true });
      expect(JSON.stringify(error.responseError)).not.toContain(secret);
      expect(Buffer.byteLength(JSON.stringify(error.responseError))).toBeLessThanOrEqual(8 * 1024);
    } finally {
      await client.close();
    }
  });

  it("redacts unknown values under sensitive JSON-RPC payload field names", async () => {
    const fieldSecret = "fixture-field-only-sensitive-value-1234567890";
    const privateKeySecret = "fixture-private-key-sensitive-value-0987654321";
    const apiKeySecret = "fixture-apikey-sensitive-value-1029384756";
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          id: message.id,
          error: {
            code: -32001,
            message: "RPC field validation failed",
            data: {
              nested: {
                accessToken: ${JSON.stringify(fieldSecret)},
                privateKey: ${JSON.stringify(privateKeySecret)},
                APIKEY: ${JSON.stringify(apiKeySecret)},
              },
            },
          },
        }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({ command: process.execPath, args: ["-e", childSource] });
    try {
      const error = await client.request("probe", {}).then(
        () => null,
        (reason) => reason,
      );
      expect(error.message).toBe("RPC field validation failed");
      expect(JSON.stringify(error.responseError)).not.toContain(fieldSecret);
      expect(JSON.stringify(error.responseError)).not.toContain(privateKeySecret);
      expect(JSON.stringify(error.responseError)).not.toContain(apiKeySecret);
      expect(error.responseError.data.nested.accessToken).toBe("[REDACTED]");
      expect(error.responseError.data.nested.privateKey).toBe("[REDACTED]");
      expect(error.responseError.data.nested.APIKEY).toBe("[REDACTED]");
    } finally {
      await client.close();
    }
  });

  it("bounds and redacts malformed app-server stdout before warning delivery", async () => {
    const secret = "fixture-stdout-sensitive-value-1234567890";
    const segmentedEnvSecret = "fixture-segmented-env-sensitive-value-1234567890";
    const compactApiKeySecret = "fixture-compact-apikey-sensitive-value-1234567890";
    const rawPrivateKeySecret = "fixture-raw-private-key-value-1234567890";
    const notifications = [];
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(
          "not-json " + process.env.MCP_OPAQUE +
          " " + process.env.MY_SECRET_VALUE +
          " " + process.env.OPENAI_APIKEY +
          " privateKey=${rawPrivateKeySecret} " + "x".repeat(32 * 1024) + "\\n"
        );
        process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      env: {
        MCP_OPAQUE: secret,
        MY_SECRET_VALUE: segmentedEnvSecret,
        OPENAI_APIKEY: compactApiKeySecret,
      },
      redactionValues: [secret],
      onNotification: (notification) => notifications.push(notification),
    });
    try {
      await expect(client.request("probe", {})).resolves.toEqual({ ok: true });
      expect(notifications).toHaveLength(1);
      const message = notifications[0].params.message;
      expect(message).toContain("Malformed Codex app-server output: not-json [REDACTED]");
      expect(message).toContain("[truncated");
      expect(message).not.toContain(secret);
      expect(message).not.toContain(segmentedEnvSecret);
      expect(message).not.toContain(compactApiKeySecret);
      expect(message).not.toContain(rawPrivateKeySecret);
      expect(message).toContain("privateKey=[REDACTED]");
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(8 * 1024);
    } finally {
      await client.close();
    }
  });

  it("warns instead of crashing the host when the app-server emits non-object JSON lines", async () => {
    const notifications = [];
    // `null` is the dangerous one: it parses cleanly, so it reaches the frame
    // dispatch, where a prototype lookup on it throws inside readline's `line`
    // listener and would take the host process down. Scalars and arrays are
    // parseable-but-invalid frames for the same reason.
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write("null\\n");
        process.stdout.write("42\\n");
        process.stdout.write('"bare-string"\\n');
        process.stdout.write("[]\\n");
        process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      onNotification: (notification) => notifications.push(notification),
    });
    try {
      await expect(client.request("probe", {})).resolves.toEqual({ ok: true });
      expect(notifications.map((notification) => notification.params.message)).toEqual([
        "Malformed Codex app-server output: null",
        "Malformed Codex app-server output: 42",
        'Malformed Codex app-server output: "bare-string"',
        "Malformed Codex app-server output: []",
      ]);
    } finally {
      await client.close();
    }
  });

  it("bounds and redacts app-server stderr before it reaches errors", async () => {
    const secret = "fixture-sensitive-value-1234567890";
    const basicCredential = Buffer.from(["fixture-user", "fixture-password"].join(":"), "utf8").toString("base64");
    const plainJsonCredential = "remaining-plain-json-secret-24680";
    const escapedJsonCredential = "remaining-escaped-json-secret-13579";
    const plainJson = `{"token":"prefix\\"${plainJsonCredential}"}`;
    const escapedJson = `{"token":"prefix\\"${escapedJsonCredential}"}`
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    const boundarySuffix = secret.slice(-12);
    const diagnosticSuffix =
      `\nOPENAI_API_KEY=${secret}\n` +
      `Authorization: Basic ${basicCredential}\n` +
      `${plainJson}\n` +
      `${escapedJson}\n`;
    const paddingBytes = (8 * 1024) - Buffer.byteLength(boundarySuffix) - Buffer.byteLength(diagnosticSuffix);
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", () => {
        process.stderr.write("x".repeat(64 * 1024));
        process.stderr.write(process.env.OPENAI_API_KEY);
        process.stderr.write("z".repeat(${paddingBytes}));
        process.stderr.write(${JSON.stringify(diagnosticSuffix)}, () => process.exit(7));
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      env: { OPENAI_API_KEY: secret },
      shutdownGraceMs: 25,
      killGraceMs: 250,
    });
    try {
      const error = await client.request("probe", {}).then(
        () => null,
        (reason) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(boundarySuffix);
      expect(error.message).not.toContain(basicCredential);
      expect(error.message).not.toContain(plainJsonCredential);
      expect(error.message).not.toContain(escapedJsonCredential);
      expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual((8 * 1024) + 128);

      const closedError = await client.closed;
      expect(closedError.message).not.toContain(secret);
      expect(Buffer.byteLength(closedError.message)).toBeLessThanOrEqual((8 * 1024) + 128);
    } finally {
      await client.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "escalates to SIGKILL and fully settles one idempotent close promise",
    async () => {
      const childSource = `
        const readline = require("node:readline");
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1_000);
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const message = JSON.parse(line);
          process.stdout.write(JSON.stringify({ id: message.id, result: { ready: true } }) + "\\n");
        });
      `;
      const client = createCodexAppServerClient({
        command: process.execPath,
        args: ["-e", childSource],
        shutdownGraceMs: 25,
        killGraceMs: 500,
      });
      const pid = client.child.pid;
      if (typeof pid !== "number") throw new Error("fixture child did not start");
      try {
        await expect(client.request("ready", {})).resolves.toEqual({ ready: true });
        const firstClose = client.close();
        const secondClose = client.close();
        expect(secondClose).toBe(firstClose);
        await firstClose;

        expect(client.child.signalCode).toBe("SIGKILL");
        expect(client.child.listenerCount("error")).toBe(0);
        expect(client.child.listenerCount("close")).toBe(0);
        expect(client.child.stderr.listenerCount("data")).toBe(0);
        expect(() => process.kill(pid, 0)).toThrow();
        await expect(client.closed).resolves.toMatchObject({ message: "codex app-server closed" });
      } finally {
        await client.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not treat a failed SIGTERM as process exit",
    async () => {
      const childSource = `
        const readline = require("node:readline");
        setInterval(() => {}, 1_000);
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const message = JSON.parse(line);
          process.stdout.write(JSON.stringify({ id: message.id, result: { ready: true } }) + "\\n");
        });
      `;
      const client = createCodexAppServerClient({
        command: process.execPath,
        args: ["-e", childSource],
        shutdownGraceMs: 25,
        killGraceMs: 500,
      });
      const originalKill = client.child.kill.bind(client.child);
      const signals = [];
      client.child.kill = vi.fn((signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") {
          queueMicrotask(() => client.child.emit(
            "error",
            Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
          ));
          return false;
        }
        return originalKill(signal);
      });
      try {
        await expect(client.request("ready", {})).resolves.toEqual({ ready: true });
        await client.close();

        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(client.child.signalCode).toBe("SIGKILL");
        expect(client.child.listenerCount("error")).toBe(0);
      } finally {
        await client.close();
      }
    },
  );
});
