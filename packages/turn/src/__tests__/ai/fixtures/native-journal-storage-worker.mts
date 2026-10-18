import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createManagedNativeJournalStorage } from "../../../execution/pi/storage-capability.js";
const [root, stop] = process.argv.slice(2) as [string, string, string, string];
const { context } = JSON.parse(await readFile(join(root, "native-proof.json"), "utf8"));
const storage = createManagedNativeJournalStorage({ sessionsRoot: root, onPhase: async (phase) => {
  if (phase === stop) { process.send?.({ phase }); await new Promise(() => { setInterval(() => {}, 1_000); }); }
} });
// Component-level native proof; the host coordinator supplies actual SQLite
// authority in the integrated suite, not this explicitly fictional callback.
context.assertOwned = async () => {};
await storage.createEpoch(context);
console.log(JSON.stringify({ inventory: await storage.inventory() }));
