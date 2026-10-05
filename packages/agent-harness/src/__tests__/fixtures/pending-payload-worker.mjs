import { lstat } from "node:fs/promises";
import { PendingTurnPayloadStore, pendingCoordinates } from "../../../dist/durable-turn-payloads.js";
const root = process.argv[2];
const store = new PendingTurnPayloadStore(root, await lstat(root));
const owner = { assertOwned: async () => {}, reserve: async () => {} };
process.once("message", async (request) => {
  try {
    if (request.mode === "publish-stop") {
      owner.onPhase = async (phase) => {
        if (phase === "directory_synced") { process.send({ phase }); await new Promise(() => {}); }
      };
      await store.publish(request.value, owner);
    } else if (request.mode === "read-collect") {
      const payload = await store.read(request.pointer, request.value.identity);
      const removed = await store.collectUnreferenced(pendingCoordinates(request.value.identity), [request.pointer], owner);
      process.send({ payload, removed, generations: (await store.list()).length }, () => process.exit(0));
    } else throw new Error("Unknown fixture mode");
  } catch (error) { console.error(error); process.exit(1); }
});
