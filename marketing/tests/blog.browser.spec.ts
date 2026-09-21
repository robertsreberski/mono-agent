// Browser contracts for the marketing blog: accessibility (axe, WCAG
// 2.0/2.1 A+AA and 2.2 AA) on the index and every built post, responsive
// behavior at 390 and 1440 widths, and working header/footer/post navigation.
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
    .filter((path) => /^\/blog\/[^/]+\/$/.test(path) && path !== "/blog/rss.xml");
}

test("blog index has no WCAG A/AA violations", async ({ page }) => {
  await page.goto("/blog/", { waitUntil: "networkidle" });
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("every built post has no WCAG A/AA violations", async ({ page, request }) => {
  const posts = await blogPostPaths(request);
  for (const path of posts) {
    const response = await page.goto(path, { waitUntil: "networkidle" });
    expect(response?.ok(), `${path} serves`).toBe(true);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations, `${path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
  }
});

for (const width of [390, 1440]) {
  test(`blog pages fit a ${width}px viewport without horizontal overflow`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    const paths = ["/blog/", ...(await blogPostPaths(request))];
    for (const path of paths) {
      await page.goto(path, { waitUntil: "networkidle" });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${path} fits ${width}px`,
      ).toBeLessThanOrEqual(width);
    }
  });
}

test("landing header and footer reach the blog", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Blog" }).click();
  await expect(page).toHaveURL(/\/blog\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Blog");
});

test("blog header, footer, and back links navigate", async ({ page, request }) => {
  await page.goto("/blog/", { waitUntil: "networkidle" });
  await page.getByRole("banner").getByRole("link", { name: /mono-agent — home/ }).click();
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
