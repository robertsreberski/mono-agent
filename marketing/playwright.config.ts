import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.spec.ts",
  outputDir: ".astro/playwright-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4330",
    trace: "retain-on-failure",
  },
  projects: [
    ...(process.env.MARKETING_WEBKIT === "1"
      ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }]
      : []),
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm exec astro preview --host 127.0.0.1 --port 4330",
    url: "http://127.0.0.1:4330",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
