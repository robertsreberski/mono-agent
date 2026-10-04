import { JsonlSessionRepo } from "../../session-store.js";
const repo = new JsonlSessionRepo({ sessionsRoot: process.argv[2], onImportPhase: async (phase) => {
  if (phase !== process.argv[3]) return;
  process.send({ phase });
  await new Promise(() => {}); // Parent SIGKILLs at a real ownership/publication boundary.
} });
await repo.open((await repo.list())[0]);
process.send({ phase: "unexpected-completion" });
process.disconnect();
