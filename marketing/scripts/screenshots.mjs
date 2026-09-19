// Capture viewport screenshots for human review (not a test gate).
//
// Serves the production build via `astro preview`, screenshots desktop
// 1440x1000 and mobile 390x844 viewports into marketing/output/, then stops
// the server. Viewport-only captures (never full-page) so every dimension
// stays <= 2000px.
//
//   pnpm run build && pnpm run screenshots
//
// Requires the Playwright Chromium browser (`pnpm exec playwright install
// chromium`). Output is gitignored; the parent copies it for review.
import { spawn } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const marketingRoot = resolve(here, "..");
const outputDir = join(marketingRoot, "output");
const PORT = 4331;
const URL = `http://127.0.0.1:${PORT}/`;

const SHOTS = [
  ...[0, 0.33, 0.67, 1].map((story, i) => ({ name: `anatomy-${i + 1}-desktop-1440x1000.png`, width: 1440, height: 1000, story })),
  ...[0.33, 0.67].map((story, i) => ({ name: `anatomy-${i + 2}-mobile-390x844.png`, width: 390, height: 844, story })),
  { name: "research-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: ".workflow-explorer", workflow: "research" },
  { name: "research-mobile-390x844.png", width: 390, height: 844, scrollTo: ".workflow-explorer", workflow: "research" },
  { name: "automate-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: ".workflow-explorer", workflow: "automate" },
  { name: "hero-desktop-1440x1000.png", width: 1440, height: 1000 },
  { name: "hero-mobile-390x844.png", width: 390, height: 844 },
  {
    name: "usecases-desktop-1440x1000.png",
    width: 1440,
    height: 1000,
    scrollTo: "#use-cases",
  },
  {
    name: "usecases-mobile-390x844.png",
    width: 390,
    height: 844,
    scrollTo: "#use-cases",
  },
  { name: "config-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: ".config-story" },
  { name: "config-mobile-390x844.png", width: 390, height: 844, scrollTo: ".config-story" },
  {
    name: "start-desktop-1440x1000.png",
    width: 1440,
    height: 1000,
    scrollTo: "#start",
  },
  {
    name: "start-mobile-390x844.png",
    width: 390,
    height: 844,
    scrollTo: "#start",
  },
];

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server never came up at ${url}`);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const server = spawn(
    "pnpm",
    ["exec", "astro", "preview", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: marketingRoot, stdio: "pipe" },
  );
  try {
    await waitForServer(URL);
    const browser = await chromium.launch();
    try {
      for (const shot of (process.argv.includes("--video-only") ? [] : SHOTS)) {
        const page = await browser.newPage({
          viewport: { width: shot.width, height: shot.height },
        });
        await page.goto(URL, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
        if (shot.workflow) {
          await page.locator(`[data-workflow="${shot.workflow}"]`).click();
          await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
        }
        if (shot.scrollTo) {
          // Instant jump: the site enables smooth scroll-behavior, which
          // would otherwise leave the capture mid-flight.
          await page.evaluate((selector) => {
            document
              .querySelector(selector)
              ?.scrollIntoView({ behavior: "instant", block: "start" });
          }, shot.scrollTo);
          await page.waitForTimeout(400);
        }
        if (shot.story !== undefined) {
          await page.evaluate((progress) => {
            const rect = document.querySelector('.story-layout').getBoundingClientRect();
            window.scrollTo({ top: scrollY + rect.top + (rect.height - innerHeight) * progress, behavior: 'instant' });
          }, shot.story);
          await page.waitForTimeout(150);
        }
        await page.screenshot({ path: join(outputDir, shot.name) });
        console.log(`screenshots: ${shot.name}`);
        await page.close();
      }
      if (process.argv.includes('--video') || process.argv.includes('--video-only')) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          recordVideo: { dir: outputDir, size: { width: 1440, height: 1000 } },
        });
        const page = await context.newPage();
        await page.goto(URL, { waitUntil: 'networkidle' });
        await page.evaluate(async () => {
          const move = (to, duration) => new Promise(resolve => {
            const from = scrollY;
            let start;
            function step(now) {
              start ??= now;
              const t = Math.min(1, (now - start) / duration);
              window.scrollTo({ top: from + (to - from) * t, behavior: 'instant' });
              if (t < 1) requestAnimationFrame(step); else resolve();
            }
            requestAnimationFrame(step);
          });
          await move(0, 1200);
          const layout = document.querySelector('.story-layout');
          const start = scrollY + layout.getBoundingClientRect().top;
          await move(start, 2200);
          await move(start + layout.getBoundingClientRect().height - innerHeight, 15000);
          await move(scrollY + document.querySelector('#use-cases').getBoundingClientRect().top, 1500);
          await move(scrollY, 1200);
        });
        const video = page.video();
        await context.close();
        await rename(await video.path(), join(outputDir, 'scroll-story-desktop.webm'));
        console.log('recording: scroll-story-desktop.webm (automated real browser capture)');
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
}

await main();
