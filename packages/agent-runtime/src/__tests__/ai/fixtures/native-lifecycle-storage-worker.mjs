import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createManagedNativeJournalStorage } from "../../../ai/providers/pi-native/native-journal-storage.js";
const [root, stop] = process.argv.slice(2);
const { chain, cold, deletion, operation } = JSON.parse(await readFile(join(root, "lifecycle-proof.json"), "utf8"));
const storage = createManagedNativeJournalStorage({ sessionsRoot: root, onPhase: async (phase) => {
  if (phase === stop) { process.send?.({ phase }); await new Promise(() => {}); }
} });
// Component proof only: these fictional assertions are not host canonical or
// SQLite authority. The caller must durably retain its own C/D intent.
cold.assertOwned = async () => {};
deletion.assertOwned = async () => {};
let published;
if (operation === "cold") {
  published = await storage.publishColdEpoch(chain, cold);
  await storage.deleteJournals(chain, deletion);
} else await storage.deleteJournals(chain, deletion);
console.log(JSON.stringify({ published, inventory: await storage.inventory() }));
