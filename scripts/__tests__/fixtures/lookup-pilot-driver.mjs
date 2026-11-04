import { pathToFileURL } from "node:url";
import { join } from "node:path";
process.once("message", async input => {
  const load = name => import(pathToFileURL(join(input.repo, "scripts/lib", `continuity-${name}.mjs`)).href);
  try {
    if (input.mode === "idle") {
      const { lookupProcessStartIdentity } = await load("process-identity");
      process.on("message", () => {}); process.send({ pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) }); return;
    }
    const controller = await load("lookup-controller");
    const result = input.mode === "reconcile" ? await controller.reconcileLookupPilot(input.outputRoot) : await controller.runLookupPilot(input.options);
    process.send({ result }, () => process.disconnect());
  } catch (error) { process.send({ failed: error.code ?? "lookup_fixture_failed" }, () => process.disconnect()); }
});
process.send({ ready: true });
