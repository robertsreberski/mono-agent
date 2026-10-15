import { parentPort } from "node:worker_threads";

parentPort?.on("message", (request) => {
  parentPort.postMessage({
    type: "result",
    id: request.id,
    report: { status: "healthy", private: "/secret" },
  });
});
