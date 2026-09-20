# mono-agent marketing site

The prospective marketing site at **<https://mono-agent.dev/>** (not yet
deployed — see [Prospective deployment](#prospective-deployment)). A standalone
[Astro](https://astro.build/) static app: one crawlable HTML page, one
stylesheet, and one small local progressive-enhancement module (under 8.5 kB uncompressed). GitHub is the primary call to action; the
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
- **Artwork is decorative.** The transparent matte basalt-stone stack
  is used once in the hero. `public/hero-*.webp` preserve alpha;
  there is no baked background or CSS mask hiding an image seam. The social card
  is composed deterministically from the same sculpture. The local source PNG lives
  at `assets-source/sculpture.png` (gitignored).
  Regenerate committed derivatives with `pnpm run assets`. The hero is never
  presented as product UI. Original generation is not reproducible from this
  repository alone; the optimized files are committed so builds need no generator.
- **Typography is self-hosted.** Manrope and Instrument Serif are bundled under
  their SIL Open Font Licenses in `public/fonts/`, sourced from the Google Fonts
  `google/fonts` repository's `ofl/manrope` and `ofl/instrumentserif` directories.
  Shipped files use Google Fonts' Latin WOFF2 subsets (55,300 bytes total),
  not the larger original TTFs.
  The page makes no runtime font-provider requests. The CSS uses one continuous
  dark canvas and a single responsive stylesheet rather than layered legacy themes.
- **SEO is tested, not assumed.** `tests/seo.test.mjs` audits the built
  `dist/`: title/description/canonical, absolute Open Graph/Twitter URLs, the
  real 1200×630 card dimensions, sitemap/robots, honest JSON-LD, single-H1
  structure, working anchors, the local script budget, and claim guards.

## Interaction design

The configuration blueprint and twelve linked building blocks are server-rendered,
including the caveats that identity/skills/MCP files, secrets/auth, and runtime
state remain separate. It is a readable example, not a fake editor or a deploy
control. The workflow field guide presents concise, server-rendered Build,
Research and Automate content without repeated decorative illustrations. `public/interactions.js` progressively adds
ARIA tabs (arrow keys, Home/End, Enter/Space), direct workflow links, a copy-install
button with honest success/failure feedback, and the compact mobile menu.
All workflow content remains readable when JavaScript is disabled; FAQ disclosures
are native HTML. These are illustrative workflows, never live model output.

No model calls, analytics, third-party scripts or storage are used. Clipboard tests
stub success and refusal; they prove UI handling, not operating-system permission.
Motion is finite, disabled for reduced-motion users, and never
hijacks scrolling. Readable text does not fade through low-contrast states.

## Mobile composition and console evidence

The JSON configuration is always rendered visibly, including on phones without
JavaScript. A dedicated square mobile hero preserves the complete stone silhouette and stays above the CTAs. Phones request 320px/640px WebP sources
instead of the larger desktop variants, including at high device pixel ratios.

Simple colored cards summarize twelve capabilities across all screen sizes. They
open from a compact deck into their reading grid, tied reversibly to native scroll.
Phones get a two-column composition rather than a scaled-down desktop scene.
There is no pinned scene, orbital imagery, phase switching, or continuous animation
loop. A pause button and keyboard focus reveal the static grid; reduced-motion/no-JS
modes do the same. The hero tilts by at most two degrees while scrolling away. Workflows identify the useful
components and repeated work they help remove. Repeated blueprint callouts are
removed because the same capabilities already appear in the cards.

The console image is the actual desktop App, Messages and Composer, captured at
1280×900 CSS pixels with 1.5× device scale (1920×1350 pixels), encoded losslessly.
It is never replaced with a phone screenshot or cropped on small screens; the
full-resolution link supports closer inspection. **Conversation, API and event
connection state are synthetic**. This proves UI rendering, not live inference,
backend availability, or model compatibility. Current-source features link release
availability explicitly.

Reproduce it after installing webapp dependencies and Chromium:

```bash
node marketing/scripts/capture-console.mjs
```

The script derives a temporary browser fixture from the existing ModelMarkers suite,
uses the genuine App/provider tree and its three assertions, and removes temporary
files in `finally`. It refuses to overwrite existing files. Synthetic EventSource
open events produce the deliberately configured fixture connection state without
contacting a running console. The asset is `marketing/public/console-desktop.webp`.
Review this recipe if the source fixture changes. No production data is used.

`pnpm run screenshots` captures desktop1440×1000 and mobile390×844 views, including
the building-block cards. Add `-- --video` for a genuine browser scroll recording.
No screenshot dimension exceeds2000px. Output stays gitignored.

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
