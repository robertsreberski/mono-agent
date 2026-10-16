// Manual measurement, not a test or latency gate. Build @mono-agent/conversation first.
// node scripts/measure-history-accounting.mjs [largest-root=1000]
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// Count whole-file reads made through fs/promises while the host root lock is
// held. Excludes SQLite reads, directory listings, stat calls and native I/O
// outside that lock. No product instrumentation or persisted counters.
let held = false, phase = "commit", mark = 0, sample;
const flush = () => {
  if (held) {
    const elapsed = performance.now() - mark;
    sample.lockMs += elapsed;
    if (phase === "retention") sample.retentionMs += elapsed;
    mark = performance.now();
  }
};
const countRead = () => { if (held) { sample.reads++; if (phase === "retention") sample.retentionReads++; } };
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args), readFile = handle.readFile.bind(handle);
  handle.readFile = (...options) => { countRead(); return readFile(...options); };
  return handle;
};
const readFile = fs.readFile;
fs.readFile = (...args) => { countRead(); return readFile(...args); };
syncBuiltinESMExports();
const { createDurableHistoryStore } = await import("../packages/conversation/dist/history/canonical/store.js");
const { NativeHistoryRootStore } = await import("../packages/conversation/dist/history/canonical/native-root.js");
const { createManagedNativeJournalStorage } = await import("@mono-agent/turn/ai");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const key = (id) => hash(`mono-agent-history-v1\0${id}`);
const handleId = (id, epoch) => hash(`mono-agent-provider-session-v2\0${id}\0${epoch}`);
function instrument(store) {
  const acquire = store.acquireRootTransaction.bind(store), retention = store.applyRetention.bind(store), plan = store.retentionPlan.bind(store);
  store.acquireRootTransaction = async (...args) => {
    const release = await acquire(...args); held = true; mark = performance.now();
    return async () => { try { await release(); } finally { flush(); held = false; } };
  };
  store.applyRetention = async (...args) => {
    flush(); phase = "retention";
    try { return await retention(...args); } finally { flush(); phase = "commit"; }
  };
  store.retentionPlan = (...args) => { if (phase === "retention") sample.plans++; return plan(...args); };
}
console.log(JSON.stringify({ node: process.version, platform: platform(), arch: arch(), measurement: "one warm-filesystem commit per cell; retention is a subset of commit; times are cumulative host-root-lock-held milliseconds" }));
const started = performance.now(), largest = Number(process.argv[2] ?? 1000);
for (const count of [1, 100, 1000, 10000].filter((n) => n <= largest)) {
  for (const managed of [false, true]) {
    const base = await fs.mkdtemp(join(tmpdir(), "history-accounting-")), root = join(base, "history");
    try {
      await fs.mkdir(root, { mode: 0o700 });
      const native = managed ? createManagedNativeJournalStorage({ sessionsRoot: join(base, "native") }) : undefined;
      const rootStore = new NativeHistoryRootStore(root, await fs.lstat(root));
      const marker = managed ? await rootStore.ensure({ assertOwned: async () => {}, reserve: async () => {} }) : undefined;
      // Offline fixture construction avoids measuring N quadratic seed appends.
      // Each managed record has a real guarded native epoch; no provider runs.
      for (let i = 0; i < count; i++) {
        const id = `fictional-benchmark-${i}`, epoch = hash(id), authority = managed ? rootStore.authority(marker, id, id) : undefined;
        if (native) await native.createEpoch({ hostAuthority: authority, targetHandleId: handleId(id, epoch), timestamp: 0, assertOwned: async () => {} });
        await fs.writeFile(join(root, `${key(id)}.history.json`), JSON.stringify({ version: 3, conversationId: id,
          messages: [{ role: "user", content: "Fictional retained context." }], providerSession: { epoch, revision: 0, modelKey: "faux:benchmark" },
          ...(managed ? { native: { authority, projection: null } } : {}) }), { mode: 0o600 });
      }
      for (const pressure of [false, true]) {
        const store = createDurableHistoryStore({ root, nativeJournalStorage: native, maxConversations: pressure ? count : count + 1 });
        instrument(store);
        // Preparation/admission are intentionally excluded. The commit includes
        // publication and its post-publication retention work, including replans.
        sample = { lockMs: 0, reads: 0, retentionMs: 0, retentionReads: 0, plans: 0 };
        const prepared = await store.prepareAppend("fictional-newcomer", [{ role: "user", content: "Fictional appended context." }]);
        sample = { lockMs: 0, reads: 0, retentionMs: 0, retentionReads: 0, plans: 0 };
        const begin = performance.now(); await prepared.commit();
        console.log(JSON.stringify({ conversations: count, managed, pressure, wallMs: +(performance.now() - begin).toFixed(2),
          ...sample, lockMs: +sample.lockMs.toFixed(2), retentionMs: +sample.retentionMs.toFixed(2) }));
        if (!pressure) await store.reset("fictional-newcomer");
      }
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  }
  if (performance.now() - started > 8 * 60_000) { console.log(JSON.stringify({ stopped: "remaining sizes omitted to keep the run near ten minutes" })); break; }
}
