// Boundary verification only, never configured inference or a provider substitute.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
process.once("message", async a => {
  try {
    const { restoreLookupPreparation } = await import(pathToFileURL(join(a.pilot.registration.codes[a.slot.code].path, "scripts/lib/continuity-lookup-preparation.mjs")));
    const restored = await restoreLookupPreparation(a);
    process.send({ verified: true, pid: process.pid, conversation: typeof restored.manifest.conversationId === "string" }, () => process.disconnect());
  } catch (error) { process.send({ refused: error.code ?? "lookup_preparation_invalid", pid: process.pid }, () => process.disconnect()); }
});
process.send({ loaded: true });
