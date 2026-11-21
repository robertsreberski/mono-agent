// Built-output SEO and honesty contracts for the marketing site.
//
// Run after `pnpm run build` (from marketing/):
//   pnpm run test:unit
//
// Asserts on dist/ (the real rendered output): metadata, canonical and social
// URLs, sitemap/robots, honest JSON-LD, single-H1 structure, working anchors,
// decorative-art honesty, bounded local scripts, and asset size caps.
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import sharp from "sharp";
import { resolveSiteUrl, DEFAULT_SITE_URL } from "../src/site.mjs";
import {
  POSTS_PER_PAGE,
  countWords,
  isValidSlug,
  stripFences,
  toISODate,
} from "../src/blog.mjs";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BLOG_SOURCE = join(REPO_ROOT, "marketing/src/content/blog");
const SITE_URL = resolveSiteUrl();
const GITHUB_URL = "https://github.com/robertsreberski/mono-agent";
const DOCS_URL = "https://docs.mono-agent.dev/";
const BLOG_DESCRIPTION =
  "Notes on building an AI companion workspace with Mono Agent, written by the Mono Maintainer agent and reviewed by Robert Sreberski.";

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
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

// Text of the first element/attribute matching `pattern`, entity-decoded, so
// front matter containing quotes, apostrophes or ampersands compares equal.
function decodedMatch(html, pattern, label) {
  const match = html.match(pattern);
  assert.ok(match, `${label} must be present`);
  return decodeHtmlText(match[1]);
}

