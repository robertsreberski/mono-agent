import { createHostWebRequestCoordinator } from "../../../dist/web-request-coordinator.js";
const coordinator = createHostWebRequestCoordinator({ directory: process.argv[2], spacingScale: 0 });
const permit = await coordinator.acquire({ kind: "codex", key: "codex", deadlineMs: Date.now() + 10000 });
process.send({ acquired: true });
process.on("message", async () => {
  await permit.complete({ status: "ok" });
  process.send({ released: true });
  process.disconnect();
});
