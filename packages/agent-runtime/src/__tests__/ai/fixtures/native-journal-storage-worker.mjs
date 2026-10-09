import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createManagedNativeJournalStorage } from "../../../ai/providers/pi-native/native-journal-storage.js";
const [root, stop] = process.argv.slice(2);
const { source, context } = JSON.parse(await readFile(join(root, "native-proof.json"), "utf8"));
const storage = createManagedNativeJournalStorage({ sessionsRoot: root, onPhase: async (phase) => {
  if (phase === stop) { process.send?.({ phase }); await new Promise(() => { setInterval(() => {}, 1_000); }); }
} });
// Component-level native proof; the host coordinator supplies actual SQLite
// authority in the integrated suite, not this explicitly fictional callback.
context.assertOwned = async () => {};
const chain = await storage.publishSwitch([source], context);
console.log(JSON.stringify({ chain, inventory: await storage.inventory() }));
