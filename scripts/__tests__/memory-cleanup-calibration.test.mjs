import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runMemoryCleanupBenchmark } from "../lib/memory-cleanup-calibration.mjs";

describe("memory cleanup calibration", () => {
  it("passes the deterministic capture and graph calibration", async () => {
    const report = await runMemoryCleanupBenchmark();

    expect(report).toMatchObject({
      benchmark: "memory-cleanup",
      disposableStores: true,
      deterministicProviders: true,
      capture: { passed: true },
      graph: { passed: true },
      passed: true,
    });
  });

  it("preserves the primary failure while attempting every cleanup after the seed database closes", async () => {
    const primaryError = new Error("injected post-seed capture failure");
    let root;
    let storeCloseAttempted = false;

    await expect(runMemoryCleanupBenchmark({
      testHooks: {
        beforeCaptureReadback({ root: captureRoot, store }) {
          root = captureRoot;
          const close = store.close.bind(store);
          store.close = async () => {
            storeCloseAttempted = true;
            await close();
            throw new Error("injected store cleanup failure");
          };
          throw primaryError;
        },
      },
    })).rejects.toBe(primaryError);

    expect(storeCloseAttempted).toBe(true);
    expect(root).toBeTypeOf("string");
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
