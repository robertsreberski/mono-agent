import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startConfigUiBridge } from "./start.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-bridge-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startConfigUiBridge", () => {
  it("refuses non-loopback hosts", async () => {
    await expect(
      startConfigUiBridge({
        configPath: join(dir, "config.json"),
        cwd: dir,
        host: "0.0.0.0",
      }),
    ).rejects.toThrow(/non-loopback/u);
  });

  it("serves the SPA shell with the runtime token injected", async () => {
    const bridge = await startConfigUiBridge({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const response = await fetch(bridge.url);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("window.__CONFIG_UI__");
      expect(html).toContain("\"token\":\"test-token\"");
      expect(html).toContain("\"fieldGroupIds\":[");
    } finally {
      await bridge.stop();
    }
  });

  it("returns 401 for /api/config without the bearer", async () => {
    const bridge = await startConfigUiBridge({
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
    const bridge = await startConfigUiBridge({
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
    const bridge = await startConfigUiBridge({
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
    const bridge = await startConfigUiBridge({
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
    const bridge = await startConfigUiBridge({
      configPath: join(dir, "config.json"),
      cwd: dir,
      token: "test-token",
    });
    try {
      const response = await fetch(`${bridge.url}/api/schema`, {
        headers: { Authorization: "Bearer test-token" },
      });
      const body = (await response.json()) as { fieldGroups: { id: string }[] };
      expect(body.fieldGroups.map((g) => g.id)).toEqual([
        "identity",
        "runtime",
        "memory",
        "tools",
        "telegram",
      ]);
    } finally {
      await bridge.stop();
    }
  });

  it("rejects PUT with unregistered top-level keys (does not persist)", async () => {
    const configPath = join(dir, "config.json");
    const bridge = await startConfigUiBridge({
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

      // File on disk MUST NOT contain the unregistered key — bridge
      // refused to write before touching mono-agent.config.json.
      const onDiskExists = await readFile(configPath, "utf8").catch(() => "");
      expect(onDiskExists).not.toContain("notRegistered");
      expect(onDiskExists).not.toContain("arbitrary");
    } finally {
      await bridge.stop();
    }
  });

  it("rejects PUT with unregistered nested keys inside a registered group", async () => {
    const bridge = await startConfigUiBridge({
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
    const bridge = await startConfigUiBridge({
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

  it("responds to /api/health without the bearer", async () => {
    const bridge = await startConfigUiBridge({
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
