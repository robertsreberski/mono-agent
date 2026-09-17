import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { safeRebuildMemoryIndex } from "@mono-agent/memory/bujo";
import { openMemoryDb } from "@mono-agent/memory/store";

import { MemoryHealthWorkerClient } from "../memory-health-worker-client.js";

const execFileAsync = promisify(execFile);
const builtWorkerUrl = new URL("../../dist/memory-health-worker.js", import.meta.url);
const fixtureUrl = new URL("./fixtures/memory-health-worker-fixture.mjs", import.meta.url);
const idleProcessUrl = new URL("./fixtures/memory-health-worker-idle-process.mjs", import.meta.url);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("memory health worker client", () => {
  it("runs a real built audit worker and reuses it for sequential requests", async () => {
    const root = await temporaryRoot();
    const client = new MemoryHealthWorkerClient({ workerUrl: builtWorkerUrl, timeoutMs: 2_000 });
    const first = await client.audit({ root, mode: "lite" });
    const second = await client.audit({ root, mode: "lite" });

    expect(first).toMatchObject({ backend: "bujo", mode: "lite" });
    expect(second).toMatchObject({ backend: "bujo", mode: "lite" });
    client.invalidate();
  });

  it("keeps parent timers responsive while a real audit overlaps synchronous SQLite writes", async () => {
    const root = await populatedBujoRoot(1_800);
    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: { id: "worker-test:4", embed: async (texts) => texts.map(() => [1, 0, 0, 0]) },
      dim: 4,
    });
    const writer = openMemoryDb({ path: rebuilt.active, dim: 4 });
    const client = new MemoryHealthWorkerClient({ workerUrl: builtWorkerUrl, timeoutMs: 5_000 });
    const timerDelays: number[] = [];
    let expectedTimerAt = performance.now() + 10;
    const timer = setInterval(() => {
      const now = performance.now();
      timerDelays.push(Math.max(0, now - expectedTimerAt));
      expectedTimerAt = now + 10;
    }, 10);

    const startedAt = performance.now();
    let auditSettled = false;
    const auditing = client.audit({
      root,
      mode: "bujo",
      configuredEmbeddingModel: "worker-test:4",
      configuredDimension: 4,
      maxStabilityAttempts: 1,
    }).finally(() => {
      auditSettled = true;
    });
    try {
      let salience = 0.7;
      let writes = 0;
      while (!auditSettled && writes < 400) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        const next = salience === 0.7 ? 0.71 : 0.7;
        writer.repairLegacySalience("M-000000", salience, next);
        salience = next;
        writes += 1;
      }
      const report = await auditing;
      const auditDurationMs = performance.now() - startedAt;

      expect(report.backend).toBe("bujo");
      expect(auditDurationMs).toBeGreaterThan(100);
      expect(writes).toBeGreaterThan(10);
      expect(timerDelays.length).toBeGreaterThan(2);
      expect(Math.max(...timerDelays)).toBeLessThan(150);
    } finally {
      clearInterval(timer);
      writer.close();
      client.invalidate();
    }
  }, 20_000);

  it.each(["malformed", "crash", "early-exit"])("rejects a %s worker response without exposing diagnostics", async (mode) => {
    const client = new MemoryHealthWorkerClient({ workerUrl: fixtureUrl, workerData: { mode }, timeoutMs: 1_000 });
    await expect(client.audit({ root: await temporaryRoot(), mode: "lite" })).rejects.not.toThrow(/private|secret/iu);
  });

  it("rejects worker startup failure", async () => {
    const client = new MemoryHealthWorkerClient({
      workerUrl: new URL("./fixtures/missing-memory-health-worker.mjs", import.meta.url),
      timeoutMs: 1_000,
    });
    await expect(client.audit({ root: await temporaryRoot(), mode: "lite" })).rejects.toThrow(/worker/iu);
  });

  it("times out, retires the worker, and does not overlap a replacement", async () => {
    const client = new MemoryHealthWorkerClient({ workerUrl: fixtureUrl, workerData: { mode: "timeout" }, timeoutMs: 20 });
    await expect(client.audit({ root: await temporaryRoot(), mode: "lite" })).rejects.toThrow(/timed out/iu);
    // Termination can settle before this continuation runs. In that case a new
    // worker starts only after the old exit and reaches its own bounded timeout.
    await expect(client.audit({ root: await temporaryRoot(), mode: "lite" })).rejects.toThrow(/retiring|timed out/iu);
  });

  it("synchronously rejects pending work when invalidated", async () => {
    const client = new MemoryHealthWorkerClient({ workerUrl: fixtureUrl, workerData: { mode: "timeout" }, timeoutMs: 10_000 });
    const pending = client.audit({ root: await temporaryRoot(), mode: "lite" });
    client.invalidate();
    await expect(pending).rejects.toThrow(/invalidated/iu);
  });

  it("does not keep a process alive after a successful idle audit", async () => {
    const startedAt = performance.now();
    await execFileAsync(process.execPath, [idleProcessUrl.pathname, await temporaryRoot()], { timeout: 2_000 });
    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-health-worker-test-"));
  temporaryRoots.push(root);
  return root;
}

async function populatedBujoRoot(count: number): Promise<string> {
  const root = await temporaryRoot();
  await mkdir(join(root, "daily"));
  const createdAt = "2026-01-01T00:00:00.000Z";
  const bullets: string[] = ["# 2026-01-01", ""];
  const graph: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(6, "0");
    const id = `M-${suffix}`;
    const name = `Entity${suffix}`;
    bullets.push(
      `- – ${name} durable fact`,
      `  <!--mem id=${id} type=note status=open salience=0.7 isInsight=0 created=${createdAt} refs=-->`,
    );
    graph.push(JSON.stringify({ kind: "entity", id: `entity:${suffix}`, name, createdAt }));
  }
  await Promise.all([
    writeFile(join(root, "daily", "2026-01-01.md"), `${bullets.join("\n")}\n`, "utf8"),
    writeFile(join(root, "graph.jsonl"), `${graph.join("\n")}\n`, "utf8"),
  ]);
  return root;
}
