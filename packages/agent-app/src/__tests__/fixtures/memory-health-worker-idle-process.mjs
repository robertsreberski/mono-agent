import { MemoryHealthWorkerClient } from "../../../dist/memory-health-worker-client.js";

const client = new MemoryHealthWorkerClient({
  workerUrl: new URL("./memory-health-worker-fixture.mjs", import.meta.url),
  workerData: { mode: "success" },
  timeoutMs: 1_000,
});
await client.audit({ root: process.argv[2], mode: "lite" });
