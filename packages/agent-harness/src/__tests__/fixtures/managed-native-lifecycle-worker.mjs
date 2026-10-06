import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { openStore, bucket } from "./managed-native-switch-fixture.mjs";
import { switchConversationKey } from "../../../dist/durable-model-switch-contract.js";
const [base, stop] = process.argv.slice(2);
const phase = async (name) => { if (name === stop) { process.send?.({ name }); await new Promise(() => {}); } };
const { operation } = JSON.parse(await readFile(join(base, "lifecycle-proof.json"), "utf8"));
const { store } = openStore(base, phase, { onNativeHistoryPhase: phase, ...(operation === "retention" ? { maxConversations: 1 } : {}) });
if (stop) {
  if (operation === "cold") await store.append(bucket, [{ role: "assistant", content: "Fictional cold update" }]);
  else if (operation === "reset") await store.reset(bucket);
  else await store.append("fictional-retention-winner", [{ role: "assistant", content: "Fictional retention winner" }]);
} else {
  // Storage-only owner admission recovers the durable C/D intent, never replays
  // the explicit host mutation or dispatches providers/tools.
  const lease = await store.contextImport.beginExclusiveTurn(bucket); await lease.abort();
}
let canonical = null;
try { canonical = JSON.parse(await readFile(join(base, "history", `${switchConversationKey(bucket)}.history.json`), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
console.log(JSON.stringify({ canonical, stats: await store.stats(), journals: (await readdir(join(base, "native", "mono-v2", "journals"))).sort(),
  switches: (await readdir(join(base, "history", ".model-switches"))).sort(), operations: (await readdir(join(base, "history"))).filter((name) => name.startsWith(".native-history-op.")).sort() }));
