import { JsonlSessionRepo } from "../../session-store.js";
const repo = new JsonlSessionRepo({ sessionsRoot: process.argv[2], onImportPhase: async (phase) => {
  if (phase !== process.argv[3]) return;
  process.send({ phase });
  await new Promise(() => { setInterval(() => {}, 1_000); }); // Parent kills the real catalogue/writer owner.
} });
await repo.create({ id: "fixture-session" });
process.send({ phase: "unexpected-completion" });
process.disconnect();
