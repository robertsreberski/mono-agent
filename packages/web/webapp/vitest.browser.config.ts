/// <reference types="vitest/config" />
/// <reference types="@vitest/browser/providers/playwright" />

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { sharedSourceAliases } from "./shared-sources";
import type { BrowserCommand } from "vitest/node";
import { searchForWorkspaceRoot } from "vite";
import { defineConfig } from "vitest/config";

type EmulatedColorScheme = "light" | "dark" | null;

// Only the capability suite calls this, and only its opt-in captures need a
// tall runner to avoid scaling the 1900px iframe below its requested CSS width.
const prepareCapabilityScreenshots: BrowserCommand<[]> = async (context) => {
  if (context.provider.name !== "playwright") throw new Error("Playwright required");
  if (process.env.VITE_CAPABILITY_SHOTS) await context.page.setViewportSize({ width: 1440, height: 2000 });
};

const dragVoiceNote: BrowserCommand<[]> = async (context) => {
  if (context.provider.name !== "playwright") throw new Error("Playwright required");
  const bounds = await context.iframe.getByRole("slider", { name: "Seek voice note" }).boundingBox();
  if (!bounds) throw new Error("Voice waveform missing");
  await context.page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2);
  await context.page.mouse.down();
  await context.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 5 });
  await context.page.mouse.up();
};

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
 * dir>`. Add those directories to Vite's file-serving allowlist for artifact
 * retrieval. This controls reads, not screenshot write authority; individual
 * suites decide whether/where to capture evidence.
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

// Real production shell + security middleware, in an isolated automated server.
// Only API data/audio are synthetic; no media method or CSP is mocked.
const checkServerVoicePlayback: BrowserCommand<[object, object, number[]]> = async (context, bootstrap, detail, bytes) => {
  if (context.provider.name !== "playwright") throw new Error("Playwright required");
  // Browser tests run after the package build. Load its actual server rather
  // than importing server sources into the webapp TypeScript project.
  const serverUrl = new URL("../dist/server.js", import.meta.url).href;
  const { startWebServer } = await import(/* @vite-ignore */ serverUrl);
  const cache = new URL("./node_modules/.cache/", import.meta.url);
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(new URL("voice-playback-", cache).pathname);
  let server: { port: number; stop(): Promise<void> } | undefined;
  const browser = await context.page.context().browser()!.newContext({
    serviceWorkers: "block", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  try {
    const handle: NonNullable<typeof server> = await startWebServer({
      port: 0, host: "127.0.0.1", stateDir: join(root, "state"),
      staticDir: new URL("./dist/", import.meta.url).pathname,
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [],
    });
    server = handle;
    const tab = await browser.newPage();
    tab.setDefaultTimeout(5000);
    const violations: string[] = [];
    await tab.exposeFunction("recordMediaViolation", (directive: string) => violations.push(directive));
    await tab.addInitScript(`
      localStorage.setItem("mono-agent.web.selected-agent", "alpha");
      document.addEventListener("securitypolicyviolation", event => {
        if (event.effectiveDirective === "media-src") {
          void window.recordMediaViolation(event.effectiveDirective);
        }
      });
    `);
    await tab.route("**/api/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/content")) {
        await route.fulfill({ body: Buffer.from(bytes), contentType: "application/octet-stream", headers: { "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment" } });
        return;
      }
      const body = path === "/api/v1/bootstrap" ? bootstrap
        : path === "/api/v1/threads/voice-created" ? detail
        : path === "/api/v1/threads" ? { threads: [(detail as { thread: object }).thread] }
        : path === "/api/v1/threads/active" ? { threads: [], total: 0, truncated: false, runningCounts: {} }
        : path.endsWith("/skills") ? { status: "unsupported", items: [] }
        : path.endsWith("/projects") || path.endsWith("/tags") ? []
        : path.endsWith("/events") ? null : {};
      await route.fulfill(body === null
        ? { contentType: "text/event-stream", body: ": synthetic idle\n\n" }
        : { json: body });
    });
    const response = await tab.goto(`http://127.0.0.1:${handle.port}/`);
    const csp = response?.headers()["content-security-policy"];
    if (!csp?.split("; ").includes("media-src 'self' blob:")) throw new Error(`Unexpected shell CSP: ${csp}`);
    // Selecting through the real UI also exercises the production message path.
    await tab.getByRole("button", { name: "Open Synthetic voice conversation", exact: true }).click();
    const play = tab.getByRole("button", { name: /^Play voice note/ });
    for (const control of [play]) {
      const bounds = await control.boundingBox();
      if (!bounds || bounds.width < 44 || bounds.height < 44) throw new Error("Touch target smaller than 44px");
    }
    await play.click();
    const audio = tab.locator(".message-attachments audio");
    await audio.evaluate(async node => {
      const media = node as unknown as { paused: boolean; currentTime: number; src: string; error: { code: number } | null };
      const deadline = Date.now() + 5000;
      while (media.paused || media.currentTime <= 0) {
        if (media.error) throw new Error(`Native audio error ${media.error.code}`);
        if (Date.now() > deadline) throw new Error("Blob audio did not advance");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!media.src.startsWith("blob:")) throw new Error("Expected blob playback");
    });
    if (await tab.getByText("Audio preview unavailable. Try again.", { exact: true }).count()) throw new Error("Voice note entered its error path");
    if (violations.length) throw new Error(`CSP violations: ${violations.join(", ")}`);
    return { csp, played: true, mediaViolations: violations };
  } finally { await browser.close(); await server?.stop(); await rm(root, { recursive: true, force: true }); }
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
        // Tablet layout must exercise real coarse-pointer / no-hover CSS,
        // not just a desktop browser resized to an iPad viewport.
        {
          browser: "chromium",
          name: "chromium-tablet",
          include: ["src/Dashboard.browser.test.tsx"],
          exclude: ["src/**/!(Dashboard).browser.test.tsx"],
          // Keep the runner larger than every tested viewport so screenshots
          // are captured at 1 CSS px per pixel, without iframe downscaling.
          context: { viewport: { width: 1440, height: 1200 }, hasTouch: true },
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
      commands: { prepareCapabilityScreenshots, checkServerVoicePlayback, dragVoiceNote, emulateColorScheme, emulateReducedMotion, saveVoiceFixture },
    },
  },
});
