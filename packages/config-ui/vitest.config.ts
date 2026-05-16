import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// vitest config (separate from vite build config because the test root is the
// whole package, not the SPA root).
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": resolve(here, "src/client"),
    },
  },
  plugins: [react()],
  test: {
    // Default to node; .tsx tests opt into happy-dom via the
    //   // @vitest-environment happy-dom
    // pragma at the top of the file.
    environment: "node",
    globals: false,
    setupFiles: [resolve(here, "src/client/test-setup.ts")],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
