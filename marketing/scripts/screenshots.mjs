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
  {name:"hero-tablet-768x1000.png",width:768,height:1000},
  {name:"blocks-desktop-1440x1000.png",width:1440,height:1000,scrollTo:".building-blocks"},
  {name:"blocks-mobile-390x844.png",width:390,height:844,scrollTo:".building-blocks"},
  {name:"blocks-mobile-430x932.png",width:430,height:932,scrollTo:".building-blocks"},
  { name: "console-desktop-1440x1000.png", width:1440,height:1000,scrollTo:"#console" },
  { name: "console-mobile-390x844.png", width:390,height:844,scrollTo:"#console" },
  { name: "menu-mobile-390x844.png", width:390,height:844,menu:true },
  { name: "research-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: ".workflow-explorer", workflow: "research" },
  { name: "research-mobile-390x844.png", width: 390, height: 844, scrollTo: ".workflow-explorer", workflow: "research" },
  { name: "automate-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: ".workflow-explorer", workflow: "automate" },
  { name: "hero-desktop-1440x1000.png", width: 1440, height: 1000 },
  { name: "hero-mobile-390x844.png", width: 390, height: 844 },
  { name: "hero-mobile-430x932.png", width: 430, height: 932 },
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
  { name: "configuration-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: "#configuration" },
  { name: "configuration-mobile-390x844.png", width: 390, height: 844, scrollTo: "#configuration" },
  { name: "configuration-mobile-430x932.png", width: 430, height: 932, scrollTo: "#configuration" },
  { name: "configuration-code-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: ".config-blueprint" },
  { name: "configuration-code-mobile-390x844.png", width: 390, height: 844, scrollTo: ".config-blueprint" },
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
        if (shot.scrollTo === '.building-blocks') {
          for (const index of [0,1,2,3]) {
            await page.locator('.block-summary').evaluate((el,index) => {
              const bounds=el.getBoundingClientRect();
              const progress=(index+.5)/4;
              const targetTop=innerHeight*.78-progress*(bounds.height+innerHeight*.38);
              scrollTo({top:scrollY+bounds.top-targetTop,behavior:'instant'});
            },index);
            await page.waitForFunction(index=>document.querySelector('.block-summary')?.dataset.activeCard===String(index),index);
            await page.waitForTimeout(100);
            await page.screenshot({path:join(outputDir,`cards-focus-${index+1}-${shot.width}x${shot.height}.png`)});
          }
          await page.locator('.building-blocks').evaluate(el=>el.scrollIntoView({behavior:'instant'}));
          await page.waitForTimeout(100);
        }
        if (shot.menu) await page.getByRole('button', {name:'Menu'}).click();
        await page.screenshot({ path: join(outputDir, shot.name) });
        console.log(`screenshots: ${shot.name}`);
        if (shot.name === "hero-mobile-390x844.png") console.log("mobile document height:", await page.evaluate(()=>document.documentElement.scrollHeight));
        if (shot.scrollTo === ".building-blocks") {
          console.log(`cards metrics ${shot.width}px:`, await page.evaluate(() => ({
            sectionHeight: Math.round(document.querySelector('.building-blocks').getBoundingClientRect().height),
            cardsHeight: Math.round(document.querySelector('.block-summary').getBoundingClientRect().height),
            activeCard: document.querySelector('.block-summary').dataset.activeCard,
            bodyFont: getComputedStyle(document.body).fontSize,
            cardFont: getComputedStyle(document.querySelector('.block-chapter>p')).fontSize,
            cardLinkFont: getComputedStyle(document.querySelector('.block-links a')).fontSize,
          })));
        }
        await page.close();
      }
      if (process.argv.includes('--video') || process.argv.includes('--video-only')) {
        for (const viewport of [{width:1440,height:1000,name:"desktop"},{width:390,height:844,name:"mobile"}]) {
        const context = await browser.newContext({
          viewport,
          recordVideo: { dir: outputDir, size: { width: viewport.width, height: viewport.height } },
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
          const layout = document.querySelector('.block-summary');
          const positionFor = index => {
            const bounds=layout.getBoundingClientRect();
            const progress=(index+.5)/4;
            const targetTop=innerHeight*.78-progress*(bounds.height+innerHeight*.38);
            return scrollY+bounds.top-targetTop;
          };
          for (const index of [0,1,2,3]) await move(positionFor(index), 1400);
          for (const index of [2,1,0]) await move(positionFor(index), 1100);
          await move(scrollY + document.querySelector('#use-cases').getBoundingClientRect().top, 1500);
          await move(scrollY, 1200);
        });
        const video = page.video();
        await context.close();
        await rename(await video.path(), join(outputDir, `scroll-story-${viewport.name}.webm`));
        console.log(`recording: scroll-story-${viewport.name}.webm (automated real browser capture)`);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
}

await main();
