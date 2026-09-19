// Browser contracts for the built marketing page: accessibility (axe, WCAG
// 2.0/2.1 A+AA and 2.2 AA), responsive behavior at 390 and 1440 widths, skip
// link and landmark structure, and reduced-motion handling.
//
// Runs against `astro preview` on 127.0.0.1:4330 (see playwright.config.ts):
//   pnpm run build && pnpm run test:browser
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("has no WCAG A/AA violations", async ({ page }) => {
      const response = await page.goto("/", { waitUntil: "networkidle" });
      expect(response?.ok()).toBe(true);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(
        results.violations,
        JSON.stringify(results.violations, null, 2),
      ).toEqual([]);
    });

    test("has no horizontal overflow", async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        overflow.scrollWidth,
        `scrollWidth ${overflow.scrollWidth} exceeds viewport ${overflow.innerWidth}`,
      ).toBeLessThanOrEqual(overflow.innerWidth);
    });

    test("keeps the hero headline and CTAs visible", async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", {
          name: "Your agents. Your models. Your workspace.",
        }),
      ).toBeVisible();
    });

    test("keeps both hero CTAs fully inside the initial viewport", async ({
      page,
    }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      // Deterministic settle: no webfonts to load, but wait out the
      // entrance animation so the measured boxes are final.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(
        () =>
          document
            .getAnimations()
            .every((animation) => animation.playState !== "running"),
        null,
        { timeout: 5000 },
      );
      const viewport = page.viewportSize();
      expect(viewport).not.toBeNull();
      for (const name of ["Get the code on GitHub", "Explore the blueprint"]) {
        const box = await page
          .getByRole("link", { name })
          .first()
          .boundingBox();
        expect(box, `${name} has a bounding box`).not.toBeNull();
        expect(box!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
        expect(box!.y, `${name} top edge`).toBeGreaterThanOrEqual(0);
        expect(
          box!.x + box!.width,
          `${name} right edge`,
        ).toBeLessThanOrEqual(viewport!.width);
        expect(
          box!.y + box!.height,
          `${name} bottom edge`,
        ).toBeLessThanOrEqual(viewport!.height);
      }
    });
  });
}

test("exposes landmarks, one H1, and a working skip link", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
  await expect(page.getByRole("banner")).toBeAttached();
  await expect(page.getByRole("main")).toBeAttached();
  await expect(page.getByRole("contentinfo")).toBeAttached();
  await expect(page.getByRole("navigation")).not.toHaveCount(0);

  const skipLink = page.getByRole("link", { name: "Skip to content" });
  // Real keyboard tab (not script focus) so :focus-visible applies.
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await expect
    .poll(() => skipLink.evaluate((el) => el.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(0);
  await skipLink.press("Enter");
  expect(new URL(page.url()).hash).toBe("#main");
});

test("section navigation reaches every anchored section", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  for (const section of ["configuration", "console", "use-cases"]) {
    await page.getByRole("navigation", { name: "Sections" })
      .locator(`a[href="#${section}"]`)
      .click();
    await expect(page.locator(`#${section}`)).toBeInViewport();
  }
});

test("disables entrance motion when reduced motion is requested", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/", { waitUntil: "networkidle" });
  const animation = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".hero-copy")!).animationName,
  );
  expect(animation === "none" || animation === "").toBe(true);
  await context.close();
});

for (const width of [320, 768, 1024]) {
  test(`editorial layout stays within ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/", { waitUntil: "networkidle" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByRole("figure").filter({ hasText: "mono-agent.config.json" })).toBeVisible();
    const examples = page.locator(".workflow-recipe");
    await expect(examples).toHaveCount(3);
  });
}

for (const width of [390, 1440]) {
  test(`workflow explorer supports pointer, keyboard and all states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const tabs = page.getByRole("tablist", { name: "Choose a workflow" });
    await expect(tabs).toBeVisible();
    await tabs.getByRole("tab", { name: /Research/ }).click();
    await expect(page.getByRole("tabpanel")).toHaveCount(1);
    await expect(page.getByRole("tabpanel")).toContainText("Connect the dots.");
    await tabs.getByRole("tab", { name: /Research/ }).press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: /Automate/ })).toBeFocused();
    await expect(page.getByRole("tabpanel")).toContainText("Find your rhythm.");
    await page.keyboard.press("Home");
    await expect(tabs.getByRole("tab", { name: /Build/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(tabs.getByRole("tab", { name: /Automate/ })).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations)).toEqual([]);
  });
}

