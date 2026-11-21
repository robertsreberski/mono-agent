// Browser contracts for the built homepage ("The coworker in a folder"):
// accessibility (axe, WCAG 2.0/2.1 A+AA and 2.2 AA) in both colour schemes,
// phone and desktop layout, the example-folder explorer, copy buttons,
// console annotations, reduced motion, no-JavaScript fallbacks, and a clean
// network/console record on every page.
//
// Runs against `astro preview` on 127.0.0.1:4330 (see playwright.config.ts):
//   pnpm run build && pnpm run test:browser
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SCHEMES = ["light", "dark"] as const;
const EXAMPLE = new URL("../src/example-agent/", import.meta.url);
const manifest: Array<{ path: string; kind: string }> = JSON.parse(readFileSync(new URL("manifest.json", EXAMPLE), "utf8"));
const FILES = manifest.filter((entry) => entry.kind === "file").map((entry) => entry.path);
const DIRS = manifest.filter((entry) => entry.kind === "dir").map((entry) => entry.path);
const exact = (path: string) => readFileSync(new URL(`payments-maintainer/${path}`, EXAMPLE), "utf8");

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter((img) => img.loading !== "lazy").map((img) => img.decode().catch(() => {})));
  });
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"), null, { timeout: 5000 });
}

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
}

for (const colorScheme of SCHEMES) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test.describe(`${colorScheme} ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport, colorScheme });

      test("has no WCAG A/AA violations, including with a file open", async ({ page }) => {
        const response = await page.goto("/", { waitUntil: "networkidle" });
        expect(response?.ok()).toBe(true);
        await settle(page);
        await axe(page, "initial");
        if (viewport.width > 660) {
          await page.locator('.tree-item[data-key="mono-agent.config.json"] > .folder-row').click();
        } else {
          await page.locator('.folder-nav button[data-key="skills"]').click();
          await page.locator('.folder-nav button[data-key="skills/triage"]').click();
          await page.locator('.folder-nav button[data-key="skills/triage/SKILL.md"]').click();
        }
        await expect(page.locator(".file-text")).toBeVisible();
        await axe(page, "file open");
      });

      test("keeps both cover tabs fully inside the first viewport", async ({ page }) => {
        await page.goto("/", { waitUntil: "networkidle" });
        await settle(page);
        for (const name of ["Build your first agent", "View on GitHub"]) {
          const box = await page.locator(".start").getByRole("link", { name }).boundingBox();
          expect(box, name).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.y).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
          expect(box!.y + box!.height, `${name} bottom`).toBeLessThanOrEqual(viewport.height);
        }
        await expect(page.getByRole("heading", { level: 1, name: "The coworker in a folder" })).toBeVisible();
      });
    });
  }

  test(`${colorScheme}: no horizontal overflow from 320px to desktop`, async ({ browser }) => {
    for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      const page = await context.newPage();
      await page.goto("/", { waitUntil: "networkidle" });
      await settle(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px`).toBeLessThanOrEqual(width);
      await expect(page.locator(".folder-window")).toBeVisible();
      await expect(page.locator(".selection > div")).toHaveCount(5);
      await context.close();
    }
  });
}

for (const width of [375, 430]) {
  test(`cover tabs are visible without scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });
    await settle(page);
    const bottom = await page.locator(".start").evaluate((el) => el.getBoundingClientRect().bottom);
    expect(bottom).toBeLessThanOrEqual(844);
  });
}

test("exposes landmarks, one H1, and a working skip link", async ({ page, browserName }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
  await expect(page.getByRole("banner")).toBeAttached();
  await expect(page.getByRole("main")).toBeAttached();
  await expect(page.getByRole("contentinfo")).toBeAttached();
  await expect(page.getByRole("navigation", { name: "Project links" })).toBeVisible();

  const skipLink = page.getByRole("link", { name: "Skip to content" });
  // Real keyboard tab (not script focus) so :focus-visible applies.
  // macOS WebKit follows Safari’s link-navigation preference: Option+Tab visits links.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(skipLink).toBeFocused();
  await expect.poll(() => skipLink.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  await skipLink.press("Enter");
  expect(new URL(page.url()).hash).toBe("#main");
});

test("numbered sections are deep-linkable, also with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const id of ["plate-i", "plate-iii", "plate-v"]) {
    await page.goto(`/#${id}`, { waitUntil: "networkidle" });
    await expect(page.locator(`#${id} h2`)).toBeInViewport();
  }
});