// Minimal front-matter reader for the flat blog schema documented in
// BLOG.md (quoted scalars, flow-style tag arrays, booleans). It mirrors the
// authored shape so the built output can be matched back to its source.
function parseBlogFrontMatter(source, slug) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${slug} must carry front matter`);
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `${slug} front matter line must be key: value (${line})`);
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (value === "true" || value === "false") {
      value = value === "true";
    }
    data[key] = value;
  }
  return data;
}

// Authored posts (including drafts) keyed by folder slug.
function readBlogSources() {
  if (!existsSync(BLOG_SOURCE)) return [];
  const entries = [];
  for (const name of readdirSync(BLOG_SOURCE)) {
    if (name.startsWith(".")) continue;
    const index = join(BLOG_SOURCE, name, "index.md");
    if (!existsSync(index)) continue;
    entries.push({ slug: name, data: parseBlogFrontMatter(readFileSync(index, "utf8"), name) });
  }
  return entries;
}

// Published posts newest-first, mirroring the site sort.
function publishedBlogSources() {
  return readBlogSources()
    .filter((entry) => !entry.data.draft)
    .sort((a, b) => new Date(b.data.publishDate) - new Date(a.data.publishDate));
}

// Built /blog/<segment>/ subpaths (post slugs and numeric pagination pages).
function listBuiltBlogSlugs() {
  if (!existsSync(join(DIST, "blog"))) return [];
  return readdirSync(join(DIST, "blog")).filter(
    (name) =>
      !name.startsWith(".") &&
      existsSync(join(DIST, "blog", name, "index.html")),
  );
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

// Visible copy: text content plus the attribute text assistive technology
// reads, without markup, scripts, templates or comments.
function visibleCopy(page) {
  const attrs = [...page.matchAll(/\s(?:alt|aria-label|title|data-note|data-role)="([^"]*)"/g)].map((m) => m[1]);
  const text = page
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<title>[\s\S]*?<\/title>/g, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlText(`${text} ${attrs.join(" ")}`).replace(/\s+/g, " ");
}

function textOf(fragment) {
  return decodeHtmlText(fragment.replace(/<[^>]+>/g, ""));
}

const EXAMPLE_ROOT = join(REPO_ROOT, "marketing/src/example-agent/payments-maintainer");
const exampleFile = (path) => readFileSync(join(EXAMPLE_ROOT, path), "utf8");

describe("marketing built output", () => {
  const html = readDist("index.html");

  it("declares the exact title, description, and canonical URL", () => {
    mustContain(html, "<title>The coworker in a folder — Mono Agent</title>", "exact <title>");
    const description = html.match(/<meta name="description" content="([^"]+)"\/?>/);
    assert.ok(description, "meta description must exist");
    assert.ok(description[1].length >= 100 && description[1].length <= 170,
      `meta description must be useful (${description[1].length} chars)`);
    mustContain(html, `<link rel="canonical" href="${SITE_URL}/"`, "canonical link");
    mustContain(html, 'lang="en"', "html lang");
    mustContain(html, 'name="viewport"', "viewport meta");
    mustContain(html, 'rel="icon"', "favicon link");
    assert.ok(!/name="robots" content="noindex/.test(html), "production page is indexable");
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
    // The card is a capture of the real homepage: both alts describe it.
    for (const attr of ["property=\"og:image:alt\"", "name=\"twitter:image:alt\""]) {
      const match = html.match(new RegExp(`<meta ${attr} content="([^"]+)"`));
      assert.ok(match, `${attr} must exist`);
      const alt = decodeHtmlText(match[1]);
      assert.ok(alt.includes("Mono Agent"), `${attr} names the brand`);
      assert.ok(alt.includes("The coworker in a folder"), `${attr} carries the headline`);
    }
  });

  it("keeps the ink drawings decorative and the console captures honest and bounded", async () => {
    const art = [...new Set([...html.matchAll(/(?:href|src|srcset)="(\/art\/[^"]+)"/g)].map((m) => m[1]))];
    assert.ok(art.length >= 20, `homepage references its art (${art.length})`);
    for (const rel of art) {
      const path = join(DIST, rel);
      assert.ok(existsSync(path), `dist${rel} must exist`);
      const meta = await sharp(path).metadata();
      assert.ok(meta.width <= 2200 && meta.height <= 2200, `${rel} stays bounded`);
      assert.ok(statSync(path).size < 180_000, `${rel} stays small`);
    }
    // Masked ink drawings are decorative SVG, hidden from assistive tech.
    for (const svg of html.match(/<svg[^>]*class="(?:hero-layer|pen-art)[^"]*"[^>]*>/g) ?? []) {
      assert.ok(svg.includes('aria-hidden="true"'), `decorative drawing is hidden: ${svg.slice(0, 60)}`);
    }
    // Real console captures, one per colour scheme, with alt text and the transcript.
    for (const [light, dark] of [["folder-console-light.webp", "folder-console-dark.webp"], ["folder-console-phone-light.webp", "folder-console-phone-dark.webp"]]) {
      mustContain(html, `srcset="/art/${dark}"`, `${dark} dark source`);
      const img = html.match(new RegExp(`<img[^>]*src="/art/${light}"[^>]*>`))?.[0];
      assert.ok(img, `${light} image exists`);
      assert.ok(/alt="[^"]{20,}"/.test(img), `${light} has descriptive alt`);
      assert.ok(img.includes('aria-describedby="capture-transcript"'), `${light} links the transcript`);
      const meta = await sharp(join(DIST, "art", light)).metadata();
      assert.equal(`${meta.width}x${meta.height}`, `${img.match(/width="(\d+)"/)[1]}x${img.match(/height="(\d+)"/)[1]}`, `${light} declares its real size`);
    }
    mustContain(html, 'id="capture-transcript"', "console transcript");
    mustContain(html, "Real console, example conversation", "console provenance");
    assert.ok(!/screenshot of|product screenshot|app screenshot/i.test(visibleCopy(html)), "no screenshot claims");
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


  it("keeps every page canonical, social URL and crawler endpoint on one production origin", () => {
    const sitemap = readDist("sitemap.xml");
    const pages = [["index.html", "/"], ["privacy/index.html", "/privacy/"], ["blog/index.html", "/blog/"]];
    for (const slug of listBuiltBlogSlugs()) pages.push([`blog/${slug}/index.html`, `/blog/${slug}/`]);
    for (const [file, path] of pages) {
      const page = readDist(file);
      assert.equal((page.match(/rel="canonical"/g) ?? []).length, 1);
      assert.equal((page.match(/<title>/g) ?? []).length, 1);
      assert.equal((page.match(/name="description"/g) ?? []).length, 1);
      mustContain(page, `rel="canonical" href="${SITE_URL}${path}"`, "per-page canonical");
      mustContain(page, `property="og:url" content="${SITE_URL}${path}"`, "matching social URL");
      mustContain(page, 'name="twitter:card" content="summary_large_image"', "per-page social card");
      mustContain(sitemap, `<loc>${SITE_URL}${path}</loc>`, "matching sitemap route");
      mustContain(page, 'name="robots" content="index, follow, max-image-preview:large"', "production indexing");
    }
    // Evergreen landing surfaces carry no modification dates; only dated blog
    // entries (index pages tracking their newest post, posts tracking their
    // front matter) may carry one.
    for (const block of sitemap.split("<url>").slice(1)) {
      const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
      const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
      if (loc === `${SITE_URL}/` || loc === `${SITE_URL}/privacy/`) {
        assert.ok(!lastmod, `${loc} carries no fabricated modification date`);
      }
    }
    const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const graph = data['@graph'];
    const software = graph.find(node => node['@type'] === 'SoftwareSourceCode');
    assert.equal(software.codeRepository, GITHUB_URL);
    assert.equal(software.programmingLanguage, 'TypeScript');
    assert.equal(software.license, `${GITHUB_URL}/blob/main/LICENSE`);
    assert.equal(graph.find(node => node['@type'] === 'WebPage').mainEntity['@id'], software['@id']);
    assert.ok(!graph.some(node => node['@type'] === 'Organization'), 'no social-card image misrepresented as an organization logo');
  });

  it("permits a verified domain migration but rejects preview and malformed canonicals", () => {
    assert.equal(DEFAULT_SITE_URL, 'https://mono-agent.dev');
    assert.equal(resolveSiteUrl('https://mono-agent.dev/'), 'https://mono-agent.dev');
    for (const invalid of ['http://mono-agent.dev', 'https://mono-agent.dev/path', 'https://mono-agent.dev/?x=1', 'https://mono-agent.dev/#part', 'https://user:password@mono-agent.dev', 'https://mono-agent.dev:8448', 'https://mono-agent-marketing-build.vercel.app', 'https://mono-agent-marketing.vercel.app']) {
      assert.throws(() => resolveSiteUrl(invalid));
    }
    const config = JSON.parse(readFileSync(join(REPO_ROOT,'marketing/vercel.json'),'utf8'));
    const rule = config.headers.find(rule => rule.headers.some(header => header.key === 'X-Robots-Tag'));
    const host = new RegExp(`^(?:${rule.has[0].value})$`);
    assert.ok(host.test('mono-agent-marketing-build-robert.vercel.app'));
    assert.ok(!host.test('mono-agent-marketing.vercel.app'));
    assert.ok(!host.test('mono-agent.dev'));
    assert.equal(rule.headers[0].value, 'noindex, follow');
  });

  it("keeps one H1 with the exact headline and resolves every anchor", () => {
    const h1s = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) ?? [];
    assert.equal(h1s.length, 1, "exactly one H1");
    assert.equal(textOf(h1s[0]).replace(/\s+/g, " ").trim(), "The coworker in a folder", "exact hero headline");
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
    assert.ok(anchors.length > 0, "in-page anchors exist");
    for (const anchor of anchors) {
      assert.ok(ids.has(anchor), `anchor #${anchor} resolves to an id`);
    }
    for (const plate of ["plate-i", "plate-ii", "plate-iii", "plate-iv", "plate-v"]) {
      mustContain(html, `id="${plate}"`, `${plate} anchor`);
    }
  });

  it("shows the real example config, valid against the generated schema", () => {
    const source = exampleFile("mono-agent.config.json");
    const config = JSON.parse(source);
    const schema = JSON.parse(readFileSync(
      join(REPO_ROOT, "packages/app/schema/mono-agent.config.schema.json"),
      "utf8",
    ));
    assertMatchesGeneratedSchema(config, schema);
    assert.equal(config.$schema, "https://mono-agent.dev/schema.json", "example points editors at the hosted schema");
    assert.equal(config.$schema, schema.$id, "hosted schema URL is the schema $id");
    const rendered = html.match(/<details data-path="mono-agent\.config\.json"[^>]*>[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/);
    assert.ok(rendered, "rendered configuration exists");
    assert.equal(decodeHtmlText(rendered[1]), source, "page shows the config byte-for-byte");
    // Keys and sign-ins stay out of the shared files.
    assert.ok(!/(token|secret|apiKey|password)"\s*:/i.test(source), "config keeps secrets out");
    for (const line of exampleFile(".env.example").trimEnd().split("\n")) {
      assert.match(line, /^(#.*|[A-Z][A-Z0-9_]*=)$/, `.env.example carries key names only: ${line}`);
    }
  });

  it("renders decorative arrows as accessible SVG, never emoji-prone text", () => {
    const glyphs = /[↗↓↑←→↖↘↙]/u;
    assert.ok(!glyphs.test(html), "built HTML has no Unicode arrow glyphs");
    assert.ok(!glyphs.test(readDist("styles.css")), "built CSS has no Unicode arrow glyphs");
    assert.ok(!glyphs.test(readDist("folder.js")), "enhancement script has no Unicode arrow glyphs");
    const marks = [...html.matchAll(/<svg[^>]*class="(?:tab-arrow|github-mark)"[^>]*>/g)].map((m) => m[0]);
    assert.ok(marks.length >= 3, `expected SVG arrows and marks (${marks.length})`);
    for (const mark of marks) {
      assert.ok(mark.includes('aria-hidden="true"'), "decorative mark is hidden from assistive tech");
      assert.ok(mark.includes('focusable="false"'), "decorative mark cannot receive focus");
    }
  });

  it("leads with the tutorial and keeps GitHub and docs one click away", () => {
    const start = html.match(/<div class="start">([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.match(start, /<a class="index-tab primary-tab[^"]*" href="https:\/\/docs\.mono-agent\.dev\/getting-started\/tutorial\/">Build your first agent/);
    assert.ok(start.includes(`href="${GITHUB_URL}"`), "hero links GitHub");
    const githubCount = html.split(`href="${GITHUB_URL}"`).length - 1;
    assert.ok(githubCount >= 3, `GitHub linked repeatedly (${githubCount})`);
    assert.ok(html.includes(`href="${DOCS_URL}"`), "docs links present");
  });

  it("loads bounded local enhancement and consent-gated analytics modules", () => {
    const scripts = [...html.matchAll(/<script(?![^>]*ld\+json)[^>]*>/g)].map(m => m[0]);
    assert.equal(scripts.length, 3);
    for (const [asset, budget] of [["folder.js", 12_000], ["analytics.js", 9_000]]) {
      assert.ok(scripts.some(script => script.includes(`src="/${asset}"`) && script.includes('type="module"')), `${asset} loads as a module`);
      assert.ok(statSync(join(DIST, asset)).size < budget, `${asset} stays under ${budget} bytes`);
    }
    const sdk = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].find(match => match[1].includes('vercel-analytics'));
    assert.ok(sdk && Buffer.byteLength(sdk[1]) < 9000, "bounded bundled native Astro SDK");
    assert.match(html, /<template[^>]*id="analytics-template"[^>]*>[\s\S]*?<vercel-analytics[\s\S]*?<\/template>/);
    assert.ok(!html.replace(/<template[\s\S]*?<\/template>/g, '').includes('<vercel-analytics'), 'no active analytics element before consent');
    assert.ok(!html.includes('posthog'));
  });

  it("compares tools by what you reach for, not by ranking", () => {
    const selection = html.match(/<dl class="selection">([\s\S]*?)<\/dl>/)?.[1] ?? "";
    assert.deepEqual(
      [...selection.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]),
      ["Mono Agent", "Claude Code", "OpenClaw", "Hermes Agent", "Mastra"],
    );
    mustContain(html, "Same files, not necessarily the same answers.", "comparison limit");
    for (const retired of ["harness-row", "block-chapter", "data-workflow-explorer", "agent-map"]) {
      assert.ok(!html.includes(retired), `retired ${retired} UI is removed`);
    }
  });

  it("keeps the approved v0.27.1 claims and copy rules", () => {
    const copy = visibleCopy(html);
    assert.match(html, /<p class="cover-release-line">v0\.27\.1 · <time datetime="2026-11-16">16 Nov 2026<\/time> · GPL-3\.0<\/p>/);
    for (const route of ["anthropic:claude-opus-5-5", "openai-codex:gpt-6.1-sol", "opencode-go:deepseek-v4.1-flash", "ollama:gemma4:31b"]) {
      assert.ok(copy.replace(/\s/g, "").includes(route), `model route ${route}`);
    }
    mustContain(copy, "There’s no login, so keep it on a network you trust.", "console exposure warning");
    mustContain(copy, "You’ll also need a model", "model prerequisite");
    mustContain(copy, "Example · read-only", "example label");
    mustContain(copy, "Example", "example slip");
    mustContain(html, `href="${GITHUB_URL}/releases/tag/v0.27.1"`, "release notes match the version line");
    for (const word of ["specimen", "plate", "terminal", "coupon", "fictional"]) {
      assert.ok(!new RegExp(`\\b${word}`, "i").test(copy), `visible copy never says "${word}"`);
    }
  });

  it("self-hosts only the five subset fonts with their licenses", () => {
    const fonts = ["source-serif-4.woff2", "barlow-condensed-500.woff2", "barlow-condensed-700.woff2", "courier-prime-400.woff2", "courier-prime-700.woff2"];
    let total = 0;
    for (const font of fonts) total += statSync(join(DIST, "fonts", font)).size;
    assert.ok(total < 130_000, `total local font budget (${total})`);
    for (const license of ["SourceSerif4-OFL.txt", "BarlowCondensed-OFL.txt", "CourierPrime-OFL.txt"]) {
      assert.match(readDist(`fonts/${license}`), /SIL Open Font License, Version 1\.1/, license);
    }
    assert.deepEqual(readdirSync(join(DIST, "fonts")).sort(), [...fonts, "SourceSerif4-OFL.txt", "BarlowCondensed-OFL.txt", "CourierPrime-OFL.txt"].sort(), "no retired fonts ship");
    for (const retired of ["hero-1440.webp", "console-desktop.webp", "interactions.js"]) {
      assert.ok(!existsSync(join(DIST, retired)), `retired ${retired} is gone`);
    }
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html + readDist("styles.css")), "no font-provider requests");
  });

  it("avoids unsupported product claims", () => {
    const lower = visibleCopy(html).toLowerCase();
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
  });
});

describe("marketing blog", () => {
  const sources = readBlogSources();
  const published = publishedBlogSources();
  const drafts = sources.filter((entry) => entry.data.draft);
  const built = listBuiltBlogSlugs();
  const builtPosts = built.filter((segment) => !/^\d+$/.test(segment));
  const builtPages = built.filter((segment) => /^\d+$/.test(segment));

  it("derives slugs from valid folder names and builds exactly the published posts", () => {
    for (const { slug } of sources) {
      assert.ok(isValidSlug(slug), `blog folder ${slug} is a valid slug`);
    }
    assert.deepEqual(
      [...builtPosts].sort(),
      published.map((entry) => entry.slug).sort(),
      "dist/blog/ holds exactly the published posts",
    );
    for (const { slug } of drafts) {
      assert.ok(!built.includes(slug), `draft ${slug} is not built`);
    }
  });

  it("keeps the blog index honest, linked, and described", () => {
    const html = readDist("blog/index.html");
    mustContain(html, "<title>Blog — mono-agent</title>", "index title");
    const description = html.match(/<meta name="description" content="([^"]+)"\/?>/);
    assert.ok(description, "index meta description must exist");
    assert.ok(
      description[1].length > 0 && description[1].length <= 160,
      `index description is bounded (${description[1].length} chars)`,
    );
    mustContain(html, `<link rel="canonical" href="${SITE_URL}/blog/"`, "index canonical");
    mustContain(html, `<meta property="og:url" content="${SITE_URL}/blog/"`, "index social URL");
    mustContain(html, '<meta property="og:type" content="website"', "index og:type website");
    mustContain(
      html,
      '<link rel="alternate" type="application/rss+xml" title="mono-agent blog" href="/blog/rss.xml"',
      "index RSS link",
    );
    const h1s = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) ?? [];
    assert.equal(h1s.length, 1, "index has exactly one H1");
    assert.ok(h1s[0].includes("Blog"), "index H1 names the blog");
    mustContain(html, "Mono Maintainer", "index names the author");
    mustContain(html, "Robert Sreberski", "index names the reviewer");

    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(ld["@type"], "Blog", "index JSON-LD is a Blog");
    assert.ok(Array.isArray(ld.blogPost), "index JSON-LD lists blog posts");

    if (published.length === 0) {
      mustContain(html, "No articles yet", "empty state stays honest");
      assert.equal(ld.blogPost.length, 0, "empty index lists no posts");
      assert.ok(!html.includes('class="blog-list"'), "empty index renders no list");
    } else {
      assert.equal(
        ld.blogPost.length,
        Math.min(published.length, POSTS_PER_PAGE),
        "index JSON-LD covers the page items",
      );
      const listed = [...html.matchAll(/<h2>\s*<a href="\/blog\/([^"/]+)\/">/g)].map((m) => m[1]);
      assert.deepEqual(
        listed,
        published.slice(0, POSTS_PER_PAGE).map((entry) => entry.slug),
        "index lists posts newest first",
      );
      // Tags render as plain text chips, never links.
      const tagBlocks = [...html.matchAll(/<ul class="blog-tags"[^>]*>([\s\S]*?)<\/ul>/g)];
      assert.equal(tagBlocks.length, Math.min(published.length, POSTS_PER_PAGE), "every item tags itself");
      for (const block of tagBlocks) {
        assert.ok(!block[1].includes("<a "), "tags are not links");
      }
      assert.ok(html.includes("<time datetime=\"20"), "index dates use ISO <time>");
    }
  });

  it("paginates the index at twelve posts per page", () => {
    const expectedPages = Math.max(1, Math.ceil(published.length / POSTS_PER_PAGE));
    const expectedNumeric = [];
    for (let page = 2; page <= expectedPages; page++) expectedNumeric.push(String(page));
    assert.deepEqual([...builtPages].sort(), expectedNumeric, "pagination pages on disk");
    for (let page = 2; page <= expectedPages; page++) {
      const html = readDist(`blog/${page}/index.html`);
      mustContain(html, `<link rel="canonical" href="${SITE_URL}/blog/${page}/"`, `page ${page} canonical`);
      mustContain(html, `<link rel="prev" href="/blog${page === 2 ? "/" : `/${page - 1}/`}"`, `page ${page} prev link`);
      if (page < expectedPages) {
        mustContain(html, `<link rel="next" href="/blog/${page + 1}/"`, `page ${page} next link`);
      }
    }
    const first = readDist("blog/index.html");
    if (expectedPages > 1) {
      mustContain(first, '<link rel="next" href="/blog/2/"', "first page next link");
      assert.ok(!first.includes('rel="prev"'), "first page has no prev link");
    } else {
      assert.ok(!first.includes('rel="prev"') && !first.includes('rel="next"'), "single page links nowhere");
    }
  });

  it("serves a well-formed newest-first RSS feed without drafts", () => {
    const rss = readDist("blog/rss.xml");
    assert.ok(rss.startsWith("<?xml"), "RSS declares XML");
    mustContain(rss, '<rss version="2.0">', "RSS envelope");
    mustContain(rss, "<title>mono-agent blog</title>", "feed title");
    mustContain(rss, BLOG_DESCRIPTION, "feed description");
    const items = [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    assert.equal(items.length, published.length, "feed item count matches published posts");
    const links = items.map((item) => item.match(/<link>([^<]+)<\/link>/)[1]);
    assert.deepEqual(
      links,
      published.map((entry) => `${SITE_URL}/blog/${entry.slug}/`),
      "feed links newest first with absolute URLs",
    );
    for (const [index, item] of items.entries()) {
      const { slug, data } = published[index];
      assert.equal(decodedMatch(item, /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/, `${slug} feed title`), data.title, `${slug} feed title matches front matter`);
      assert.equal(decodedMatch(item, /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/, `${slug} feed description`), data.description, `${slug} feed description matches front matter`);
      assert.ok(/<pubDate>[^<]+<\/pubDate>/.test(item), `${slug} feed pubDate`);
      assert.ok(
        item.includes(`<pubDate>${new Date(data.publishDate).toUTCString()}</pubDate>`),
        `${slug} feed pubDate matches front matter`,
      );
      for (const tag of data.tags) {
        mustContain(item, `<category>${tag}</category>`, `${slug} feed category ${tag}`);
      }
    }
    for (const { slug } of drafts) {
      assert.ok(!rss.includes(`/blog/${slug}/`), `draft ${slug} stays out of the feed`);
    }
  });

  it("lists the blog in the sitemap with honest lastmod dates", () => {
    const sitemap = readDist("sitemap.xml");
    mustContain(sitemap, `<loc>${SITE_URL}/blog/</loc>`, "sitemap blog index");
    const expectedPages = Math.max(1, Math.ceil(published.length / POSTS_PER_PAGE));
    for (let page = 2; page <= expectedPages; page++) {
      mustContain(sitemap, `<loc>${SITE_URL}/blog/${page}/</loc>`, `sitemap pagination page ${page}`);
    }
    assert.ok(
      !sitemap.includes(`<loc>${SITE_URL}/blog/${expectedPages + 1}/</loc>`),
      "sitemap lists no phantom pagination page",
    );
    for (const { slug, data } of published) {
      const lastmod = toISODate(data.updatedDate ?? data.publishDate);
      mustContain(
        sitemap,
        `<loc>${SITE_URL}/blog/${slug}/</loc><lastmod>${lastmod}</lastmod>`,
        `${slug} sitemap entry with lastmod`,
      );
    }
    for (const { slug } of drafts) {
      assert.ok(!sitemap.includes(`/blog/${slug}/`), `draft ${slug} stays out of the sitemap`);
    }
  });

  it("audits every built post page end to end", async () => {
    assert.ok(builtPosts.length === published.length, "post loop covers the build");
    const seenPrev = new Set();
    const seenNext = new Set();
    for (const { slug, data } of published) {
      const html = readDist(`blog/${slug}/index.html`);
      const canonical = `${SITE_URL}/blog/${slug}/`;

      // Headline and head metadata match the authored front matter.
      const h1s = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) ?? [];
      assert.equal(h1s.length, 1, `${slug} has exactly one H1`);
      assert.equal(decodeHtmlText(h1s[0].replace(/<[^>]+>/g, "")).trim(), data.title, `${slug} H1 is the title`);
      assert.ok(!/<div class="blog-body">[\s\S]*<h1/.test(html), `${slug} body carries no H1`);
      assert.equal(decodedMatch(html, /<title>([^<]*)<\/title>/, `${slug} title tag`), `${data.title} — mono-agent blog`, `${slug} title tag matches front matter`);
      assert.equal(decodedMatch(html, /<meta name="description" content="([^"]*)"/, `${slug} meta description`), data.description, `${slug} meta description matches front matter`);
      mustContain(html, `<link rel="canonical" href="${canonical}"`, `${slug} canonical`);
      mustContain(html, `<meta property="og:url" content="${canonical}"`, `${slug} social URL`);
      mustContain(html, '<meta property="og:type" content="article"', `${slug} og:type article`);
      mustContain(
        html,
        `<meta property="article:published_time" content="${new Date(data.publishDate).toISOString()}"`,
        `${slug} published_time`,
      );
      const modified = new Date(data.updatedDate ?? data.publishDate).toISOString();
      mustContain(html, `<meta property="article:modified_time" content="${modified}"`, `${slug} modified_time`);
      mustContain(html, '<meta property="article:author" content="Mono Maintainer"', `${slug} author meta`);
      for (const tag of data.tags) {
        mustContain(html, `<meta property="article:tag" content="${tag}"`, `${slug} tag meta ${tag}`);
      }
      mustContain(
        html,
        '<link rel="alternate" type="application/rss+xml" title="mono-agent blog" href="/blog/rss.xml"',
        `${slug} RSS link`,
      );

      // Social image is absolute, JPEG, and really 1200x630 on disk.
      const ogImage = html.match(/<meta property="og:image" content="([^"]+)"\/?>/)[1];
      assert.ok(ogImage.startsWith(`${SITE_URL}/`), `${slug} OG image is absolute`);
      assert.ok(!ogImage.includes("/og-") || ogImage === `${SITE_URL}/og-1200x630.jpg`, `${slug} fallback is the site card`);
      const ogFile = join(DIST, new URL(ogImage).pathname.replace(/^\//, ""));
      assert.ok(existsSync(ogFile), `${slug} OG image exists in dist`);
      const meta = await sharp(ogFile).metadata();
      assert.equal(meta.width, 1200, `${slug} OG image width`);
      assert.equal(meta.height, 630, `${slug} OG image height`);

      // Structured data parses and repeats the front matter with absolute URLs.
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      assert.equal(blocks.length, 1, `${slug} ships one JSON-LD block`);
      const jsonLd = JSON.parse(blocks[0][1]);
      const posting = jsonLd["@graph"].find((node) => node["@type"] === "BlogPosting");
      assert.ok(posting, `${slug} BlogPosting exists`);
      assert.equal(posting.headline, data.title, `${slug} headline`);
      assert.equal(posting.description, data.description, `${slug} JSON-LD description`);
      assert.equal(posting.datePublished, new Date(data.publishDate).toISOString(), `${slug} datePublished`);
      assert.equal(posting.dateModified, modified, `${slug} dateModified`);
      assert.deepEqual(posting.author, { "@type": "Person", name: "Mono Maintainer" }, `${slug} author`);
      assert.equal(posting.publisher.name, "mono-agent", `${slug} publisher`);
      assert.equal(posting.publisher.url, SITE_URL, `${slug} publisher URL`);
      assert.equal(posting.mainEntityOfPage, canonical, `${slug} main entity`);
      assert.equal(posting.keywords, data.tags.join(", "), `${slug} keywords`);
      const crumbs = jsonLd["@graph"].find((node) => node["@type"] === "BreadcrumbList");
      assert.deepEqual(
        crumbs.itemListElement.map((item) => [item.position, item.name, item.item]),
        [
          [1, "Home", `${SITE_URL}/`],
          [2, "Blog", `${SITE_URL}/blog/`],
          [3, data.title, canonical],
        ],
        `${slug} breadcrumbs`,
      );
      const serialized = JSON.stringify(jsonLd);
      for (const banned of ["review", "Review", "rating", "Rating", "offers", "Offers", "price"]) {
        assert.ok(!serialized.includes(banned), `${slug} JSON-LD invents no ${banned}`);
      }

      // Hero honesty: eager above-the-fold image with real alt, or no hero at all.
      if (data.heroImage) {
        assert.ok(html.includes('<figure class="blog-hero">'), `${slug} renders the hero figure`);
        const hero = html.match(/<figure class="blog-hero">[\s\S]*?<img[^>]*>/)[0];
        assert.equal(decodedMatch(hero, /alt="([^"]*)"/, `${slug} hero alt`), data.heroAlt, `${slug} hero alt matches front matter`);
        assert.ok(!/alt=""/.test(hero), `${slug} hero alt is non-empty`);
        assert.ok(hero.includes('loading="eager"'), `${slug} hero loads eagerly`);
        assert.ok(hero.includes('fetchpriority="high"'), `${slug} hero is fetch-prioritized`);
        assert.ok(/width="\d+" height="\d+"/.test(hero), `${slug} hero sets dimensions`);
        assert.ok(ogImage !== `${SITE_URL}/og-1200x630.jpg`, `${slug} hero drives the social image`);
      } else {
        assert.ok(!html.includes("blog-hero"), `${slug} renders no hero figure`);
        assert.equal(ogImage, `${SITE_URL}/og-1200x630.jpg`, `${slug} falls back to the site card`);
      }

      // Every image carries dimensions; body images lazy-load without shifting layout.
      for (const img of html.match(/<img[^>]*>/g) ?? []) {
        assert.ok(/width="\d+" height="\d+"/.test(img), `${slug} image sets dimensions: ${img.slice(0, 80)}…`);
      }
      const inBody = html.slice(html.indexOf('<div class="blog-body">'));
      for (const img of inBody.match(/<img[^>]*>/g) ?? []) {
        assert.ok(img.includes('loading="lazy"'), `${slug} body image lazy-loads`);
        assert.ok(img.includes('decoding="async"'), `${slug} body image decodes async`);
        const alt = img.match(/alt="([^"]*)"/)?.[1] ?? "";
        assert.ok(alt.length > 0, `${slug} body image has alt text`);
      }
      assert.ok(!/<h[23](?![^>]*id=)/.test(html), `${slug} headings carry ids`);

      // Visible byline disclosure, dates, reading time, and post navigation.
      mustContain(html, "By Mono Maintainer", `${slug} byline`);
      mustContain(html, "reviewed and approved by Robert Sreberski", `${slug} review disclosure`);
      mustContain(html, `<time datetime="${toISODate(data.publishDate)}"`, `${slug} publish <time>`);
      if (data.updatedDate) {
        mustContain(html, `<time datetime="${toISODate(data.updatedDate)}"`, `${slug} updated <time>`);
      }
      mustContain(html, "min read", `${slug} reading time`);
      mustContain(html, '<a href="/blog/">Back to blog</a>', `${slug} back link`);
      for (const rel of ["prev", "next"]) {
        const nav = html.match(new RegExp(`<a rel="${rel}" href="(/blog/[^"/]+/)"`));
        if (nav) {
          (rel === "prev" ? seenPrev : seenNext).add(slug);
          assert.ok(
            published.some((entry) => `/blog/${entry.slug}/` === nav[1]),
            `${slug} ${rel} link resolves to a built post`,
          );
        }
      }

      // No client scripts and no unsupported claims on article pages.
      assert.equal(
        (html.match(/<script(?![^>]*ld\+json)/g) ?? []).length,
        0,
        `${slug} ships no client JavaScript`,
      );
      const lower = decodeHtmlText(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").toLowerCase();
      for (const pattern of [
        /instant(ly)? (setup|install|deploy|agent)/,
        /5-minute/,
        /5 minute setup/,
        /military-grade/,
        /bank-grade/,
        /100% uptime/,
        /\bguarantee[ds]?\b/,
        /testimonial/,
        /screenshot of|product screenshot|app screenshot/i,
      ]) {
        assert.ok(!pattern.test(lower.replaceAll("not a product screenshot", "")), `${slug} avoids ${pattern}`);
      }
    }
    if (published.length >= 2) {
      assert.ok(seenPrev.size > 0 && seenNext.size > 0, "adjacent posts link both directions");
    }
  });

  it("holds authored sources to the BLOG.md contract", async () => {
    for (const { slug, data } of published) {
      const dir = join(BLOG_SOURCE, slug);
      const source = readFileSync(join(dir, "index.md"), "utf8");
      const body = source.slice(source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)[0].length);

      // Body structure: no H1, H2/H3 sections, 900–1800 words outside code,
      // and at least one internal link to the docs site or repository.
      const prose = stripFences(body);
      assert.ok(!/^# /m.test(prose), `${slug} body carries no H1`);
      assert.ok(/^## /m.test(prose), `${slug} body uses H2 sections`);
      const words = countWords(body);
      assert.ok(
        words >= 900 && words <= 1800,
        `${slug} body is 900–1800 words (${words})`,
      );
      assert.ok(
        body.includes("https://docs.mono-agent.dev/") ||
          body.includes("https://github.com/robertsreberski/mono-agent"),
        `${slug} body links the docs site or repository`,
      );

      // Hero source image: sibling raster file, large enough for the
      // 1200x630 social crop, bounded, with a real alt text.
      if (data.heroImage) {
        assert.ok(data.heroImage.startsWith("./"), `${slug} hero is a sibling file`);
        assert.match(data.heroImage, /\.(png|webp|jpe?g)$/i, `${slug} hero is a supported raster`);
        const heroFile = join(dir, data.heroImage.replace(/^\.\//, ""));
        assert.ok(existsSync(heroFile), `${slug} hero file exists`);
        const heroMeta = await sharp(heroFile).metadata();
        assert.ok(
          heroMeta.width >= 1200 && heroMeta.height >= 675,
          `${slug} hero covers 1200x675 (${heroMeta.width}x${heroMeta.height})`,
        );
        assert.ok(statSync(heroFile).size <= 2_000_000, `${slug} hero source stays small`);
        assert.ok(data.heroAlt && data.heroAlt.length > 0, `${slug} hero alt is non-empty`);
      }

      // In-body figures: sibling files with descriptive alt text, no remote art.
      for (const match of prose.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
        const [, alt, target] = match;
        assert.ok(target.startsWith("./"), `${slug} body image is a sibling file (${target})`);
        assert.ok(alt.trim().length > 0, `${slug} body image has alt text`);
        const imageFile = join(dir, target.replace(/^\.\//, "").split("#")[0].split("?")[0]);
        assert.ok(existsSync(imageFile), `${slug} body image exists (${target})`);
        assert.ok(statSync(imageFile).size <= 2_000_000, `${slug} body image stays small (${target})`);
      }
    }
  });

  it("links the blog from the landing footer and head", () => {
    const html = readDist("index.html");
    mustContain(
      html,
      '<link rel="alternate" type="application/rss+xml" title="mono-agent blog" href="/blog/rss.xml"',
      "landing links the feed",
    );
    const footer = html.slice(html.indexOf('<footer class="colophon">'));
    assert.ok(html.includes('<footer class="colophon">'), "landing has the colophon footer");
    mustContain(footer, '<li><a href="/blog/">Blog</a></li>', "landing footer links the blog");
    mustContain(footer, '<li><a href="/privacy/">Privacy</a></li>', "landing footer links privacy");
  });
});
