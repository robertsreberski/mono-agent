import { JsonlSessionRepo } from "../../session-store.js";
const repo = new JsonlSessionRepo({ sessionsRoot: process.argv[2] });
const session = await repo.open((await repo.list())[0]);
process.send({ phase: "opened" });
process.once("message", async () => {
  await session.close(); process.send({ phase: "closed" }); process.disconnect();
});