test("the arriving note respects reduced motion", async ({ browser }) => {
  for (const [reducedMotion, expected] of [["reduce", "none"], ["no-preference", "slip-arrives"]] as const) {
    const context = await browser.newContext({ reducedMotion, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto("/");
    expect(await page.locator(".note-slip").evaluate((el) => getComputedStyle(el).animationName)).toBe(expected);
    await context.close();
  }
});

test("without JavaScript the folder, setup and links stay complete", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Project links" })).toBeVisible();
  await expect(page.locator(".folder-window")).toBeHidden();
  await expect(page.locator(".folder-fallback details[data-kind]")).toHaveCount(manifest.length);
  await expect(page.locator('.folder-fallback details[data-kind="private"]')).toHaveCount(2);
  const config = page.locator('.folder-fallback details[data-path="mono-agent.config.json"]');
  await config.locator("summary").click();
  await expect(config.locator("pre code")).toHaveText(exact("mono-agent.config.json"));
  await expect(page.locator(".copy-command")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Copy/ })).toHaveCount(0);
  const windows = page.locator(".windows-note");
  await windows.locator("summary").click();
  await expect(windows).toHaveAttribute("open", "");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Blog" })).toBeVisible();
  await context.close();
});

test("installer extension routes serve static shell bytes without a trailing-slash redirect", async ({ request }) => {
  const response = await request.get('/install.sh', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers().location).toBeUndefined();
  expect(await response.text()).toMatch(/^#!\/bin\/sh\n/);
  const checksum = await request.get('/install.sh.sha256', { maxRedirects: 0 });
  expect(checksum.status()).toBe(200);
  expect(await checksum.text()).toMatch(/^[a-f0-9]{64}  install\.sh\n$/);
});

test("config schema route serves static JSON without a trailing-slash redirect", async ({ request }) => {
  // astro preview does not apply vercel.json headers; tests/schema.test.mjs pins those.
  const response = await request.get('/schema.json', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers().location).toBeUndefined();
  expect(response.headers()['content-type']).toMatch(/^application\/json/);
  const schema = await response.json();
  expect(schema.$id).toBe('https://mono-agent.dev/schema.json');
  expect(schema.title).toBe('mono-agent.config.json');
});

test.describe("copy buttons", () => {
  const INSTALL = "curl -fsSL https://mono-agent.dev/install.sh | sh";

  test("report success only after the clipboard resolves", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => { (window as any).copied = text; } },
    }));
    await page.goto("/");
    await page.getByRole("button", { name: "Copy install command" }).click();
    await expect(page.locator(".copy-status")).toHaveText("Copied");
    await expect(page.getByRole("button", { name: "Copy install command" })).toHaveText("Copied");
    expect(await page.evaluate(() => (window as any).copied)).toBe(INSTALL);
    await page.getByRole("button", { name: "Copy init command" }).click();
    expect(await page.evaluate(() => (window as any).copied)).toBe("mono-agent init");
  });

  test("fall back to a legacy copy when the clipboard refuses", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } } });
      document.execCommand = () => true;
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Copy install command" }).click();
    await expect(page.locator(".copy-status")).toHaveText("Copied");
  });

  test("select the command when nothing can copy", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } } });
      document.execCommand = () => false;
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Copy install command" }).click();
    await expect(page.locator(".copy-status")).toHaveText("Couldn’t copy — the command is selected");
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(INSTALL);
    await expect(page.getByRole("button", { name: "Copy install command" })).toBeEnabled();
  });

  test("handle a missing Clipboard API honestly", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined });
      document.execCommand = () => false;
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Copy init command" }).click();
    await expect(page.locator(".copy-status")).toHaveText("Couldn’t copy — the command is selected");
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("mono-agent init");
  });
});

