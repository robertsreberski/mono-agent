import { JsonlSessionRepo } from "../../session-store.js";
const [root, phase] = process.argv.slice(2);
const hostAuthority = { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const repo = new JsonlSessionRepo({ sessionsRoot: root, onHeaderUpgradePhase: async (current) => {
  if (current === phase) { process.send?.({ phase: current }); await new Promise(() => {}); }
} });
try {
  const [metadata] = await repo.list();
  const upgraded = await repo.upgradeHeader(metadata, { hostAuthority, assertOwned: async () => {} });
  const store = await repo.open(upgraded, { repair: false });
  store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority });
  await store.close();
  process.send?.({ ready: true });
} catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
process.disconnect?.();
