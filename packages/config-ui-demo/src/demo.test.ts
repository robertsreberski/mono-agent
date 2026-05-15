import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDemoBridge } from "./demo.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-config-ui-demo-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startDemoBridge", () => {
  it("boots a loopback bridge, returns url/token, persists across stops", async () => {
    const first = await startDemoBridge({ cwd: dir });
    try {
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(first.token).toMatch(/^[0-9a-f]{64}$/u);
      expect(first.configPath.endsWith("mono-agent.config.json")).toBe(true);

      const initial = await fetch(`${first.url}/api/config`, {
        headers: { Authorization: `Bearer ${first.token}` },
      });
      const initialBody = (await initial.json()) as { config: unknown; version: string };

      // PUT a runtime change
      const put = await fetch(`${first.url}/api/config`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${first.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: initialBody.version,
          patch: { runtime: { maxTurns: 17 } },
        }),
      });
      expect(put.status).toBe(200);
    } finally {
      await first.stop();
    }

    // Re-boot to confirm the value persisted.
    const second = await startDemoBridge({ cwd: dir });
    try {
      const refetched = await fetch(`${second.url}/api/config`, {
        headers: { Authorization: `Bearer ${second.token}` },
      });
      const body = (await refetched.json()) as { config: { runtime?: { maxTurns: number } } };
      expect(body.config.runtime?.maxTurns).toBe(17);

      const onDisk = JSON.parse(await readFile(second.configPath, "utf8")) as {
        runtime?: { maxTurns: number };
      };
      expect(onDisk.runtime?.maxTurns).toBe(17);
    } finally {
      await second.stop();
    }
  });
});
