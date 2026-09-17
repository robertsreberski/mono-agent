import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

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
    await expect(client.audit({ root: await temporaryRoot(), mode: "lite" })).rejects.toThrow(/retiring/iu);
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
