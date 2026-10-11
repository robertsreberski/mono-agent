import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createManagedNativeJournalStorage } from "../../../ai/providers/pi-native/native-journal-storage.js";
const [root, stop] = process.argv.slice(2);
const { current, cold, deletion, operation } = JSON.parse(await readFile(join(root, "lifecycle-proof.json"), "utf8"));
const storage = createManagedNativeJournalStorage({ sessionsRoot: root, onPhase: async (phase) => {
  if (phase === stop) { process.send?.({ phase }); await new Promise(() => { setInterval(() => {}, 1_000); }); }
} });
// Component proof only: these fictional assertions are not host canonical or
// SQLite authority. The caller must durably retain its own C/D intent.
cold.assertOwned = async () => {};
deletion.assertOwned = async () => {};
if (operation === "cold") await storage.createEpoch(cold);
await storage.deleteJournals([current], deletion);
console.log(JSON.stringify({ inventory: await storage.inventory() }));