test("all workflow content and native FAQ work without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  for (const id of ["build", "research", "automate"]) {
    await expect(page.locator(`#workflow-${id}`)).toBeVisible();
  }
  await expect(page.locator("#configuration")).toContainText("mono-agent.config.json");
  await expect(page.locator("#configuration .block-chapter dt")).toHaveCount(12);
  await expect(page.getByRole("button", { name: /Copy install command/ })).toHaveCount(0);
  const question = page.locator(".faq summary").first();
  await question.click();
  await expect(page.locator(".faq details").first()).toHaveAttribute("open", "");
  await context.close();
});

test("deep-linked workflow is selected on load", async ({ page }) => {
  await page.goto("/#workflow-research");
  await expect(page.getByRole("tab", { name: /Research/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("Connect the dots.");
});

test("copy command reports success only after clipboard resolves", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => { (window as any).copied = text; } },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: /Copy install command/ }).click();
  await expect(page.getByRole("status")).toHaveText("Install command copied.");
  expect(await page.evaluate(() => (window as any).copied)).toBe("npm i -g create-mono-agent");
});

test("clipboard refusal leaves honest manual instructions", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => { throw new Error("denied"); } },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: /Copy install command/ }).click();
  await expect(page.getByRole("status")).toHaveText("Copy unavailable. Select and copy the command above.");
  await expect(page.getByRole("button", { name: /Copy install command/ })).toBeEnabled();
});

