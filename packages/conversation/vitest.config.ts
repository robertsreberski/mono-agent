import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import turnSourceConfig from "../turn/vitest.config.ts";

// The authored preparation fixture and public turn imports must share owners.
// Reuse turn's source aliases, including its native sandbox asset boundary.
export default mergeConfig(turnSourceConfig, {
  root: fileURLToPath(new URL(".", import.meta.url)),
});
