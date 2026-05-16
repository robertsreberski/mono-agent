import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJsonlRunRecorder, registerTraceSource } from "@worklab-ai/observability";
import { defineFieldGroup } from "@worklab-ai/settings";
import type { FieldGroup } from "@worklab-ai/settings";

import { startOperatorConsole } from "./start.js";

const TEST_FIELD_GROUPS: readonly FieldGroup[] = [
  defineFieldGroup({
    id: "runtime",
    label: "Runtime",
    fields: [
      { id: "runtime.maxTurns", label: "Max turns", kind: "integer", min: 1, max: 100, path: ["runtime", "maxTurns"] },
    ],
  }),
  defineFieldGroup({
    id: "telegram",
    label: "Telegram",
    fields: [
      { id: "telegram.botToken", label: "Bot token", kind: "secret", path: ["telegram", "botToken"] },
      { id: "telegram.allowedChatIds", label: "Allowed chat ids", kind: "csv", path: ["telegram", "allowedChatIds"] },
    ],
  }),
];

function startTestConsole(
  options: Omit<Parameters<typeof startOperatorConsole>[0], "fieldGroups"> & {
    readonly fieldGroups?: readonly FieldGroup[];
  },
): ReturnType<typeof startOperatorConsole> {
  return startOperatorConsole({
    fieldGroups: TEST_FIELD_GROUPS,
    ...options,
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-console-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startOperatorConsole", () => {
  it("refuses non-loopback hosts", async () => {
    await expect(
      startTestConsole({
        configPath: join(dir, "config.json"),
        cwd: dir,
        host: "0.0.0.0",
      }),
    ).rejects.toThrow(/non-loopback/u);
  });

  it("serves the SPA shell with the runtime token injected", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const response = await fetch(bridge.url);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("window.__OPERATOR_CONSOLE__");
      expect(html).toContain("\"token\":\"test-token\"");
      expect(html).toContain("\"fieldGroupIds\":[");
    } finally {
      await bridge.stop();
    }
  });

  it("returns 401 for /api/config without the bearer", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const response = await fetch(`${bridge.url}/api/config`);
      expect(response.status).toBe(401);
    } finally {
      await bridge.stop();
    }
  });

  it("returns 401 for /api/config with the wrong bearer", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const response = await fetch(`${bridge.url}/api/config`, {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(response.status).toBe(401);
    } finally {
      await bridge.stop();
    }
  });

  it("returns the redacted config on GET /api/config with bearer", async () => {
    const configPath = join(dir, "config.json");
    const bridge = await startTestConsole({
      configPath,
      cwd: dir,
      token: "test-token",
    });
    try {
      // Seed via PUT then re-read
      const first = await fetch(`${bridge.url}/api/config`, {
        headers: { Authorization: "Bearer test-token" },
      });
      const firstBody = (await first.json()) as { version: string };
      const put = await fetch(`${bridge.url}/api/config`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: firstBody.version,
          patch: {
            telegram: { botToken: "secret-token", allowedChatIds: ["111"] },
            runtime: { maxTurns: 12 },
          },
        }),
      });
      expect(put.status).toBe(200);

      const second = await fetch(`${bridge.url}/api/config`, {
        headers: { Authorization: "Bearer test-token" },
      });
      const secondBody = (await second.json()) as {
        config: { telegram?: { botToken: { __secret: true; set: boolean } }; runtime?: { maxTurns: number } };
      };
      expect(JSON.stringify(secondBody.config)).not.toContain("secret-token");
      expect(secondBody.config.telegram?.botToken).toEqual({ __secret: true, set: true });
      expect(secondBody.config.runtime?.maxTurns).toBe(12);

      // File on disk does hold the secret (env loader can still read it).
      const onDisk = await readFile(configPath, "utf8");
      expect(onDisk).toContain("secret-token");
    } finally {
      await bridge.stop();
    }
  });

  it("returns 409 when PUT is sent with a stale expectedVersion", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const put = await fetch(`${bridge.url}/api/config`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: "stale", patch: { runtime: { maxTurns: 4 } } }),
      });
      expect(put.status).toBe(409);
      const body = (await put.json()) as { error: string; currentVersion: string };
      expect(body.error).toBe("stale");
      expect(typeof body.currentVersion).toBe("string");
    } finally {
      await bridge.stop();
    }
  });

  it("returns the registry on /api/schema", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const response = await fetch(`${bridge.url}/api/schema`, {
        headers: { Authorization: "Bearer test-token" },
      });
      const body = (await response.json()) as { fieldGroups: { id: string }[] };
      expect(body.fieldGroups.map((g) => g.id)).toEqual(["runtime", "telegram"]);
    } finally {
      await bridge.stop();
    }
  });

  it("rejects PUT with unregistered top-level keys (does not persist)", async () => {
    const configPath = join(dir, "config.json");
    const bridge = await startTestConsole({
      configPath,
      cwd: dir,
      token: "test-token",
    });
    try {
      const first = await fetch(`${bridge.url}/api/config`, {
        headers: { Authorization: "Bearer test-token" },
      });
      const firstBody = (await first.json()) as { version: string };
      const put = await fetch(`${bridge.url}/api/config`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: firstBody.version,
          patch: { notRegistered: { arbitrary: "persisted" } },
        }),
      });
      expect(put.status).toBe(400);
      const body = (await put.json()) as {
        error: string;
        unregistered: readonly string[];
      };
      expect(body.error).toBe("unregistered_fields");
      expect(body.unregistered).toEqual(["notRegistered.arbitrary"]);

      // File on disk MUST NOT contain the unregistered key — server
      // refused to write before touching mono-agent.config.json.
      const onDiskExists = await readFile(configPath, "utf8").catch(() => "");
      expect(onDiskExists).not.toContain("notRegistered");
      expect(onDiskExists).not.toContain("arbitrary");
    } finally {
      await bridge.stop();
    }
  });

  it("rejects PUT with unregistered nested keys inside a registered group", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const first = await fetch(`${bridge.url}/api/config`, {
        headers: { Authorization: "Bearer test-token" },
      });
      const firstBody = (await first.json()) as { version: string };
      const put = await fetch(`${bridge.url}/api/config`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: firstBody.version,
          patch: { runtime: { sneaky: "value" } },
        }),
      });
      expect(put.status).toBe(400);
      const body = (await put.json()) as { error: string; unregistered: readonly string[] };
      expect(body.unregistered).toEqual(["runtime.sneaky"]);
    } finally {
      await bridge.stop();
    }
  });

  it("rejects PUT when an integer field is out of declared range", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const first = await fetch(`${bridge.url}/api/config`, {
        headers: { Authorization: "Bearer test-token" },
      });
      const firstBody = (await first.json()) as { version: string };
      const put = await fetch(`${bridge.url}/api/config`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: firstBody.version,
          patch: { runtime: { maxTurns: 9999 } },
        }),
      });
      expect(put.status).toBe(400);
      const body = (await put.json()) as {
        error: string;
        invalid: readonly { path: string; reason: string }[];
      };
      expect(body.invalid[0]?.path).toBe("runtime.maxTurns");
    } finally {
      await bridge.stop();
    }
  });

  it("returns disabled observability when no artifact reader is configured", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const unauthorized = await fetch(`${bridge.url}/api/observability/runs`);
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`${bridge.url}/api/observability/runs`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { enabled: boolean; runs: unknown[]; warnings: string[] };
      expect(body.enabled).toBe(false);
      expect(body.runs).toEqual([]);
      expect(body.warnings[0]).toMatch(/not configured/u);
    } finally {
      await bridge.stop();
    }
  });

  it("lists recorded runs and reads event details through bearer-protected observability endpoints", async () => {
    const artifactDir = join(dir, "artifacts");
    const recorder = createJsonlRunRecorder({ runId: "run-api", conversationId: "chat-api", artifactDir });
    recorder.onEvent({ type: "tool.call", toolName: "Read", status: "started", apiKey: "should-redact" });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
    await recorder.finish({ usage: { inputTokens: 3 }, capabilitiesUsed: ["tools"] });

    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
      observability: { artifactDir, maxRuns: 10, maxEventsPerRun: 10 },
    });
    try {
      const listResponse = await fetch(`${bridge.url}/api/observability/runs`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        enabled: boolean;
        artifactDir: string;
        runs: { runId: string; conversationId: string; status: string; eventCount: number; capabilitiesUsed?: unknown }[];
      };
      expect(listBody.enabled).toBe(true);
      expect(listBody.artifactDir).toBe(artifactDir);
      expect(listBody.runs[0]).toMatchObject({ runId: "run-api", conversationId: "chat-api", status: "succeeded", eventCount: 2 });
      expect(JSON.stringify(listBody)).not.toContain("should-redact");

      const detailResponse = await fetch(`${bridge.url}/api/observability/runs/${encodeURIComponent("run-api")}`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(detailResponse.status).toBe(200);
      const detailBody = (await detailResponse.json()) as {
        enabled: boolean;
        run: { events: { category: string; label: string; summary: string }[] };
      };
      expect(detailBody.enabled).toBe(true);
      expect(detailBody.run.events.map((event) => event.category)).toEqual(["tool", "message"]);
      expect(detailBody.run.events[0]?.label).toBe("Tool: Read");
      expect(detailBody.run.events[1]?.summary).toBe("done");
      expect(JSON.stringify(detailBody)).not.toContain("should-redact");
    } finally {
      await bridge.stop();
    }
  });

  it("lists traceability sources and disambiguates duplicate run ids by source", async () => {
    const registryDir = join(dir, "trace-registry");
    const artifactDirA = join(dir, "agent-a-artifacts");
    const artifactDirB = join(dir, "agent-b-artifacts");
    await registerTraceSource({
      registryDir,
      sourceId: "agent-a",
      label: "Agent A",
      artifactDir: artifactDirA,
      transports: ["telegram"],
    });
    await registerTraceSource({
      registryDir,
      sourceId: "agent-b",
      label: "Agent B",
      artifactDir: artifactDirB,
      status: "failed",
      metadata: { token: "should-redact-source" },
    });
    const recorderA = createJsonlRunRecorder({ runId: "duplicate", conversationId: "chat-a", artifactDir: artifactDirA });
    recorderA.onEvent({ type: "assistant", text: "A", authorization: "should-redact-event" });
    await recorderA.finish({});
    const recorderB = createJsonlRunRecorder({ runId: "duplicate", conversationId: "chat-b", artifactDir: artifactDirB });
    await recorderB.finish({ failureKind: "provider_error" });

    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
      traceability: { registryDir, maxRuns: 10, maxEventsPerRun: 10 },
    });
    try {
      const sourcesResponse = await fetch(`${bridge.url}/api/traceability/sources`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(sourcesResponse.status).toBe(200);
      const sourcesBody = await sourcesResponse.json() as {
        enabled: boolean;
        sources: Array<{ sourceId: string; health: string; transports?: string[] }>;
      };
      expect(sourcesBody.enabled).toBe(true);
      expect(sourcesBody.sources.map((source) => [source.sourceId, source.health]).sort()).toEqual([
        ["agent-a", "running"],
        ["agent-b", "failed"],
      ]);
      expect(JSON.stringify(sourcesBody)).not.toContain("should-redact-source");

      const runsResponse = await fetch(`${bridge.url}/api/traceability/runs`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(runsResponse.status).toBe(200);
      const runsBody = await runsResponse.json() as {
        enabled: boolean;
        runs: Array<{ runId: string; conversationId: string; source: { sourceId: string } }>;
      };
      expect(runsBody.runs.map((run) => [run.source.sourceId, run.runId, run.conversationId])).toEqual([
        ["agent-b", "duplicate", "chat-b"],
        ["agent-a", "duplicate", "chat-a"],
      ]);

      const detailResponse = await fetch(`${bridge.url}/api/traceability/runs/agent-a/${encodeURIComponent("duplicate")}`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(detailResponse.status).toBe(200);
      const detailBody = await detailResponse.json() as {
        detail?: { source: { sourceId: string }; run: { summary: { conversationId: string } } };
      };
      expect(detailBody.detail?.source.sourceId).toBe("agent-a");
      expect(detailBody.detail?.run.summary.conversationId).toBe("chat-a");
      expect(JSON.stringify(detailBody)).not.toContain("should-redact-event");
    } finally {
      await bridge.stop();
    }
  });

  it("serves traceability through a fallback local source when only observability is configured", async () => {
    const artifactDir = join(dir, "artifacts");
    const recorder = createJsonlRunRecorder({ runId: "local-run", conversationId: "local-chat", artifactDir });
    await recorder.finish({});

    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
      observability: { artifactDir },
    });
    try {
      const response = await fetch(`${bridge.url}/api/traceability/runs`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        enabled: boolean;
        sources: Array<{ sourceId: string }>;
        runs: Array<{ source: { sourceId: string }; runId: string }>;
      };
      expect(body.enabled).toBe(true);
      expect(body.sources[0]?.sourceId).toBe("local");
      expect(body.runs[0]).toMatchObject({ source: { sourceId: "local" }, runId: "local-run" });
    } finally {
      await bridge.stop();
    }
  });

  it("rejects path traversal in traceability source and run ids", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
      traceability: { registryDir: join(dir, "trace-registry") },
    });
    try {
      const response = await fetch(`${bridge.url}/api/traceability/runs/${encodeURIComponent("../source")}/run`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toBe("invalid_traceability_id");
    } finally {
      await bridge.stop();
    }
  });

  it("rejects path traversal in observability run ids", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
      observability: { artifactDir: join(dir, "artifacts") },
    });
    try {
      const response = await fetch(`${bridge.url}/api/observability/runs/${encodeURIComponent("../secret")}`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_run_id");
    } finally {
      await bridge.stop();
    }
  });

  it("responds to /api/health without the bearer", async () => {
    const bridge = await startTestConsole({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const response = await fetch(`${bridge.url}/api/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await bridge.stop();
    }
  });
});
