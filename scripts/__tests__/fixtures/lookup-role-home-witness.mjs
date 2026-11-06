// Loaded only by the six owned role subprocesses, before configured app imports.
import { isMainThread } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.env.LOOKUP_ROLE_HOME_WITNESS === "1" && isMainThread && (process.argv.includes("--lookup-role") || process.argv[1]?.endsWith("/nonzero-after-receipt.mjs"))) {
  const keys = ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];
  writeFileSync(join(process.env.HOME, "role-home.json"), JSON.stringify({pid: process.pid, env: Object.fromEntries(keys.map(key => [key, process.env[key]]))}), {mode: 0o600});
}
