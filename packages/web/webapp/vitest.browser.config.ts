/// <reference types="vitest/config" />
/// <reference types="@vitest/browser/providers/playwright" />

import react from "@vitejs/plugin-react";
import type { BrowserCommand } from "vitest/node";
import { defineConfig } from "vitest/config";

type EmulatedColorScheme = "light" | "dark" | null;

const emulateColorScheme: BrowserCommand<[EmulatedColorScheme]> = async (context, colorScheme) => {
  if (context.provider.name !== "playwright") {
    throw new Error(`emulateColorScheme requires Playwright, received ${context.provider.name}`);
  }
  if (colorScheme !== null && colorScheme !== "light" && colorScheme !== "dark") {
    throw new Error(`Unsupported color scheme: ${String(colorScheme)}`);
  }
  await context.page.emulateMedia({ colorScheme });
};

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
      commands: { emulateColorScheme },
    },
  },
});
