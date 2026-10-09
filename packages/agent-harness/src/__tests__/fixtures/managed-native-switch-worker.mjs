import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openStore, bucket } from "./managed-native-switch-fixture.mjs";
const [base, stop] = process.argv.slice(2), { switchId } = JSON.parse(await readFile(join(base, "switch-proof.json"), "utf8"));
const phase = async (name) => { if (name === stop) { process.send?.({ phase: name }); await new Promise(() => { setInterval(() => {}, 1_000); }); } };
const { store } = openStore(base, phase);
const result = await store.rollForwardModelSwitch(bucket, switchId, { exclusiveWriters: true, onPhase: phase });
console.log(JSON.stringify({ result, stats: await store.stats(), binding: await store.readProviderSessionBinding(bucket) }));
