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
          name: "An agent workspace you can build on.",
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
      for (const name of ["GitHub", "Blueprint"]) {
        const box = await page.locator(".hero-actions")
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

test("exposes landmarks, one H1, and a working skip link", async ({ page, browserName }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
  await expect(page.getByRole("banner")).toBeAttached();
  await expect(page.getByRole("main")).toBeAttached();
  await expect(page.getByRole("contentinfo")).toBeAttached();
  await expect(page.getByRole("navigation")).not.toHaveCount(0);

  const skipLink = page.getByRole("link", { name: "Skip to content" });
  // Real keyboard tab (not script focus) so :focus-visible applies.
  // macOS WebKit follows Safari’s link-navigation preference: Option+Tab visits links.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(skipLink).toBeFocused();
  await expect
    .poll(() => skipLink.evaluate((el) => el.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(0);
  await skipLink.press("Enter");
  expect(new URL(page.url()).hash).toBe("#main");
});

test("section navigation reaches every anchored section", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  for (const section of ["configuration", "console", "comparison"]) {
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

for (const width of [320, 430, 768, 1024]) {
  test(`editorial layout stays within ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/", { waitUntil: "networkidle" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.locator(".config-blueprint")).toBeVisible();
    await expect(page.locator(".harness-row")).toHaveCount(6);
  });
}

test("comparison content and native FAQ work without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator(".harness-row")).toHaveCount(6);
  await expect(page.locator("#comparison")).toContainText("OpenClaw");
  await expect(page.locator("#configuration")).toContainText("mono-agent.config.json");
  await expect(page.locator("#configuration .block-links a")).toHaveCount(12);
  await expect(page.getByRole("button", { name: /Copy command/ })).toHaveCount(0);
  const question = page.locator(".faq summary").first();
  await question.click();
  await expect(page.locator(".faq details").first()).toHaveAttribute("open", "");
  await context.close();
});


test("copy command reports success only after clipboard resolves", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => { (window as any).copied = text; } },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: /Copy command/ }).click();
  await expect(page.getByRole("status")).toHaveText("Install command copied.");
  expect(await page.evaluate(() => (window as any).copied)).toBe("npm i -g create-mono-agent");
});

test("clipboard refusal leaves honest manual instructions", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => { throw new Error("denied"); } },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: /Copy command/ }).click();
  await expect(page.getByRole("status")).toHaveText("Copy unavailable. Select and copy the command above.");
  await expect(page.getByRole("button", { name: /Copy command/ })).toBeEnabled();
});



test("missing Clipboard API remains an honest manual-copy path", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  await page.goto("/");
  await page.getByRole("button", { name: /Copy command/ }).click();
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
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-scroll-story]')).toHaveCount(0);
  // Main comparisons and readable cards retain a bounded page; secondary
  // coding-harness details use a native disclosure, not another long section.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(7800);
});

test('navigation and blueprint remain usable without JavaScript', async ({browser}) => {
  const context = await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
  const page = await context.newPage(); await page.goto('/');
  await expect(page.getByRole('navigation',{name:'Sections'})).toBeVisible();
  await expect(page.locator('#config-blueprint-json')).toBeVisible();
  await context.close();
});
test('comparison deep link stays visible with reduced motion', async ({page}) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/#configuration');
  await page.goto('/#comparison',{waitUntil:'networkidle'});
  await expect(page.locator('#comparison')).toBeInViewport();
});

test('building blocks stay readable and disclose source availability', async ({page}) => {
  await page.goto('/');
  const blocks=page.locator('.building-blocks');
  await expect(blocks.locator('.block-links a')).toHaveCount(12);
  await expect(blocks).toContainText('Subagents');
  await expect(blocks).toContainText('Background jobs');
  await expect(blocks).toContainText('v0.22.0');
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

test('mobile page uses one compact deck stage and no duplicated cards', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/');
  await expect(page.locator('.block-chapter')).toHaveCount(4);
  await expect(page.locator('.block-links a')).toHaveCount(12);
  await expect(page.locator('[data-block-story], .block-layer, .workflow-art')).toHaveCount(0);
  expect((await page.locator('.block-summary').boundingBox())!.height).toBe(740);
  expect((await page.locator('.building-blocks').boundingBox())!.height).toBeLessThan(1500);
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

async function seekDeck(page: import("@playwright/test").Page, timeline: number) {
  const cards = page.locator(".block-summary");
  await cards.evaluate((el, timeline) => {
    const grid = el.querySelector<HTMLElement>(".block-chapters")!;
    const bounds = el.getBoundingClientRect();
    const stickyTop = parseFloat(getComputedStyle(grid).top);
    const inset = parseFloat(getComputedStyle(el).paddingTop);
    const travel = el.clientHeight - grid.clientHeight - inset * 2;
    scrollTo({
      top: scrollY + bounds.top + inset - stickyTop + (timeline / 3) * travel,
      behavior: "instant",
    });
  }, timeline);
  await expect.poll(() => cards.getAttribute("data-active-card")).toBe(String(Math.round(timeline)));
}

async function activeCardGeometry(page: import("@playwright/test").Page) {
  return page.locator('.block-chapter[data-active="true"]').evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
      transform: getComputedStyle(el).transform,
      opacity: Number(getComputedStyle(el).opacity),
    };
  });
}

for (const width of [390, 1440]) {
  test(`native scroll stacks, lifts, tosses and reverses cards at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const cards = page.locator(".block-summary");
    const layers = cards.locator(".block-chapter");

    await seekDeck(page, 0);
    const initial = await layers.evaluateAll((elements) => elements.map((el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, transform: getComputedStyle(el).transform };
    }));
    expect(initial.every((card) => card.transform !== "none")).toBe(true);
    const overlapWidth = Math.min(initial[0].right, initial[1].right) - Math.max(initial[0].left, initial[1].left);
    const overlapHeight = Math.min(initial[0].bottom, initial[1].bottom) - Math.max(initial[0].top, initial[1].top);
    expect(overlapWidth).toBeGreaterThan(200);
    expect(overlapHeight).toBeGreaterThan(200);

    for (const timeline of [0, 1, 2, 3]) {
      await seekDeck(page, timeline);
      const geometry = await activeCardGeometry(page);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(width === 390 ? 844 : 1000);
      expect(geometry.transform).not.toBe("none");
      expect(geometry.opacity).toBeGreaterThan(.95);
      const stage = await cards.boundingBox();
      expect(geometry.top).toBeGreaterThanOrEqual(stage!.y);
      expect(geometry.bottom).toBeLessThanOrEqual(stage!.y + stage!.height);
      if (timeline > 0) await expect(layers.nth(timeline - 1)).toHaveCSS("opacity", "0");
    }

    await seekDeck(page, 1);
    const settledLeft = (await layers.nth(1).boundingBox())!.x;
    await seekDeck(page, 1.7);
    const tossed = await layers.nth(1).evaluate((el) => ({
      box: el.getBoundingClientRect().toJSON(),
      opacity: Number(getComputedStyle(el).opacity),
      transform: getComputedStyle(el).transform,
    }));
    expect(Math.abs(tossed.box.x - settledLeft)).toBeGreaterThan(45);
    expect(tossed.opacity).toBeLessThan(.55);
    expect(tossed.transform).not.toBe("none");
    await expect(cards).toHaveAttribute("data-active-card", "2");

    for (const timeline of [3, 2, 1, 0]) await seekDeck(page, timeline);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await page.setViewportSize({ width: width === 390 ? 430 : 1280, height: 900 });
    await seekDeck(page, 3);
    await expect(layers.last()).toHaveAttribute("data-active", "true");
    const final = await activeCardGeometry(page);
    expect(final.top).toBeGreaterThanOrEqual(0);
    expect(final.bottom).toBeLessThanOrEqual(900);
  });
}

test("reduced motion and no-JavaScript expose a static readable card layout", async ({ browser }) => {
  for (const options of [
    { javaScriptEnabled: true, reducedMotion: "reduce" as const },
    { javaScriptEnabled: false, reducedMotion: "no-preference" as const },
  ]) {
    const context = await browser.newContext({ ...options, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/");
    const cards = page.locator(".block-summary");
    const layers = cards.locator(".block-chapter");
    await expect(layers).toHaveCount(4);
    await expect(cards.locator(".block-links a")).toHaveCount(12);
    const geometry = await layers.evaluateAll((elements) => elements.map((el) => {
      const box = el.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, position: getComputedStyle(el).position, transform: getComputedStyle(el).transform };
    }));
    expect(geometry.every((card) => card.position === "static" && card.transform === "none")).toBe(true);
    for (let index = 1; index < geometry.length; index++) expect(geometry[index].top).toBeGreaterThanOrEqual(geometry[index - 1].bottom);
    if (options.javaScriptEnabled) {
      await expect(cards).toHaveAttribute("data-motion-state", "reduced");
      await expect(page.getByRole("button", { name: "Pause motion" })).toBeHidden();
    }
    await context.close();
  }
});

test("pause and keyboard traversal reveal every real card in static flow", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const cards = page.locator(".block-summary");
  const toggle = page.locator(".motion-toggle");
  await toggle.evaluate((button: HTMLButtonElement) => button.click());
  await expect(cards).toHaveAttribute("data-motion-state", "paused");
  await expect(cards.locator(".block-chapter").first()).toHaveCSS("position", "static");
  await toggle.evaluate((button: HTMLButtonElement) => button.click());
  await seekDeck(page, 2);

  await toggle.focus();
  const forward = browserName === "webkit" ? "Alt+Tab" : "Tab";
  const backward = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
  const links = cards.locator(".block-links a");
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press(forward);
    await expect(links.nth(index)).toBeFocused();
    await expect(cards).toHaveAttribute("data-motion-state", "focused");
    await expect(links.nth(index)).toBeInViewport();
    await expect(links.nth(index).locator("xpath=ancestor::li[contains(@class,'block-chapter')]")).toHaveCSS("position", "static");
  }
  await page.keyboard.press(forward);
  await expect(cards).toHaveAttribute("data-motion-state", "scroll");
  await expect(page.locator(".blocks-note a")).toBeFocused();
  await expect(page.locator(".blocks-note a")).toBeInViewport();
  await page.keyboard.press(backward);
  await expect(links.last()).toBeFocused();
  await expect(links.last()).toBeInViewport();
  await expect(cards).toHaveAttribute("data-motion-state", "focused");
});

test("live reduced-motion changes preserve keyboard focus and readable geometry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const link = page.locator(".block-links a").nth(7);
  await link.focus();
  await expect(link).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(link).toBeFocused();
  await expect(link).toBeInViewport();
  await expect(page.locator(".block-summary")).toHaveAttribute("data-motion-state", "focused");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(link).toBeFocused();
  await expect(link).toBeInViewport();
});

test("every GitHub CTA has an accessible decorative GitHub mark", async ({
  page,
}) => {
  await page.goto("/");
  const links = page.locator(
    'a[href="https://github.com/robertsreberski/mono-agent"]',
  );
  for (const link of await links.all()) {
    await expect(link.locator("svg.github-icon")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(await link.textContent()).toMatch(/GitHub|Get the code/);
  }
});

test("building blocks use four distinct decorative schematics and twelve links", async ({
  page,
}) => {
  await page.goto("/");
  const blocks = page.locator(".building-blocks");
  await expect(blocks.locator(".block-diagram")).toHaveCount(4);
  for (const name of ["foundation", "connections", "delegated", "continuity"]) {
    await expect(
      blocks.locator(`.diagram-${name} svg[aria-hidden="true"]`),
    ).toHaveCount(1);
  }
  await expect(blocks.locator(".block-links a")).toHaveCount(12);
  await expect(blocks.locator(".block-chapter dd")).toHaveCount(0);
});

for (const viewport of [
  { width: 390, height: 844, body: 14, cta: 13, code: 11, cardTitle: 20 },
  { width: 1440, height: 1000, body: 15, cta: 14, code: 12, cardTitle: 24 },
]) {
  test(`uses the coherent type scale at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto("/");
    const sizes = await page.evaluate(() =>
      Object.fromEntries(
        Object.entries({
          body: document.body,
          cta: document.querySelector(".hero-actions .btn"),
          card: document.querySelector(".block-chapter>p"),
          cardLink: document.querySelector(".block-links a"),
          label: document.querySelector(".section-label"),
          code: document.querySelector(".config-blueprint pre"),
          cardTitle: document.querySelector(".block-chapter h4"),
          caption: document.querySelector(".console-shot figcaption"),
        }).map(([key, element]) => [
          key,
          parseFloat(getComputedStyle(element!).fontSize),
        ]),
      ),
    );
    expect(sizes).toEqual({
      body: viewport.body,
      cta: viewport.cta,
      card: 13,
      cardLink: 13,
      label: 11,
      code: viewport.code,
      cardTitle: viewport.cardTitle,
      caption: 12,
    });
  });
}

// A pointer click must not reflow the deck between pointerdown and click.
test("focused deck links remain genuine pointer targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await seekDeck(page, 2);
  const link = page.locator('.block-chapter[data-active="true"] .block-links a').first();
  await link.evaluate(el => el.addEventListener("click", event => {
    event.preventDefault();
    el.setAttribute("data-clicked", "true");
  }));
  const before = await link.boundingBox();
  await link.click();
  await expect(link).toHaveAttribute("data-clicked", "true");
  await expect(page.locator(".block-summary")).toHaveAttribute("data-motion-state", "scroll");
  const after = await link.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
});

for (const width of [320, 390, 430]) {
  test(`compact labels and card faces fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({width,height:844}); await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const ctas = [...document.querySelectorAll('.hero-actions a')].map(el => el.getBoundingClientRect().toJSON());
      const caption = [...document.querySelectorAll('.config-blueprint figcaption strong, .config-blueprint figcaption>span:last-child')].map(el => el.getBoundingClientRect().toJSON());
      return {ctas,caption};
    });
    expect(Math.abs(layout.ctas[0].top-layout.ctas[1].top)).toBeLessThan(2);
    expect(Math.abs(layout.caption[0].top-layout.caption[1].top)).toBeLessThan(3);
    for(const turn of [0,1,2,3]) {
      await seekDeck(page,turn);
      const face=page.locator('.block-chapter[data-active="true"]');
      const box=await face.boundingBox();
      for(const link of await face.locator('a').all()) {
        const b=await link.boundingBox();
        expect(b!.y+b!.height).toBeLessThanOrEqual(box!.y+box!.height);
        expect(b!.x+b!.width).toBeLessThanOrEqual(box!.x+box!.width);
      }
    }
    expect(await page.locator('.block-summary').evaluate(el=>el.clientHeight)).toBeLessThanOrEqual(760);
  });
}
test('comparison links official sources without a feature-ranking claim', async ({page}) => {
  await page.goto('/#comparison');
  await page.locator('.comparison-more summary').click();
  await expect(page.locator('.harness-row')).toHaveCount(6);
  for(const name of ['Mono Agent','Codex CLI','Claude Code','OpenCode','Hermes Agent','OpenClaw']) {
    await expect(page.locator('.harness-list').getByRole('link',{name,exact:true})).toHaveAttribute('href', /^https:\/\//);
  }
  await expect(page.locator('.comparison-note')).toContainText('not a feature or performance ranking');
});
test('native deck scroll does not remeasure card widths per frame', async ({page}) => {
  await page.goto('/'); await page.evaluate(()=>document.fonts.ready);
  await seekDeck(page,0);
  const reads=await page.evaluate(async () => {
    let count=0;
    const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'offsetWidth')!;
    Object.defineProperty(HTMLElement.prototype,'offsetWidth',{...descriptor,get(){
      if(this.matches('.block-chapter')) count++;
      return descriptor.get!.call(this);
    }});
    try {
      for(let i=0;i<24;i++) {
        window.scrollBy({top:5,behavior:'instant'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      }
      return count;
    } finally { Object.defineProperty(HTMLElement.prototype,'offsetWidth',descriptor); }
  });
  expect(reads).toBeLessThanOrEqual(1);
});
test('FAQ heading has breathing room and opened answers stay separated', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/#faq'); await page.evaluate(()=>document.fonts.ready);
  // Read relative geometry in one frame: Safari can still be scrolling to
  // the hash between separate boundingBox calls even after fonts are ready.
  const gap = await page.evaluate(() => {
    const heading = document.querySelector('#faq-heading')!.getBoundingClientRect();
    const first = document.querySelector('.faq details')!.getBoundingClientRect();
    return first.top - heading.bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(24);
  await page.locator('.faq details').first().locator('summary').click();
  const answerGap = await page.evaluate(() => {
    const answer = document.querySelector('.faq details .faq-answer')!.getBoundingClientRect();
    const next = document.querySelectorAll('.faq details')[1].getBoundingClientRect();
    return next.top - answer.bottom;
  });
  expect(answerGap).toBeGreaterThanOrEqual(0);
});

for (const width of [390, 1440]) {
  test(`workspace proof and TypeScript excerpt remain readable at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 1000});
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    const proof = page.locator('#why');
    await expect(proof.locator('article')).toHaveCount(3);
    await expect(proof).toContainText('Give it a role');
    await expect(proof).toContainText('persistent subagent');
    await expect(proof).toContainText('retained tool results');
    const excerpt = page.locator('.composition-code');
    await excerpt.scrollIntoViewIfNeeded();
    await expect(excerpt).toBeVisible();
    const bounds = await excerpt.evaluate(el => ({left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: el.clientWidth, content: el.scrollWidth}));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    expect(bounds.content).toBeLessThanOrEqual(bounds.width);
    await expect(page.getByRole('link', {name: 'Imports & full example'})).toHaveAttribute('href', 'https://docs.mono-agent.dev/programmatic/composition/');
    await expect(page.locator('.blocks-note')).toContainText('v0.22.0');
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`overview preserves readable live text and flow at ${width}`, async ({page}) => {
    await page.setViewportSize({width, height:1000}); await page.goto('/');
    const map = page.locator('.agent-map');
    await expect(map.locator('li')).toHaveCount(3);
    await expect(map).toContainText('Your folder');
    await expect(map).toContainText('mono-agent.config.json');
    await expect(map).toContainText('Your workspace');
    await expect(map).toContainText('Models: cloud or local');
    const boxes = await map.locator('li').evaluateAll(items => items.map(el => {
      const b=el.getBoundingClientRect(); return {x:b.x,y:b.y,right:b.right,bottom:b.bottom};
    }));
    for(const box of boxes) {expect(box.x).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(width);}
    if(width<=700) expect(boxes[1].y).toBeGreaterThan(boxes[0].bottom);
    else expect(boxes[1].x).toBeGreaterThan(boxes[0].right);
  });
}
