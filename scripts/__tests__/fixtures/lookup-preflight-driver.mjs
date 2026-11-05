import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
process.once("message", async ({repo, pilot}) => {
  try {
    const { runLookupPreparationPreflight } = await import(pathToFileURL(join(repo, "scripts/lib/continuity-lookup-preflight.mjs")));
    const result = await runLookupPreparationPreflight(pilot);
    const settings = JSON.parse(await readFile(process.env.LOOKUP_BOUNDARY_SETTINGS));
    process.send({result, witnessRoot: settings.witnesses}, () => process.disconnect());
  } catch (error) { process.send({failed: error.code ?? "lookup_preflight_failed"}, () => process.disconnect()); }
});
process.send({loaded: true});
