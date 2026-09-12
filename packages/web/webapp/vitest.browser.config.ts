/// <reference types="vitest/config" />
/// <reference types="@vitest/browser/providers/playwright" />

import react from "@vitejs/plugin-react";
import type { BrowserCommand } from "vitest/node";
import { searchForWorkspaceRoot } from "vite";
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

/**
 * Screenshot evidence is opt-in per suite through `VITE_<SUITE>_SHOTS=<absolute
 * dir>`. Vite only lets the browser runner write inside the project, so each
 * opted-in directory is allowed explicitly; without the variables nothing is
 * allowed beyond the default and nothing is written.
 */
const screenshotDirectories = Object.entries(process.env)
  .filter(([name, value]) => /^VITE_[A-Z0-9_]+_SHOTS$/u.test(name) && value !== undefined && value.length > 0)
  .map(([, value]) => value as string);

export default defineConfig({
  plugins: [react()],
  ...(screenshotDirectories.length === 0 ? {} : { server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...screenshotDirectories] } } }),
  test: {
    include: ["src/**/*.browser.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    browser: {
      enabled: true,
      headless: true,
      provider: "playwright",
      screenshotFailures: false,
      instances: [{ browser: "chromium", context: { viewport: { width: 1440, height: 1000 } } }],
      commands: { emulateColorScheme },
    },
  },
});
