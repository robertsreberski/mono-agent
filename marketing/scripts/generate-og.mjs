// Regenerate the 1200x630 social card from the built homepage itself, so the
// card always shows the real design (masthead, headline and the folder note).
//
//   pnpm run build && pnpm run assets
//
// Serves dist/ with `astro preview`, captures the top of `/` in Chromium
// (light scheme, reduced motion, fonts loaded) and writes a JPEG to
// public/og-1200x630.jpg. Rebuild afterwards so dist/ carries the new card.
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import sharp from "sharp";

const marketingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4332;
const ORIGIN = `http://127.0.0.1:${PORT}`;
// Capture a 1.9:1 window wider than the card, then downscale, so the cover
// keeps its two-column desktop composition.
const CAPTURE = { width: 1440, height: 756 };

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview server did not start at ${url}`);
}

const server = spawn("pnpm", ["exec", "astro", "preview", "--host", "127.0.0.1", "--port", String(PORT)], {
  cwd: marketingRoot,
  stdio: "ignore",
});
try {
  await waitForServer(`${ORIGIN}/`);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: CAPTURE,
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
    });
    const shot = await page.screenshot({ clip: { x: 0, y: 0, ...CAPTURE } });
    const out = join(marketingRoot, "public/og-1200x630.jpg");
    await sharp(shot).resize(1200, 630).jpeg({ quality: 82, mozjpeg: true }).toFile(out);
    console.log(`Wrote ${out}`);
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
