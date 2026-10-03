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
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const marketingRoot = resolve(here, "..");
const outputDir = join(marketingRoot, "output");
const PORT = 4331;
const URL = `http://127.0.0.1:${PORT}/`;

const SHOTS = [
  { name: "consent-synthetic-mobile-390x844.png", width:390, height:844, analytics:true },
  { name: "consent-synthetic-desktop-1440x1000.png", width:1440, height:1000, analytics:true },
  { name: "overview-mobile-390x844.png", width: 390, height: 844, scrollTo: ".agent-map" },
  { name: "overview-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: ".agent-map" },
  { name: "workspace-proof-mobile-390x844.png", width: 390, height: 844, scrollTo: "#why" },
  { name: "workspace-proof-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: "#why" },
  { name: "comparison-mobile-390x844.png", width: 390, height: 844, scrollTo: '#comparison' },
  { name: "comparison-desktop-1440x1000.png", width: 1440, height: 1000, scrollTo: '#comparison' },
  { name: "faq-mobile-390x844.png", width: 390, height: 844, scrollTo: '#faq' },
  {name:"hero-tablet-768x1000.png",width:768,height:1000},
  {name:"blocks-desktop-1440x1000.png",width:1440,height:1000,scrollTo:".building-blocks"},
  {name:"blocks-mobile-390x844.png",width:390,height:844,scrollTo:".building-blocks"},
  {name:"blocks-mobile-430x932.png",width:430,height:932,scrollTo:".building-blocks"},
  { name: "console-desktop-1440x1000.png", width:1440,height:1000,scrollTo:"#console" },
  { name: "console-mobile-390x844.png", width:390,height:844,scrollTo:"#console" },
  { name: "menu-mobile-390x844.png", width:390,height:844,menu:true },
  { name: "hero-desktop-1440x1000.png", width: 1440, height: 1000 },
  { name: "hero-mobile-390x844.png", width: 390, height: 844 },
  { name: "hero-mobile-430x932.png", width: 430, height: 932 },
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

async function makeDeckContactSheet(name, width, height, columns, thumbWidth, thumbHeight) {
  const states = ['stack-initial', 'focused-middle', 'toss-transition', 'final-release'];
  const images = await Promise.all(states.map(state =>
    sharp(join(outputDir, `cards-${state}-${width}x${height}.png`))
      .resize(thumbWidth, thumbHeight, { fit: 'cover' })
      .png()
      .toBuffer()
  ));
  const rows = Math.ceil(images.length / columns);
  await sharp({
    create: { width: thumbWidth * columns, height: thumbHeight * rows, channels: 3, background: '#101211' },
  }).composite(images.map((input, index) => ({
    input,
    left: (index % columns) * thumbWidth,
    top: Math.floor(index / columns) * thumbHeight,
  }))).png().toFile(join(outputDir, name));
  console.log(`contact sheet: ${name}`);
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
      if (process.argv.includes('--overview-assets')) {
        for (const [width, name] of [[1200, 'mono-agent-workspace.png'], [390, 'mono-agent-workspace-mobile.png']]) {
          const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: width < 700 ? 2 : 1 });
          await page.goto(URL, { waitUntil: 'networkidle' });
          await page.evaluate(() => document.fonts.ready);
          await page.locator('.agent-map').screenshot({ path: resolve(marketingRoot, '../docs/assets', name) });
          await page.close();
        }
        return;
      }
      for (const shot of (process.argv.includes("--video-only") ? [] : SHOTS)) {
        const page = await browser.newPage({
          viewport: { width: shot.width, height: shot.height },
        });
        if (shot.analytics) {
          await page.route('**/_vercel/insights/**', route => route.abort());
          await page.route(URL, async route => {
            const response = await route.fetch();
            const body = (await response.text()).replace(/data-analytics-hosts="[^"]*"/, 'data-analytics-hosts="127.0.0.1"');
            await route.fulfill({response, body});
          });
        }
        await page.goto(URL, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
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
        if (shot.scrollTo === '.building-blocks' && [390, 1440].includes(shot.width)) {
          for (const state of [
            { name: 'stack-initial', timeline: 0 },
            { name: 'focused-middle', timeline: 1 },
            { name: 'toss-transition', timeline: 1.55 },
            { name: 'final-release', timeline: 3 },
          ]) {
            await page.locator('.block-summary').evaluate((el,timeline) => {
              const grid=el.querySelector('.block-chapters');
              const bounds=el.getBoundingClientRect();
              const stickyTop=parseFloat(getComputedStyle(grid).top);
              const inset=parseFloat(getComputedStyle(el).paddingTop);
              const travel=el.clientHeight-grid.clientHeight-inset*2;
              scrollTo({top:scrollY+bounds.top+inset-stickyTop+(timeline/3)*travel,behavior:'instant'});
            },state.timeline);
            await page.waitForFunction(index=>document.querySelector('.block-summary')?.dataset.activeCard===String(index),Math.round(state.timeline));
            await page.waitForTimeout(100);
            await page.screenshot({path:join(outputDir,`cards-${state.name}-${shot.width}x${shot.height}.png`)});
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
      if (!process.argv.includes('--video-only')) {
        await makeDeckContactSheet('cards-story-desktop-contact-sheet.png', 1440, 1000, 2, 700, 486);
        await makeDeckContactSheet('cards-story-mobile-contact-sheet.png', 390, 844, 2, 390, 844);
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
          const positionFor = timeline => {
            const grid=layout.querySelector('.block-chapters');
            const bounds=layout.getBoundingClientRect();
            const stickyTop=parseFloat(getComputedStyle(grid).top);
            const inset=parseFloat(getComputedStyle(layout).paddingTop);
            const travel=layout.clientHeight-grid.clientHeight-inset*2;
            return scrollY+bounds.top+inset-stickyTop+(timeline/3)*travel;
          };
          for (const timeline of [0,1,1.55,2,3]) await move(positionFor(timeline), 1100);
          for (const timeline of [2,1,0]) await move(positionFor(timeline), 900);
          await move(scrollY + document.querySelector('#comparison').getBoundingClientRect().top, 1500);
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
