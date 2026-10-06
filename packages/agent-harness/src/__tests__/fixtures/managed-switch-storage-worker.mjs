import { createDurableHistoryStore } from "../../../dist/durable-history.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const [root, action, statePath] = process.argv.slice(2);
const store = createDurableHistoryStore({ root, retireProviderSession: async () => { throw new Error("Unexpected native retirement"); } });
try {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const lease = await store.beginModelSwitchStorage(state); if (lease.status !== "owned") throw new Error("Expected owned storage");
  if (action === "admit") {
    await lease.admit("outgoing"); process.send?.({ phase: "admitted" }); await new Promise(() => {});
  } else {
    let refused = false; try { await lease.admit("outgoing"); } catch (error) { refused = error.code === "ERR_HANDOFF_ATTEMPT_ALREADY_RECORDED"; }
    const current = await lease.read(); await lease.release();
    process.send?.({ refused, state: current.state, bytes: (await store.stats()).bytes, files: await readdir(join(root, ".model-switches")) });
  }
} catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
process.disconnect?.();
