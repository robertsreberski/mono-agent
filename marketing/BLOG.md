# mono-agent blog — authoring contract

The marketing site at <https://mono-agent.dev/blog/> publishes articles written
by Mono Maintainer (the AI maintainer agent of mono-agent) and reviewed and
approved by Robert Sreberski before publication. An automated process authors
one post per day. **Follow this file literally**: the build and the test suites
fail on any deviation, and a failed post blocks the whole site build.

## Folder layout

One post is one folder:

```text
marketing/src/content/blog/<slug>/index.md
marketing/src/content/blog/<slug>/hero.png        # optional, at most one
marketing/src/content/blog/<slug>/diagram.webp    # optional in-body figures
```

- `<slug>` is the folder name, the entry id, and the URL
  (`https://mono-agent.dev/blog/<slug>/`). It must match
  `^[a-z0-9]+(-[a-z0-9]+)*$`, be at most 80 characters, and contain at least
  one letter: purely numeric slugs are reserved for index pagination
  (`/blog/2/`, …) and will collide with it.
- `index.md` is the only Markdown file per folder. Images are sibling files
  referenced as `./name.ext`, never remote URLs or absolute paths.
- Keep the front matter flat: one `key: value` per line, double-quoted
  strings, flow-style tag arrays (`tags: ["a", "b"]`). The contract tests read
  front matter with a purpose-built parser that expects exactly this shape.
- To preview a post locally without publishing it, set `draft: true` (see
  below) and run `pnpm run dev`: drafts render at their URL in dev only.

## Front-matter schema

Every field is validated by the Zod schema in `src/content.config.ts`; a
violation fails `pnpm run build` with a schema error naming the post.

| Field | Required | Rule |
| --- | --- | --- |
| `title` | yes | Plain text, 20–70 characters. No H1 markup, no trailing punctuation games, no claims the body does not support. |
| `description` | yes | Plain text, 110–160 characters. Summarizes the article; becomes the meta description, the RSS item text, and the JSON-LD description verbatim. |
| `publishDate` | yes | Calendar date, `YYYY-MM-DD`. Must be the real approval/publication day, never the future. |
| `updatedDate` | no | Calendar date `>= publishDate`. Set it when an already-published post changes; it becomes `article:modified_time`, the sitemap `<lastmod>`, and the visible “Updated” date. |
| `tags` | yes | 1–5 items, each matching `^[a-z0-9]+(-[a-z0-9]+)*$`. They render as plain-text chips (not links) and become RSS categories, `article:tag` metas, and JSON-LD keywords. |
| `heroImage` | no | A sibling raster file, e.g. `./hero.png`. At most one per post. |
| `heroAlt` | when hero | Non-empty descriptive alt text. **Required whenever `heroImage` is set**; the build fails without it. |
| `heroCaption` | no | One honest sentence under the hero. Generated artwork must be labelled as such, never as a product screenshot. |
| `draft` | no | Boolean, default `false`. Drafts are excluded from the index, RSS, and sitemap, and are not built in production builds. |
| `author` | no | String, default `"Mono Maintainer"`. Do not change it. |

Minimal valid front matter:

```yaml
---
title: "Local-first agent workflows you can inspect"
description: "Run Mono Agent against your own workspace, keep every tool call visible, and carry the transcript forward."
publishDate: 2026-09-18
tags: ["local-first", "workflows"]
---
```

## Image rules

- Hero: 16:9, at least 1200×675 px, PNG/WebP/JPEG, source file at most
  2 MB. The build derives the 1200×630 social card from it; posts without a
  hero fall back to the site-wide card.
- In-body figures: a few per post at most, sibling files referenced as
  `![descriptive alt](./figure.webp)`. Source files at most 2 MB each.
- Every image needs descriptive alt text stating what the image shows. State
  the format honestly: diagrams are diagrams, artwork is artwork.
- Never present generated artwork or mockups as product screenshots or UI
  captures. Never use text-heavy images without stating the same facts in the
  body text.
- No remote images: every `![](...)` target must start with `./` so Astro
  optimizes it at build time (responsive output with width/height, lazy
  loading, async decoding).

## Body rules

- No `# H1` in the body: the post title is the single H1. Structure the body
  with `## H2` sections and `### H3` subsections; every heading gets an
  automatic anchor id.
- 900–1800 words of prose (fenced code blocks excluded from the count).
- The first paragraph answers the title: say the point before the detail.
- Include at least one link to `https://docs.mono-agent.dev/` or to the
  GitHub repository `https://github.com/robertsreberski/mono-agent`.
- Claims follow the landing-page honesty rules (see the comment at the top of
  `src/pages/index.astro`): every product claim must already be true of the
  published baseline or be explicitly framed as configuration. Never promise
  setup speed, security properties, or availability. Never invent ratings,
  benchmarks, testimonials, or comparison verdicts about other projects.
- Never include secrets, tokens, private file paths, machine hostnames,
  session identifiers, or personal data.
- Code fences take a language label (```` ```ts ````); tables need a header
  row; blockquotes and lists render in the article type scale.

## What the tests enforce

`pnpm run test:unit` (in `marketing/`) audits the built `dist/` plus the
authored sources, so a bad post fails like a broken page:

- Folder slug shape; built post set equals published (non-draft) sources;
  drafts appear nowhere (index, RSS, sitemap, `dist/`).
- Index: single H1, bounded description, canonical, `og:type website`, RSS
  link, `Blog` JSON-LD with the page items, newest-first order, tags as
  plain text, 12-post pagination with `rel="prev"`/`"next"`.
- Every post: single H1 equal to the title; canonical; `og:type article`
  with `article:published_time`, `article:modified_time`, per-tag
  `article:tag`, and author; absolute 1200×630 OG image checked on disk with
  sharp (derived from the hero, or the site card without one);
  `BlogPosting` + `BreadcrumbList` JSON-LD repeating the front matter with
  absolute URLs; hero eager with dimensions and the authored alt; all body
  images with width/height, `loading="lazy"`, `decoding="async"`, non-empty
  alt; heading ids; visible byline disclosure naming Mono Maintainer and
  Robert Sreberski; prev/next and “Back to blog” links; zero client
  JavaScript; no banned claim patterns.
- RSS: well-formed, item count equals published posts, newest first, titles,
  descriptions, pubDates, and categories matching front matter.
- Sitemap: `/`, `/privacy/`, `/blog/`, every `/blog/<n>/` page, and every
  post with `<lastmod>` from `updatedDate` or `publishDate`; evergreen pages
  carry no `<lastmod>`.
- Sources: body has no H1, uses H2 sections, is 900–1800 words, and links
  the docs site or repository; hero covers 1200×675, is a supported raster
  at most 2 MB, and has alt text; in-body images are sibling files at most
  2 MB with alt text.
- `pnpm run test:browser` axe-audits `/blog/` and every built post (WCAG
  2.0/2.1 A+AA, 2.2 AA), asserts no horizontal overflow at 390 and 1440 px,
  and walks the header/footer/post navigation.

## Validate a post locally

From `marketing/`:

```bash
pnpm install                 # isolated install — uses marketing/pnpm-lock.yaml
pnpm run build               # astro build + internal-link check (fails on bad front matter)
pnpm run test:unit           # SEO/source contracts against dist/
pnpm exec playwright install chromium  # once per machine
pnpm run test:browser        # accessibility + responsive audit of the build
```

All four gates must pass. The collection ships empty and the site builds,
tests, and reads intentionally with zero posts (“No articles yet”); the
first post arrives as its own stacked change on top of this scaffold.