// The prototype's tap-target audit: every visible control on the homepage.
for (const width of [320, 375, 390, 430]) {
  test(`controls are at least 44px tap targets at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });
    await settle(page);
    const small = await page.evaluate(() => {
      const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible";
      return [...document.querySelectorAll("a, button, summary")]
        .filter((el) => visible(el) && !el.closest("[hidden]"))
        .map((el) => ({ text: el.textContent!.trim().slice(0, 40), box: el.getBoundingClientRect() }))
        .filter(({ box }) => box.width && box.height && (box.height < 43.98 || box.width < 43.98))
        .map(({ text, box }) => `${text} ${box.width.toFixed(1)}x${box.height.toFixed(1)}`);
    });
    expect(small).toEqual([]);
    expect((await page.locator(".masthead").boundingBox())!.height).toBeLessThan(110);
  });
}

test.describe("console annotations", () => {
  test("desktop callout points at the switch without covering the intro", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/#plate-iii", { waitUntil: "networkidle" });
    await settle(page);
    const m = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const raster = box(".capture img"), label = box(".switch-callout span"), tip = box(".switch-tip");
      const introText = [...document.querySelector(".console-intro")!.children].flatMap((el) => {
        const range = new Range(); range.selectNodeContents(el); return [...range.getClientRects()];
      });
      return {
        overlaps: introText.some((b) => b.right > label.left && b.left < label.right && b.bottom > label.top && b.top < label.bottom),
        labelGap: raster.top - label.bottom,
        tipDelta: tip.top + tip.height / 2 - (raster.top + raster.height * 0.426),
        tipEdge: tip.left - raster.right,
        leaderGap: box(".handset").left - raster.right - box(".switch-callout svg").width,
      };
    });
    expect(m.overlaps).toBe(false);
    expect(m.labelGap).toBeGreaterThan(3);
    expect(Math.abs(m.tipDelta)).toBeLessThan(1);
    expect(m.tipEdge).toBeGreaterThanOrEqual(-0.01);
    expect(m.leaderGap).toBeGreaterThanOrEqual(5.5);
  });

  for (const width of [320, 390, 430]) {
    test(`phone legend badges line up with the conversation at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#plate-iii", { waitUntil: "networkidle" });
      await settle(page);
      const m = await page.evaluate(() => {
        const screen = document.querySelector(".handset-screen img")!.getBoundingClientRect();
        const painted = Math.min(screen.height, (screen.width * 1920) / 1032);
        const points = [0.428, 0.48, 0.951].map((y) => screen.top + y * painted);
        const badges = [...document.querySelectorAll(".handset-rail > span")].map((el, i) => {
          const b = el.getBoundingClientRect();
          return { delta: (b.top + b.bottom) / 2 - points[i], left: b.left, top: b.top, bottom: b.bottom };
        });
        return { right: screen.right, badges, legend: [...document.querySelectorAll(".phone-legend li p")].map((el) => el.textContent) };
      });
      for (const badge of m.badges) {
        expect(Math.abs(badge.delta)).toBeLessThan(5);
        expect(badge.left).toBeGreaterThanOrEqual(m.right);
      }
      expect(m.badges[1].top).toBeGreaterThan(m.badges[0].bottom);
      expect(m.legend).toEqual(["Same conversation, picked up on the phone.", "Switched from Opus to Sol mid‑conversation.", "The next message goes to Sol."]);
    });
  }

  test("each colour scheme loads its own real console capture", async ({ browser }) => {
    for (const colorScheme of SCHEMES) {
      const context = await browser.newContext({ colorScheme, viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator(".console-plate .figure-head")).toContainText("Real console, example conversation");
      expect(await page.locator(".capture img").evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(new RegExp(`folder-console-${colorScheme}\\.webp$`));
      expect(await page.locator(".handset-screen img").evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(new RegExp(`folder-console-phone-${colorScheme}\\.webp$`));
      await context.close();
    }
  });
});

test.describe("example folder explorer", () => {
  test("desktop tree shows every file byte-for-byte", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    await expect(page.locator('.folder-tree[role="tree"]')).toBeVisible();
    for (const dir of DIRS) await page.locator(`.tree-item[data-key="${dir}"] > .folder-row`).click();
    for (const path of FILES) {
      await page.locator(`.tree-item[data-key="${path}"] > .folder-row`).click();
      await expect(page.locator(`.tree-item[data-key="${path}"]`)).toHaveAttribute("aria-selected", "true");
      expect(await page.locator(".file-text code").textContent(), path).toBe(exact(path));
    }
    await expect(page.locator(".folder-private")).toContainText("Kept on your machine");
  });

  test("desktop tree follows the ARIA tree keyboard pattern", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    const item = (key: string) => page.locator(`.tree-item[data-key="${key}"]`);
    await item("IDENTITY.md").focus();
    await page.keyboard.press("ArrowDown");
    await expect(item("cron")).toBeFocused();
    await expect(item("cron")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ArrowRight");
    await expect(item("cron")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowDown");
    await expect(item("cron/morning-check.md")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(item("cron/morning-check.md")).toHaveAttribute("aria-selected", "true");
    expect(await page.locator(".file-text code").textContent()).toBe(exact("cron/morning-check.md"));
    await page.keyboard.press("ArrowLeft");
    await expect(item("cron")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(item("cron")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("End");
    await expect(item(".gitignore")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(item("IDENTITY.md")).toBeFocused();
    expect(await page.locator('.tree-item[tabindex="0"]').count()).toBe(1);
  });

  for (const width of [320, 390]) {
    test(`phone drill-down shows every file and returns focus at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      for (const path of FILES) {
        const chain = path.split("/");
        let prefix = "";
        for (const part of chain) {
          prefix = prefix ? `${prefix}/${part}` : part;
          const row = page.locator(`.folder-nav button[data-key="${prefix}"]`);
          if (!(await row.isVisible())) await page.locator(".more-files > summary").click();
          await row.click();
        }
        expect(await page.locator(".file-text code").textContent(), path).toBe(exact(path));
        const fits = await page.locator(".file-text").evaluate((el) => {
          const range = new Range(); range.selectNodeContents(el);
          const max = el.getBoundingClientRect().right;
          return [...range.getClientRects()].every((rect) => rect.right < max + 0.75);
        });
        expect(fits, `${path} wraps inside the sheet`).toBe(true);
        await expect(page.locator(".folder-view .explorer-back").first()).toContainText("Back to");
        for (const _ of chain) await page.locator(".folder-window :not([hidden]) > .explorer-back").first().click();
        expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe(chain[0]);
      }
    });
  }
});

test("uses the self-hosted field-manual typefaces", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const families = await page.evaluate(() => ({
    h1: getComputedStyle(document.querySelector("h1")!).fontFamily,
    body: getComputedStyle(document.querySelector(".deck")!).fontFamily,
    code: getComputedStyle(document.querySelector(".sheet-text pre")!).fontFamily,
    loaded: ["700 16px 'Barlow Condensed'", "500 16px 'Barlow Condensed'", "400 16px 'Source Serif 4'", "400 16px 'Courier Prime'", "700 16px 'Courier Prime'"].map((font) => document.fonts.check(font)),
  }));
  expect(families.h1).toMatch(/^"?Barlow Condensed/);
  expect(families.body).toMatch(/^"?Source Serif 4/);
  expect(families.code).toMatch(/^"?Courier Prime/);
  expect(families.loaded).toEqual([true, true, true, true, true]);
});

test("phones request only same-origin assets and woff2 fonts", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/", { waitUntil: "networkidle" });
  await settle(page);
  expect(requests.filter((url) => new URL(url).origin !== "http://127.0.0.1:4330")).toEqual([]);
  const fonts = requests.filter((url) => url.includes("/fonts/"));
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((url) => url.endsWith(".woff2"))).toBe(true);
  await context.close();
});

test("the page stock follows the colour scheme", async ({ browser }) => {
  for (const [colorScheme, background] of [["light", "rgb(233, 236, 223)"], ["dark", "rgb(19, 35, 28)"]] as const) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto("/");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(background);
    await context.close();
  }
});

test("the phone page keeps a bounded reading length", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(6900);
});

test("every GitHub link carries readable text and only decorative marks", async ({ page }) => {
  await page.goto("/");
  const links = page.locator('a[href="https://github.com/robertsreberski/mono-agent"]');
  expect(await links.count()).toBeGreaterThanOrEqual(3);
  for (const link of await links.all()) {
    expect(await link.textContent()).toMatch(/GitHub/);
    for (const svg of await link.locator("svg").all()) await expect(svg).toHaveAttribute("aria-hidden", "true");
  }
});

test("no page makes third-party requests or logs errors without consent", async ({ browser, request }) => {
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]).pathname);
  expect(paths).toContain("/");
  expect(paths).toContain("/privacy/");
  for (const colorScheme of SCHEMES) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("request", (req) => { if (new URL(req.url()).origin !== "http://127.0.0.1:4330") problems.push(`request ${req.url()}`); });
    page.on("console", (message) => { if (message.type() === "error") problems.push(`console ${message.text()}`); });
    page.on("pageerror", (error) => problems.push(`pageerror ${error.message}`));
    for (const path of paths) {
      const response = await page.goto(path, { waitUntil: "networkidle" });
      expect(response?.ok(), path).toBe(true);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForLoadState("networkidle");
    }
    expect(problems, colorScheme).toEqual([]);
    await context.close();
  }
});
