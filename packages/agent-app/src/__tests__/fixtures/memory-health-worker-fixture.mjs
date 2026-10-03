import { parentPort, workerData } from "node:worker_threads";

const mode = workerData?.mode ?? "success";

if (mode === "early-exit") {
  process.exit(0);
}

parentPort?.on("message", (request) => {
  if (mode === "timeout") return;
  if (mode === "crash") throw new Error("private worker crash");
  if (mode === "malformed") {
    parentPort.postMessage({ type: "result", id: request.id, report: { status: "healthy", private: "/secret" } });
    return;
  }
  parentPort.postMessage({
    type: "result",
    id: request.id,
    report: {
      schemaVersion: 1,
      backend: "bujo",
      mode: request.options.mode,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      issues: [],
      counts: {
        pending: 0,
        due: 0,
        dead: 0,
        outbox: 0,
        temporary: 0,
        memories: 0,
        vectors: 0,
        missingVectors: 0,
      },
    },
  });
});