test("workflow URL follows selection and back/forward navigation", async ({ page }) => {
  await page.goto("/#workflow-research");
  await page.getByRole("tab", { name: /Automate/ }).click();
  await expect(page).toHaveURL(/#workflow-automate$/);
  await page.reload();
  await expect(page.getByRole("tabpanel")).toContainText("Find your rhythm.");
  await page.goBack();
  await expect(page.getByRole("tab", { name: /Research/ })).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.getByRole("tab", { name: /Automate/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => { location.hash = "workflow-build"; });
  await expect(page.getByRole("tabpanel")).toContainText("From stuck to shipped.");
});

test("workflow tabs support Enter and Space activation", async ({ page }) => {
  await page.goto("/");
  const research = page.getByRole("tab", { name: /Research/ });
  await research.focus();
  await research.press("Enter");
  await expect(research).toHaveAttribute("aria-selected", "true");
  const automate = page.getByRole("tab", { name: /Automate/ });
  await automate.focus();
  await automate.press("Space");
  await expect(automate).toHaveAttribute("aria-selected", "true");
});

test("missing Clipboard API remains an honest manual-copy path", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  await page.goto("/");
  await page.getByRole("button", { name: /Copy install command/ }).click();
  await expect(page.getByRole("status")).toContainText("Copy unavailable.");
});


for (const width of [320, 390, 640]) {
  test(`mobile menu is compact, keyboard-operable and closes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({width, height:844});
    await page.goto('/');
    const menu = page.getByRole('button', {name:'Menu'});
    const nav = page.getByRole('navigation', {name:'Sections'});
    await expect(nav).not.toBeVisible();
    expect((await page.locator('.site-header').boundingBox())!.height).toBeLessThan(85);
    await menu.focus(); await page.keyboard.press('Enter');
    await expect(nav).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await expect(nav).not.toBeVisible();
    await menu.click(); await nav.getByRole('link', {name:'Console', exact:true}).click();
    await expect(nav).not.toBeVisible();
    await expect(page.locator('#console')).toBeInViewport();
    await expect(page.locator('#config-blueprint-json')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
test('console screenshot is real component evidence with disclosed synthetic state', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('.console-shot')).toContainText('synthetic example data');
  await expect(page.locator('.console-shot')).toContainText('current source build');
  const result = await new AxeBuilder({page}).withTags(WCAG_TAGS).analyze();
  expect(result.violations).toEqual([]);
});
test('mobile document keeps a bounded reading length with visible configuration', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/');
  await expect(page.locator('[data-scroll-story]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(6900);
});

test('navigation and blueprint remain usable without JavaScript', async ({browser}) => {
  const context = await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
  const page = await context.newPage(); await page.goto('/');
  await expect(page.getByRole('navigation',{name:'Sections'})).toBeVisible();
  await expect(page.locator('#config-blueprint-json')).toBeVisible();
  await context.close();
});
test('workflow deep links stay visible with reduced motion', async ({page}) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/#configuration');
  await page.goto('/#workflow-research',{waitUntil:'networkidle'});
  await expect(page.locator('#workflow-research')).toBeInViewport();
});

test('building blocks stay readable and disclose source availability', async ({page}) => {
  await page.goto('/');
  const blocks=page.locator('.building-blocks');
  await expect(blocks.locator('dt')).toHaveCount(12);
  await expect(blocks).toContainText('Subagents');
  await expect(blocks).toContainText('Background jobs');
  await expect(blocks).toContainText('current source build');
});
test('desktop console stays sharp and uncropped on phones', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/');
  const image=page.locator('.console-shot img');
  await expect(page.getByRole('link',{name:'Open full resolution desktop console screenshot'})).toHaveAttribute('href','/console-desktop.webp');
  await image.scrollIntoViewIfNeeded();
  await expect.poll(()=>image.evaluate((el: HTMLImageElement)=>el.naturalWidth)).toBe(1920);
  const geometry=await image.evaluate((el: HTMLImageElement)=>({width:el.clientWidth,height:el.clientHeight,ratio:el.naturalWidth/el.naturalHeight}));
  expect(geometry.width/geometry.height).toBeCloseTo(geometry.ratio,1);
});
test('mobile hero is complete and sits above the CTA', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/');
  const image=await page.locator('.hero-art img').boundingBox();
  const cta=await page.locator('.hero-actions').boundingBox();
  expect(image!.y+image!.height).toBeLessThanOrEqual(cta!.y+1);
  expect(image!.width/image!.height).toBeCloseTo(1,1);
  expect(await page.locator('.hero-art img').evaluate(el=>getComputedStyle(el).maskImage)).toBe('none');
});

test('mobile page uses compact cards and no floating components', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/');
  await expect(page.locator('.block-chapter')).toHaveCount(4);
  await expect(page.locator('.block-chapter dt')).toHaveCount(12);
  await expect(page.locator('[data-block-story], .block-layer, .workflow-art')).toHaveCount(0);
  expect((await page.locator('.building-blocks').boundingBox())!.height).toBeLessThan(1000);
  expect((await page.locator('.hero-actions').boundingBox())!.y).toBeLessThan(740);
});
test('high density mobile loads the mobile hero and compressed local fonts', async ({browser}) => {
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3});
  const page=await context.newPage(); const requests:string[]=[];
  page.on('request',request=>requests.push(request.url()));
  await page.goto('/'); await page.evaluate(()=>document.fonts.ready);
  expect(await page.locator('.hero-art img').evaluate((el:HTMLImageElement)=>el.currentSrc)).toMatch(/hero-mobile-640.webp$/);
  expect(requests.some(url=>/hero-1440|module-|\.ttf/.test(url))).toBe(false);
  expect(requests.filter(url=>url.includes('/fonts/')).every(url=>url.endsWith('.woff2'))).toBe(true);
  await context.close();
});

test('simple cards settle once into their grid and honor reduced motion', async ({page}) => {
  await page.goto('/'); const cards=page.locator('.block-summary');
  await cards.evaluate(el=>scrollTo({top:scrollY+el.getBoundingClientRect().top-innerHeight*.8,behavior:'instant'}));
  await expect.poll(()=>cards.evaluate(el=>Number((el as HTMLElement).style.getPropertyValue('--card-open')))).toBeLessThan(.5);
  await cards.evaluate(el=>scrollTo({top:scrollY+el.getBoundingClientRect().top-innerHeight*.25,behavior:'instant'}));
  await expect.poll(()=>cards.evaluate(el=>Number((el as HTMLElement).style.getPropertyValue('--card-open')))).toBe(1);
  await page.emulateMedia({reducedMotion:'reduce'}); await expect(cards).toHaveAttribute('data-cards-motion','false');
  expect(await cards.locator('.block-chapter').first().evaluate(el=>getComputedStyle(el).transform)).toBe('none');
});
