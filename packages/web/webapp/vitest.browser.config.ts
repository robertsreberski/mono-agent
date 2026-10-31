/// <reference types="vitest/config" />
/// <reference types="@vitest/browser/providers/playwright" />

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { sharedSourceAliases } from "./shared-sources";
import type { BrowserCommand } from "vitest/node";
import { searchForWorkspaceRoot } from "vite";
import { defineConfig } from "vitest/config";

type EmulatedColorScheme = "light" | "dark" | null;

const emulateReducedMotion: BrowserCommand<["reduce" | "no-preference" | null]> = async (context, reducedMotion) => {
  if (context.provider.name !== "playwright") throw new Error("emulateReducedMotion requires Playwright");
  await context.page.emulateMedia({ reducedMotion });
};

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

// Opt-in artifact from the real synthetic Chromium microphone, for built-dist smoke.
const saveVoiceFixture: BrowserCommand<[number[]]> = async (_context, bytes) => {
  const directory = process.env.VITE_VOICE_SHOTS;
  if (!directory) return;
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error("Invalid synthetic voice fixture size");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "chromium-synthetic-recording.webm"), Buffer.from(bytes));
};

export default defineConfig({
  resolve: { alias: sharedSourceAliases },
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
      instances: [
        {
          browser: "chromium",
          name: "chromium",
          launch: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
          provide: { providerUsageTouch: false },
          context: { viewport: { width: 1440, height: 1000 }, hasTouch: false },
        },
        // Local iOS-engine coverage without requiring WebKit in the existing
        // Chromium-only CI/standalone installation: WEBAPP_TEST_WEBKIT=1.
        ...(process.env.WEBAPP_TEST_WEBKIT === "1" ? [{
          browser: "webkit" as const,
          name: "webkit-chat",
          include: ["src/components/Chat.browser.test.tsx", "src/VoiceConversation.browser.test.tsx"],
          exclude: ["src/**/!(Chat|VoiceConversation).browser.test.tsx"],
          context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
        }] : []),
        // Instance include patterns merge with the suite's include; explicitly
        // exclude other files so only this regression gets a second context.
        {
          browser: "chromium",
          name: "chromium-touch",
          include: ["src/components/ProviderUsage.browser.test.tsx", "src/components/agent-settings/ProvidersSection.browser.test.tsx"],
          exclude: ["src/**/!(ProviderUsage|ProvidersSection).browser.test.tsx"],
          provide: { providerUsageTouch: true },
          context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
        },
      ],
      commands: { emulateColorScheme, emulateReducedMotion, saveVoiceFixture },
    },
  },
});
