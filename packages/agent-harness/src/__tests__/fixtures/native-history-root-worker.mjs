import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NativeHistoryRootStore, NATIVE_HISTORY_ROOT_FILE, NATIVE_HISTORY_ROOT_TEMP } from "../../../dist/native-history-root.js";
import { createDurableHistoryStore } from "../../../dist/durable-history.js";
import { bucket } from "./canonical-v4-fixture.mjs";
const [root, action, phase] = process.argv.slice(2);
try {
  if (action === "issue") {
    const ensure = NativeHistoryRootStore.prototype.ensure;
    NativeHistoryRootStore.prototype.ensure = function (owner) { return ensure.call(this, { ...owner, onPhase: async (current) => {
      if (current === phase) { process.send?.({ phase: current }); await new Promise(() => {}); }
    } }); };
  }
  const store = createDurableHistoryStore({ root, retireProviderSession: async () => { throw new Error("Unexpected native retirement"); } });
  const lease = await store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true }); if (lease.status !== "owned") throw new Error("Expected authority lease");
  await lease.assertOwned(); const authority = lease.authority; await lease.release();
  if (action === "issue") throw new Error(`Expected crash pause at ${phase}`);
  process.send?.({ authority, marker: JSON.parse(await readFile(join(root, NATIVE_HISTORY_ROOT_FILE), "utf8")),
    proposals: (await readdir(root)).filter((name) => NATIVE_HISTORY_ROOT_TEMP.test(name)), bytes: (await store.stats()).bytes });
} catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
process.disconnect?.();
