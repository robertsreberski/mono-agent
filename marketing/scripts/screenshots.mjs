// Capture section screenshots for human review (not a test gate).
//
// Serves the production build via `astro preview` and captures each homepage
// section plus the blog, a post and the privacy page, in light and dark, at
// phone and desktop widths, into marketing/output/ (gitignored). Element and
// viewport captures only, so no dimension exceeds 2000px.
//
//   pnpm run build && pnpm run screenshots            # Chromium
//   pnpm run screenshots -- --webkit                  # also WebKit
//
// Requires Playwright browsers (`pnpm exec playwright install chromium`).
// The consent shots override the allowed analytics host locally and abort
// every provider request; no live analytics is used.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "@playwright/test";

const marketingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(marketingRoot, "output");
const PORT = 4331;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const SECTIONS = [
  ["masthead", ".masthead"],
  ["cover", ".cover"],
  ["folder", "#plate-i"],
  ["models", "#plate-ii"],
  ["console", "#plate-iii"],
  ["memory", "#plate-iv"],
  ["tools", "#plate-v"],
  ["setup", ".tear-off"],
  ["colophon", ".colophon"],
];
const WIDTHS = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1440, height: 1000 },
];
const READING = [
  ["blog", "/blog/"],
  ["post", "/blog/routing-agent-work-across-ai-subscriptions/"],
  ["privacy", "/privacy/"],
];

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server never came up at ${url}`);
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter((img) => img.loading !== "lazy").map((img) => img.decode().catch(() => {})));
  });
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
}

async function capture(browserName, browser) {
  for (const colorScheme of ["light", "dark"]) {
    for (const viewport of WIDTHS) {
      const context = await browser.newContext({ viewport, colorScheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      const tag = `${browserName}-${colorScheme}-${viewport.width}`;
      await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
      await settle(page);
      for (const [name, selector] of SECTIONS) {
        await page.locator(selector).screenshot({ path: join(outputDir, `home-${name}-${tag}.png`) });
      }
      // The explorer with a file open (desktop tree or phone drill-down).
      if (viewport.width > 660) {
        await page.locator('.tree-item[data-key="mono-agent.config.json"] > .folder-row').click();
      } else {
        await page.locator('.folder-nav button[data-key="mono-agent.config.json"]').click();
      }
      await page.locator("#plate-i").screenshot({ path: join(outputDir, `home-folder-open-${tag}.png`) });
      for (const [name, path] of READING) {
        await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle" });
        await settle(page);
        await page.screenshot({ path: join(outputDir, `${name}-${tag}.png`) });
      }
      await context.close();
      console.log(`screenshots: ${tag}`);
    }
  }
  for (const viewport of [WIDTHS[1], WIDTHS[3]]) {
    const page = await browser.newPage({ viewport });
    await page.route("**/_vercel/insights/**", (route) => route.abort());
    await page.route(`${ORIGIN}/`, async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/data-analytics-hosts="[^"]*"/, 'data-analytics-hosts="127.0.0.1"');
      await route.fulfill({ response, body });
    });
    await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
    await settle(page);
    await page.screenshot({ path: join(outputDir, `consent-synthetic-${browserName}-${viewport.width}.png`) });
    await page.close();
  }
}

await mkdir(outputDir, { recursive: true });
const server = spawn("pnpm", ["exec", "astro", "preview", "--host", "127.0.0.1", "--port", String(PORT)], {
  cwd: marketingRoot,
  stdio: "ignore",
});
try {
  await waitForServer(`${ORIGIN}/`);
  const engines = [["chromium", chromium], ...(process.argv.includes("--webkit") ? [["webkit", webkit]] : [])];
  for (const [name, engine] of engines) {
    const browser = await engine.launch();
    try {
      await capture(name, browser);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.kill();
}
