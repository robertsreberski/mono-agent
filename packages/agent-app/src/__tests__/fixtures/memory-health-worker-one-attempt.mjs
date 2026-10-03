import { parentPort } from "node:worker_threads";

parentPort?.on("message", (request) => {
  if (request.options.maxStabilityAttempts !== 1) {
    parentPort.postMessage({ type: "error", id: request.id });
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
