import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readWebLogMaintenanceStatus,
  readWebLogMonitorStatus,
  writeWebLogMaintenanceStatus,
  writeWebLogMonitorStatus,
} from "../web-log-maintenance-status.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-web-status-")));
  tempDirs.push(root);
  await mkdir(join(root, "state"), { mode: 0o700 });
  return join(root, "state", "status.json");
}

describe("web log maintenance status files", () => {
  it("round-trips bounded owner-private monitor and maintenance status", async () => {
    const path = await fixture();
    await writeWebLogMonitorStatus(path, {
      version: 1,
      lastInspectionAt: "2026-08-14T12:00:00.000Z",
      wakeCount: 4,
      lastOutcome: "requested",
      cooldownDeadline: "2026-08-14T12:10:00.000Z",
    });
    await expect(readWebLogMonitorStatus(path)).resolves.toMatchObject({
      kind: "valid",
      status: { wakeCount: 4, lastOutcome: "requested" },
    });

    await writeWebLogMaintenanceStatus(path, {
      version: 1,
      state: "degraded",
      phase: "complete",
      updatedAt: "2026-08-14T12:01:00.000Z",
      detail: `token=secret\n${"x".repeat(800)}`,
      refusals: Array.from({ length: 12 }, (_unused, index) => `refusal ${String(index)} ${"y".repeat(400)}`),
    });
    const result = await readWebLogMaintenanceStatus(path);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.status.detail).not.toContain("secret");
      expect(result.status.detail?.length).toBeLessThanOrEqual(512);
      expect(result.status.refusals).toHaveLength(8);
      expect(result.status.refusals?.every((item) => item.length <= 256)).toBe(true);
    }
  });

  it("rejects symlink, hardlink, broad-mode, malformed, and oversized status files", async () => {
    const path = await fixture();
    const target = `${path}.target`;
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, path);
    await expect(readWebLogMaintenanceStatus(path)).resolves.toMatchObject({ kind: "invalid" });
    await rm(path);

    await link(target, path);
    await expect(readWebLogMaintenanceStatus(path)).resolves.toMatchObject({ kind: "invalid" });
    await rm(path);
    await rm(target);

    await writeFile(path, JSON.stringify({}), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(readWebLogMaintenanceStatus(path)).resolves.toMatchObject({ kind: "invalid" });
    await chmod(path, 0o600);
    await writeFile(path, "not-json\n", { mode: 0o600 });
    await expect(readWebLogMaintenanceStatus(path)).resolves.toMatchObject({ kind: "invalid" });
    await writeFile(path, "x".repeat(4 * 1024 + 1), { mode: 0o600 });
    await expect(readWebLogMaintenanceStatus(path)).resolves.toMatchObject({ kind: "invalid" });
  });

  it.each([
    ["array state", { state: ["failed"] }],
    ["array phase", { phase: ["complete"] }],
  ])("rejects hostile maintenance status with %s", async (_case, override) => {
    const path = await fixture();
    await writeFile(path, `${JSON.stringify({
      version: 1,
      state: "failed",
      phase: "complete",
      updatedAt: "2026-08-14T12:01:00.000Z",
      ...override,
    })}\n`, { mode: 0o600 });

    await expect(readWebLogMaintenanceStatus(path)).resolves.toMatchObject({ kind: "invalid" });
  });
});
