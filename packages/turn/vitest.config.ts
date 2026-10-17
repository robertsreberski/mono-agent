import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import rootConfig from "../../vitest.config.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  name: string;
  exports: Record<string, { default: string }>;
  imports: Record<string, { default: string }>;
};
function authored(target: string) {
  const source = resolve(directory, target.replace(/^\.\/dist\//u, "./src/"));
  const typed = source.replace(/\.js$/u, ".ts");
  return existsSync(typed) ? typed : source;
}

// One authored module identity in source tests. Real Node/packed proofs never
// use these aliases, and removed package paths remain absent from the map.
export default mergeConfig(rootConfig, defineConfig({
  root: directory,
  plugins: [{
    name: "turn-authored-twins",
    enforce: "pre",
    resolveId(specifier, importer) {
      if (!importer?.startsWith(resolve(directory, "src")) || !specifier.startsWith(".") || !specifier.endsWith(".js")) return;
      const twin = resolve(dirname(importer), specifier).replace(/\.js$/u, ".ts");
      if (existsSync(twin)) return twin;
    },
  }],
  resolve: {
    alias: [
      ...Object.entries(manifest.exports).map(([key, target]) => ({
        find: new RegExp(`^${key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`}$`.replaceAll(".", "\\.")),
        replacement: authored(target.default),
      })),
      ...Object.entries(manifest.imports).map(([key, target]) => ({
        find: new RegExp(`^${key}$`),
        replacement: authored(target.default),
      })),
    ],
  },
  test: { exclude: ["**/node_modules/**", "**/dist/**", "**/types/**"] },
}));
