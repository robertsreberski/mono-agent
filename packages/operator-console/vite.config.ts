import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, "src/client"),
  resolve: {
    alias: {
      "@": resolve(here, "src/client"),
    },
  },
  build: {
    outDir: resolve(here, "dist/spa"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  plugins: [react(), tailwindcss()],
});
