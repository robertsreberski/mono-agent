// Built-output SEO and honesty contracts for the marketing site.
//
// Run after `pnpm run build` (from marketing/):
//   pnpm run test:unit
//
// Asserts on dist/ (the real rendered output): metadata, canonical and social
// URLs, sitemap/robots, honest JSON-LD, single-H1 structure, working anchors,
// decorative-art honesty, zero client JS, and asset size caps.
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import sharp from "sharp";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SITE_URL = "https://mono-agent.dev";
const GITHUB_URL = "https://github.com/robertsreberski/mono-agent";
const DOCS_URL = "https://mono-agent-docs.vercel.app/";

function readDist(rel) {
  const path = join(DIST, rel);
  assert.ok(existsSync(path), `dist/${rel} must exist`);
  return readFileSync(path, "utf8");
}

function mustContain(html, snippet, label) {
  assert.ok(html.includes(snippet), `${label} must be present`);
}

function decodeHtmlText(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function assertMatchesGeneratedSchema(value, schema, path = "config") {
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${path} matches const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} matches enum`);

  if (schema.type === "object") {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${path} is an object`);
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      assert.ok(childSchema || schema.additionalProperties !== false, `${path}.${key} exists in generated schema`);
      if (childSchema) assertMatchesGeneratedSchema(child, childSchema, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${path} is an array`);
    if (schema.items) value.forEach((child, index) => assertMatchesGeneratedSchema(child, schema.items, `${path}[${index}]`));
    return;
  }
  if (schema.type === "integer") {
    assert.ok(Number.isInteger(value), `${path} is an integer`);
    return;
  }
  if (typeof schema.type === "string") assert.equal(typeof value, schema.type, `${path} has generated type ${schema.type}`);
}

describe("marketing built output", () => {
  const html = readDist("index.html");

  it("declares the exact title, description, and canonical URL", () => {
    mustContain(
      html,
      "<title>mono-agent — Local-first AI workspace for coding and research</title>",
      "exact <title>",
    );
    const description = html.match(/<meta name="description" content="([^"]+)"\/?>/);
    assert.ok(description, "meta description must exist");
    assert.ok(description[1].length >= 50 && description[1].length <= 300,
      `meta description must be useful (${description[1].length} chars)`);
    mustContain(html, `<link rel="canonical" href="${SITE_URL}/"`, "canonical link");
    mustContain(html, 'lang="en"', "html lang");
    mustContain(html, 'name="viewport"', "viewport meta");
    mustContain(html, 'rel="icon"', "favicon link");
  });

  it("publishes absolute Open Graph and Twitter card URLs", () => {
    for (const tag of [
      '<meta property="og:type" content="website"',
      '<meta property="og:site_name" content="mono-agent"',
      `<meta property="og:url" content="${SITE_URL}/"`,
      `<meta property="og:image" content="${SITE_URL}/og-1200x630.jpg"`,
      '<meta property="og:image:width" content="1200"',
      '<meta property="og:image:height" content="630"',
      '<meta name="twitter:card" content="summary_large_image"',
      `<meta name="twitter:image" content="${SITE_URL}/og-1200x630.jpg"`,
    ]) {
      mustContain(html, tag, `social tag ${tag.slice(0, 48)}…`);
    }
    assert.ok(!html.includes('content="/og-'), "social image URLs must be absolute");
  });

  it("ships a real 1200x630 social card within budget", async () => {
    const path = join(DIST, "og-1200x630.jpg");
    assert.ok(existsSync(path), "dist/og-1200x630.jpg must exist");
    const meta = await sharp(path).metadata();
    assert.equal(meta.width, 1200, "og card width");
    assert.equal(meta.height, 630, "og card height");
    assert.ok(statSync(path).size < 180_000, "og card stays small");
    // The card carries real brand typography: both image alts must describe
    // the actual card, not the bare artwork.
    for (const attr of ["property=\"og:image:alt\"", "name=\"twitter:image:alt\""]) {
      const match = html.match(new RegExp(`<meta ${attr} content="([^"]+)"`));
      assert.ok(match, `${attr} must exist`);
      assert.ok(match[1].includes("mono-agent"), `${attr} names the brand`);
      assert.ok(
        match[1].toLowerCase().includes("local-first ai workspace"),
        `${attr} carries the descriptor`,
      );
    }
  });

  it("keeps hero art responsive, decorative, and small", async () => {
    for (const width of [640, 960, 1440]) {
      for (const ext of ["webp"]) {
        const rel = `hero-${width}.${ext}`;
        const path = join(DIST, rel);
        assert.ok(existsSync(path), `dist/${rel} must exist`);
        const meta = await sharp(path).metadata();
        assert.ok(meta.width === width, `${rel} width`);
        assert.ok(statSync(path).size < 180_000, `${rel} stays small`);
      }
    }
    // The artwork is decorative brand art: empty alt, never a screenshot.
    assert.ok(/<img[^>]*alt=""/.test(html), "hero image carries empty alt");
    mustContain(html, "not a product screenshot", "honest art caption");
    assert.ok(!/screenshot of|product screenshot(?!")|app screenshot/i.test(
      html.replace("not a product screenshot", "")),
      "no screenshot claims elsewhere");
  });

  it("serves sitemap.xml and robots.txt with absolute URLs", () => {
    const sitemap = readDist("sitemap.xml");
    mustContain(sitemap, `<loc>${SITE_URL}/</loc>`, "sitemap loc");
    const robots = readDist("robots.txt");
    mustContain(robots, "Allow: /", "robots allow");
    mustContain(robots, `Sitemap: ${SITE_URL}/sitemap.xml`, "robots sitemap");
  });

  it("emits honest JSON-LD with no fake social proof", () => {
    const match = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    assert.ok(match, "JSON-LD block must exist");
    const data = JSON.parse(match[1]);
    const serialized = JSON.stringify(data);
    for (const banned of ["review", "Review", "rating", "Rating", "offers", "Offers", "price"]) {
      assert.ok(!serialized.includes(banned), `JSON-LD must not invent ${banned}`);
    }
    assert.ok(serialized.includes(SITE_URL), "JSON-LD references the site URL");
  });

  it("keeps one H1 with the exact headline and resolves every anchor", () => {
    const h1s = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) ?? [];
    assert.equal(h1s.length, 1, "exactly one H1");
    assert.ok(h1s[0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").includes("Your agents. Your models. Your workspace."),
      "exact hero headline");
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
    assert.ok(anchors.length > 0, "in-page anchors exist");
    for (const anchor of anchors) {
      assert.ok(ids.has(anchor), `anchor #${anchor} resolves to an id`);
    }
  });

  it("makes the central configuration prominent and keeps its example valid", () => {
    const hero = html.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? "";
    mustContain(hero, "mono-agent.config.json", "hero configuration filename");
    mustContain(html, "One JSON file.", "configuration thesis headline");
    mustContain(html, "Your agent’s blueprint.", "configuration thesis continuation");
    mustContain(html, 'id="configuration"', "configuration anchor");

    const code = html.match(/<code id="config-blueprint-json">([\s\S]*?)<\/code>/);
    assert.ok(code, "rendered configuration example exists");
    const renderedConfig = decodeHtmlText(code[1]);
    assert.ok(renderedConfig.split("\n").length <= 25, "configuration stays compact");
    const config = JSON.parse(renderedConfig);
    const schema = JSON.parse(readFileSync(
      join(REPO_ROOT, "packages/agent-app/schema/mono-agent.config.schema.json"),
      "utf8",
    ));
    assertMatchesGeneratedSchema(config, schema);
    assert.deepEqual(Object.keys(config), ["runtime", "context", "memory", "tools", "telegram"]);
    assert.equal(config.memory.mode, "lite");
    assert.equal(config.telegram.botToken, undefined, "example keeps secrets out of JSON");
  });

  it("renders decorative arrows as accessible SVG, never emoji-prone text", () => {
    const css = readDist("styles.css");
    assert.ok(
      !/[↗↓↑←→↖↘↙]/u.test(html),
      "built HTML has no Unicode arrow glyphs",
    );
    assert.ok(
      !/[↗↓↑←→↖↘↙]/u.test(css),
      "built CSS has no Unicode arrow glyphs",
    );
    const arrows = [...html.matchAll(/<svg[^>]*class="arrow-icon"[^>]*>/g)].map(
      (match) => match[0],
    );
    assert.ok(
      arrows.length >= 20,
      `expected reusable SVG arrows (${arrows.length})`,
    );
    for (const arrow of arrows) {
      assert.ok(
        arrow.includes('aria-hidden="true"'),
        "decorative arrow is hidden from assistive tech",
      );
      assert.ok(
        arrow.includes('focusable="false"'),
        "decorative arrow cannot receive focus",
      );
    }
  });

  it("links GitHub as primary CTA and docs as secondary", () => {
    assert.ok(html.includes(`href="${GITHUB_URL}"`), "GitHub links present");
    const githubCount = html.split(`href="${GITHUB_URL}"`).length - 1;
    assert.ok(githubCount >= 3, `GitHub linked repeatedly (${githubCount})`);
    assert.ok(html.includes(`href="${DOCS_URL}"`), "docs links present");
  });

  it("loads only its small local progressive-enhancement module", () => {
    const scripts = [...html.matchAll(/<script(?![^>]*ld\+json)[^>]*>/g)].map(m => m[0]);
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0].includes('src="/interactions.js"'));
    assert.ok(scripts[0].includes('type="module"'));
    assert.ok(statSync(join(DIST, "interactions.js")).size < 8500);
    for (const id of ["workflow-build", "workflow-research", "workflow-automate"]) {
      mustContain(html, `id="${id}"`, "server-rendered workflow");
    }
    mustContain(html, "Illustrative workflow", "honest illustrative label");
  });

  it("keeps competitor research out of public copy", () => {
    const lower = html.toLowerCase();
    for (const competitor of ["hermes", "openclaw", "open claw"]) {
      assert.ok(!lower.includes(competitor), `public HTML must not name ${competitor}`);
    }
  });

  it("ships bounded real-console captures with provenance", async () => {
    for (const name of ["console-desktop.webp"]) {
      const image = join(DIST, name);
      const meta = await sharp(image).metadata();
      assert.ok(meta.width <= 2000 && meta.height <= 2000);
      assert.ok(statSync(image).size < 180000);
    }
    mustContain(html, "synthetic example data", "console fixture provenance");
    mustContain(html, "current source build", "console release boundary");
  });

  it("keeps sculptural assets truly transparent and bounded", async () => {
    for (const name of ["hero-640.webp", "hero-960.webp", "hero-1440.webp", "hero-mobile-320.webp", "hero-mobile-640.webp"]) {
      const path = join(DIST,name);
      const meta = await sharp(path).metadata();
      assert.ok(meta.hasAlpha, `${name} must blend without a baked backdrop`);
      assert.ok(meta.width <= 2000 && meta.height <= 2000);
      const corner = await sharp(path).extract({left:0,top:0,width:1,height:1}).raw().toBuffer();
      assert.equal(corner[3],0,`${name} corner must be transparent`);
      assert.ok(statSync(path).size < 180000);
    }
    let fontsSize=0;
    for (const font of ["instrument-serif.woff2", "instrument-serif-italic.woff2", "manrope.woff2"]) fontsSize+=statSync(join(DIST,"fonts",font)).size;
    assert.ok(fontsSize<60000, "total local font budget");
    for (const license of ["InstrumentSerif-OFL.txt", "Manrope-OFL.txt"]) {
      assert.ok(existsSync(join(DIST,"fonts",license)));
    }
  });

  it("avoids unsupported product claims", () => {
    const lower = html.toLowerCase();
    // Promise-shaped phrases only: honest framing such as "not instant" or
    // "can take several minutes" must keep passing.
    for (const pattern of [
      /instant(ly)? (setup|install|deploy|agent)/,
      /5-minute/,
      /5 minute setup/,
      /military-grade/,
      /bank-grade/,
      /100% uptime/,
      /\bguarantee[ds]?\b/,
      /testimonial/,
    ]) {
      assert.ok(!pattern.test(lower), `no unsupported claim matching ${pattern}`);
    }
    // Setup honesty is load-bearing copy: keep it.
    mustContain(html, "not instant", "honest setup framing");
    mustContain(html, "several minutes", "honest setup duration");
  });
});
