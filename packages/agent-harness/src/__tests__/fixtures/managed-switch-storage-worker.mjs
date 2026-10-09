import { ModelSwitchPayloadStore } from "../../../dist/model-switch-payloads.js";
import { createDurableHistoryStore } from "../../../dist/durable-history.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const [root, action, statePath, killPhase] = process.argv.slice(2);
const store = createDurableHistoryStore({ root, retireProviderSession: async () => { throw new Error("Unexpected native retirement"); } });
try {
  if (killPhase) {
    const admit = ModelSwitchPayloadStore.prototype.admit;
    ModelSwitchPayloadStore.prototype.admit = function (bucket, switchId, producer, owner) {
      let publishing = false;
      return admit.call(this, bucket, switchId, producer, { ...owner, onPhase: async (phase) => {
        if (phase === "payload_file_synced") publishing = true;
        if (publishing && phase === killPhase) { process.send?.({ phase }); await new Promise(() => { setInterval(() => {}, 1_000); }); }
      } });
    };
  }
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const lease = await store.beginModelSwitchStorage(state); if (lease.status !== "owned") throw new Error("Expected owned storage");
  if (action === "admit") {
    await lease.admit("outgoing"); process.send?.({ phase: "admitted" }); await new Promise(() => { setInterval(() => {}, 1_000); });
  } else {
    let refused = false;
    // Never advance a pre-fence crash's orphan admission during storage-only recovery.
    if ((await lease.read()).state.attempts.length) {
      try { await lease.admit("outgoing"); } catch (error) { refused = error.code === "ERR_HANDOFF_ATTEMPT_ALREADY_RECORDED"; }
    }
    const current = await lease.read(); await lease.release();
    process.send?.({ refused, state: current.state, bytes: (await store.stats()).bytes, reservedBytes: (await store.stats()).reservedBytes, files: await readdir(join(root, ".model-switches")) });
  }
} catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
process.disconnect?.();
