// Browser contracts for the marketing blog: accessibility (axe, WCAG
// 2.0/2.1 A+AA and 2.2 AA) on the index and every built post, responsive
// behavior from 320 to 1440 widths in both colour schemes, tap targets and
// reading measure, and working header/footer/post navigation.
//
// Runs against `astro preview` on 127.0.0.1:4330 (see playwright.config.ts):
//   pnpm run build && pnpm run test:browser
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function blogPostPaths(request): Promise<string[]> {
  const response = await request.get("/sitemap.xml");
  expect(response.ok()).toBe(true);
  const xml = await response.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => new URL(match[1]).pathname)
    .filter((path) => /^\/blog\/[^/]+\/$/.test(path) && !/^\/blog\/\d+\/$/.test(path));
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme });

    test("blog index and privacy have no WCAG A/AA violations", async ({ page }) => {
      for (const path of ["/blog/", "/privacy/"]) {
        await page.goto(path, { waitUntil: "networkidle" });
        const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        expect(results.violations, `${path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
      }
    });

    test("every built post has no WCAG A/AA violations", async ({ page, request }) => {
      const posts = await blogPostPaths(request);
      for (const path of posts) {
        const response = await page.goto(path, { waitUntil: "networkidle" });
        expect(response?.ok(), `${path} serves`).toBe(true);
        // Lazy figures must be in the audited state too.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForLoadState("networkidle");
        const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        expect(results.violations, `${path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
      }
    });

    for (const width of [320, 390, 430, 1440]) {
      test(`reading pages fit a ${width}px viewport without horizontal overflow`, async ({ page, request }) => {
        await page.setViewportSize({ width, height: 844 });
        const paths = ["/blog/", "/privacy/", ...(await blogPostPaths(request))];
        for (const path of paths) {
          await page.goto(path, { waitUntil: "networkidle" });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
            `${path} fits ${width}px`,
          ).toBeLessThanOrEqual(width);
        }
      });
    }
  });
}

// Standalone navigation controls are tap targets; inline prose links are exempt.
test("reading-page navigation controls are at least 44px tap targets on phones", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const paths = ["/blog/", "/privacy/", ...(await blogPostPaths(request))];
  for (const path of paths) {
    await page.goto(path, { waitUntil: "networkidle" });
    const small = await page.evaluate(() =>
      [...document.querySelectorAll(".masthead a, .colophon a, .colophon button, .blog-crumb a, .leaf-crumb a, .blog-post-nav a, .blog-back a, .blog-pagination a, .privacy-page .analytics-settings")]
        .filter((el) => el.getClientRects().length > 0 && !el.closest("[hidden]"))
        .map((el) => ({ text: el.textContent!.trim(), box: el.getBoundingClientRect() }))
        .filter(({ box }) => box.height < 43.98 || box.width < 43.98)
        .map(({ text, box }) => `${text} ${box.width.toFixed(1)}x${box.height.toFixed(1)}`),
    );
    expect(small, path).toEqual([]);
  }
});

test("reading pages keep a readable measure", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posts = await blogPostPaths(request);
  for (const [path, selector] of [["/privacy/", ".privacy-page > p"], ...posts.map((post) => [post, ".blog-body > p"])] as const) {
    await page.goto(path, { waitUntil: "networkidle" });
    // Approximate characters per line: width over an average glyph of half an em.
    const widths = await page.locator(selector).evaluateAll((els) => els
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => el.getBoundingClientRect().width / (parseFloat(getComputedStyle(el).fontSize) * 0.5)));
    expect(Math.max(...widths), `${path} line length`).toBeLessThanOrEqual(90);
    expect(Math.min(...widths), `${path} line length`).toBeGreaterThanOrEqual(40);
  }
});

test("landing footer reaches the blog", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("contentinfo").getByRole("link", { name: "Blog" }).click();
  await expect(page).toHaveURL(/\/blog\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Blog");
});

test("blog header, footer, and back links navigate", async ({ page, request }) => {
  await page.goto("/blog/", { waitUntil: "networkidle" });
  await page.getByRole("banner").getByRole("link", { name: "Mono Agent", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/blog/", { waitUntil: "networkidle" });
  await page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy\/$/);

  const posts = await blogPostPaths(request);
  if (posts.length === 0) {
    await expect(page.goto("/blog/")).toBeTruthy();
    await expect(page.getByText("No articles yet")).toBeVisible();
    return;
  }
  await page.goto(posts[0], { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Back to blog" }).click();
  await expect(page).toHaveURL(/\/blog\/$/);
});

test("adjacent posts link both directions when at least two exist", async ({ page, request }) => {
  const posts = await blogPostPaths(request);
  test.skip(posts.length < 2, "needs at least two published posts");
  const navs = new Map<string, { prev: boolean; next: boolean }>();
  for (const path of posts) {
    await page.goto(path, { waitUntil: "networkidle" });
    const nav = page.getByRole("navigation", { name: "More posts" });
    await expect(nav).toBeVisible();
    navs.set(path, {
      prev: (await nav.getByRole("link", { name: /Newer post/ }).count()) > 0,
      next: (await nav.getByRole("link", { name: /Older post/ }).count()) > 0,
    });
  }
  expect([...navs.values()].some((nav) => nav.prev)).toBe(true);
  expect([...navs.values()].some((nav) => nav.next)).toBe(true);
});
