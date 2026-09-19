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
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const marketingRoot = resolve(here, "..");
const outputDir = join(marketingRoot, "output");
const PORT = 4331;
const URL = `http://127.0.0.1:${PORT}/`;

const SHOTS = [
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
      for (const shot of SHOTS) {
        const page = await browser.newPage({
          viewport: { width: shot.width, height: shot.height },
        });
        await page.goto(URL, { waitUntil: "networkidle" });
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
        await page.screenshot({ path: join(outputDir, shot.name) });
        console.log(`screenshots: ${shot.name}`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
}

await main();
