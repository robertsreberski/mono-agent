import { JsonlSessionRepo } from "../../../../ai/providers/pi-native/harness/session-store.js";
const repo = new JsonlSessionRepo({ sessionsRoot: process.argv[2] });
const session = await repo.create({ id: "interrupted-fixture" });
await session.openTurn("interrupted-run", { model: { provider: "faux", id: "fictional-model" } });
await session.appendMessage({ role: "user", content: [{ type: "text", text: "Fictional request." }], timestamp: 1700000000000 });
process.send({ phase: "appended-not-synced" });
// IPC keeps the fixture process alive until the parent kills it. No sync or close.
