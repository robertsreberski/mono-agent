import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import rootConfig from "../../vitest.config.mjs";

// Host TS and the turn JS share module identity in source-level protection
// tests. Packed-consumer tests separately exercise the mixed built artifacts.
export default mergeConfig(rootConfig, defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      ...[["host", "index"], ["host/config", "config"], ["host/types", "types"], ["host/sandbox", "sandbox/index"]].map(([subpath, source]) => ({
        find: new RegExp(`^@mono-agent/turn/${subpath}$`),
        replacement: fileURLToPath(new URL(`./src/host/${source}.ts`, import.meta.url)),
      })),
    ],
  },
  test: { exclude: ["**/node_modules/**", "**/dist/**", "**/types/**"] },
}));
