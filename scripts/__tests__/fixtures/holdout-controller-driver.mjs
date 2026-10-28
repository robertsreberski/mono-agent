import { pathToFileURL } from "node:url";
process.once("message", async ({ modulePath, context, options }) => {
  try {
    const { runController } = await import(pathToFileURL(modulePath));
    const result = await runController(context, { ...options, workerURL: new URL("./holdout-worker.mjs", import.meta.url), env: { HOLDOUT_FIXTURE_MODE: "park" } });
    process.send({ result });
  } catch { process.send({ failed: true }); }
  process.disconnect();
});
