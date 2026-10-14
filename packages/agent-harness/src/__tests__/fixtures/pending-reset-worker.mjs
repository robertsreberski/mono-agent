import { readdir } from "node:fs/promises";
import { createDurableHistoryStore } from "../../../dist/durable-history.js";
const root = process.argv[2];
process.once("message", async ({ mode, conversationId }) => {
  try {
    const retired = [];
    const store = createDurableHistoryStore({ root, retireProviderSession: async (id, modelKey) => {
      retired.push({ id, modelKey });
      if (mode === "reset-stop") {
        process.send({ phase: "retirement-intent-durable" });
        await new Promise(() => { setInterval(() => {}, 1_000); });
      }
    } });
    await store.reset(conversationId);
    process.send({ history: await store.load(conversationId), pending: await readdir(`${root}/.pending-turns`), retired }, () => process.exit(0));
  } catch (error) { console.error(error); process.exit(1); }
});
