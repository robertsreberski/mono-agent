/// <reference types="vitest/config" />

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { configDefaults } from "vitest/config";

export default defineConfig({
  base: "/",
  plugins: [
    react(),
    VitePWA({
      // NOT `autoUpdate`: that reloads the page the moment a deploy lands, which
      // on the installed console means losing the transcript on screen -- and a
      // streaming turn with it. The staged build is applied by
      // `service-worker-update.ts` at a moment that costs nothing.
      registerType: "prompt",
      includeAssets: ["icon.svg", "apple-touch-icon.png", "favicon.ico", "notification-sw.js"],
      // The server customizes this public template per host. Keeping manifest
      // generation off also prevents Workbox from precaching a generic copy.
      manifest: false,
      workbox: {
        importScripts: ["notification-sw.js"],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz$/],
        cleanupOutdatedCaches: true
      }
    })
  ],
  server: {
    host: "0.0.0.0",
    port: 5050,
    strictPort: true,
    allowedHosts: [".ts.net"]
  },
  preview: {
    host: "0.0.0.0",
    port: 5050,
    strictPort: true,
    allowedHosts: [".ts.net"]
  },
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;
          if (id.includes("@assistant-ui/react-markdown")) return "markdown";
          // remark-gfm is imported from app code, so without this it would land
          // in the index chunk that rehashes on every UI edit.
          if (/remark-gfm|mdast-util-gfm|micromark-extension-gfm|markdown-table/.test(id)) return "markdown";
          if (id.includes("@assistant-ui")) return "assistant-ui";
          return undefined;
        }
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: [...configDefaults.exclude, "**/*.browser.test.tsx"],
    css: true
  }
});
