/// <reference types="vitest/config" />

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.browser.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    browser: {
      enabled: true,
      headless: true,
      provider: "playwright",
      screenshotFailures: false,
      instances: [{ browser: "chromium" }],
    },
  },
});
