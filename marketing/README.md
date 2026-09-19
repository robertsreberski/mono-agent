# mono-agent marketing site

The prospective marketing site at **<https://mono-agent.dev/>** (not yet
deployed — see [Prospective deployment](#prospective-deployment)). A standalone
[Astro](https://astro.build/) static app: one crawlable HTML page, one
stylesheet, and one small local progressive-enhancement module. GitHub is the primary call to action; the
existing docs site is secondary.

## Architecture

- **`marketing/` is an isolated app.** It has its own `pnpm-workspace.yaml`,
  so it never enters the root `pnpm -r build`, `pnpm -r test`, release graph,
  or `check:architecture`. Install and build it on its own, following the
  `website/` precedent.
- **Content is authored in `src/pages/index.astro`.** The hero and the major
  `#configuration` section make `mono-agent.config.json` the central visual
  thesis, then connect its runtime, context, memory, tools, and channel blocks
  to the framework/package composition story. The displayed example is valid
  JSON and its keys/types are checked against the generated app schema. Every
  claim must be source-grounded; source-only showcases must be explicitly
  labelled and linked to release availability. The honesty rules live in a comment at
  the top of that file — read them before editing copy.
  `docs/reference/release-status.md` is the boundary reference: never present
  source-only capabilities as published, never promise setup speed or security properties, and never present
  the brand artwork as a screenshot.
- **Artwork is decorative.** `public/hero-*.{jpg,webp}` and
  `public/og-1200x630.jpg` are optimized derivatives of a supplied brand
  source (charcoal monolith, lime filament, no text). The source itself stays
  out of git at `marketing/assets-source/` (gitignored); regenerate with
  `pnpm run assets` after placing it there. The hero image carries empty `alt`
  plus a visually-hidden “not a product screenshot” caption.
- **SEO is tested, not assumed.** `tests/seo.test.mjs` audits the built
  `dist/`: title/description/canonical, absolute Open Graph/Twitter URLs, the
  real 1200×630 card dimensions, sitemap/robots, honest JSON-LD, single-H1
  structure, working anchors, the local script budget, and claim guards.

## Interaction design

The configuration blueprint and three outcome callouts are server-rendered,
including the caveats that identity/skills/MCP files, secrets/auth, and runtime
state remain separate. It is a readable example, not a fake editor or a deploy
control. The workflow field guide pairs three original SVG illustrations with
server-rendered Build, Research and Automate content. `public/interactions.js` progressively adds
ARIA tabs (arrow keys, Home/End, Enter/Space), direct workflow links, a copy-install
button with honest success/failure feedback, and the compact mobile menu.
All workflow content remains readable when JavaScript is disabled; FAQ disclosures
are native HTML. These are illustrative workflows, never live model output.

No model calls, analytics, third-party scripts or storage are used. Clipboard tests
stub success and refusal; they prove UI handling, not operating-system permission.
Motion is finite, disabled for reduced-motion users, and never
hijacks scrolling. Readable text does not fade through low-contrast states.

## Mobile composition and console evidence

The page deliberately has no pinned scroll narrative. A finite, reduced-motion-aware
connection reveal ties the JSON blueprint to its callouts. The mobile menu is a
keyboard-operable disclosure; links remain visible without JavaScript. JSON stays
server-rendered inside a native details element, initially collapsed on phones.

Console screenshots are real React UI rendered by the existing isolated browser
fixtures, with **synthetic example data**, not a live user's console or evidence of
model execution. The section labels the current source build and links release status.
Reproduce the input captures from repository root:

```bash
VITE_PROJECT_SHOTS="$PWD/marketing/output/console-capture" pnpm --dir packages/web/webapp run test:browser -- src/Project.browser.test.tsx
```

The command currently runs the whole browser suite (162 tests), including the capture
fixture. `dashboard-projects-desktop.png` is cropped to 1280×560, removing empty lower
space; its mobile counterpart is resized to 390px wide. Both become quality-85 WebP
assets under `public/console-*.webp`. No production console routes or private data
are used. The fixture represents project/conversation organization, not every control.

`pnpm run screenshots` captures the marketing hero, open mobile menu, blueprint,
console, workflows and setup at desktop1440×1000 and mobile390×844. No screenshot
dimension exceeds2000px. Output stays gitignored.

## Local development

```bash
# from this directory (marketing/)
pnpm install                 # isolated install — uses marketing/pnpm-lock.yaml
pnpm run dev                 # astro dev (live preview)
pnpm run build               # astro build + internal-link check
pnpm run test:unit           # SEO/asset/anchor contracts against dist/
pnpm exec playwright install chromium  # local audit browser, once
pnpm run test:browser        # serve dist/ and audit a11y + responsiveness
pnpm run screenshots         # capture output/*.png for human review (gitignored)
pnpm run assets              # regenerate public/ derivatives from assets-source/
```

`scripts/check-links.mjs` validates the built `dist/` (same shape as the
website's checker) and fails the build on a broken internal link.
`tests/site.browser.spec.ts` audits the previewed page in Chromium with axe
(zero WCAG 2.0 A/AA, 2.1 A/AA, or 2.2 AA violations), asserts no horizontal
overflow and visible hero CTAs at 1440×1000 and 390×844, and checks the skip
link, landmarks, section navigation, and reduced-motion handling.

## Accessibility gate

Run `pnpm run build` before `pnpm run test:browser`; the browser suite
intentionally audits the production-shaped output, not the dev server. This is
an automated baseline, not a claim of complete WCAG conformance; keyboard
navigation, responsive layouts, zoom, and prose clarity still need human review
when those surfaces change.

## Version pins — do not bump blindly

`package.json` pins the tested Astro 7 line (`astro ~7.2.8`, matching
`website/`) and `sharp 0.35.4` (matching the root security floor). Before
raising any site dependency, run the complete build and both test gates and
confirm metadata, card dimensions, and internal links still hold.

## Prospective deployment

The site is **not deployed yet**. When it is, the intended shape (mirroring
the docs site on Vercel) is:

- `vercel.json` pins `framework: astro`, `buildCommand: pnpm run build`,
  `outputDirectory: dist`.
- In the hosting project, set the project root to `marketing/` and the domain
  to `mono-agent.dev`.
- No environment variables, analytics, or backends are required — the output
  is static files only.

## CI

The repo's `ci.yml` runs a dedicated parallel **`marketing`** job: isolated
install, Chromium install, build (with link check), unit contracts against
the build, then the browser audit. Treat a red **`marketing`** check as a
merge blocker by convention, same as the `website` lane.
