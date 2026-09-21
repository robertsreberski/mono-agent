# mono-agent marketing site

The marketing site at **<https://mono-agent.dev/>**, with documentation separately hosted at **<https://docs.mono-agent.dev/>** (see [Hosting](#hosting)). A standalone
[Astro](https://astro.build/) static app: one crawlable HTML page, one
stylesheet, a consent-gated analytics module, and one small local progressive-enhancement module (under 8.5 kB uncompressed). GitHub is the primary call to action; the
existing docs site is secondary.

## Architecture

- **`marketing/` is an isolated app.** It has its own `pnpm-workspace.yaml`,
  so it never enters the root `pnpm -r build`, `pnpm -r test`, release graph,
  or `check:architecture`. Install and build it on its own, following the
  `website/` precedent.
- **Content is authored in `src/pages/index.astro`.** The hero leads with an agent workspace you can build on: an embeddable AI companion, user-selected models and behavior, tool-powered work, and TypeScript composition. The major
  `#configuration` section makes `mono-agent.config.json` the visible blueprint
  behind those benefits. The displayed example is valid
  JSON and its keys/types are checked against the generated app schema. Every
  claim must be source-grounded; source-only showcases must be explicitly
  labelled and linked to release availability. The honesty rules live in a comment at
  the top of that file — read them before editing copy.
  The pinned release notes and published app/web tarballs summarized by the canonical
  `docs/reference/release-status.md` confirm projects, tags, persistent subagents,
  browser-first setup, and the loopback/explicit-sharing console defaults are released.
  That page records the current published-versus-source boundary. Never present
  source-only capabilities as published, never promise setup speed or security
  properties, and never present
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
control. The proof sequence is customize, delegate, inspect. A TypeScript
composition excerpt names the configured responder; it is not a runnable app and links
the imports and complete integration example. A source-linked comparison puts Hermes and OpenClaw alongside Mono Agent,
then covers Codex CLI, Claude Code, and OpenCode in a native disclosure. It compares documented focus, not
feature absence, exclusivity, or benchmark performance. All comparison content is
server-rendered. The enhancement script handles the menu, deck, and copy command;
FAQ disclosures are native HTML.

No model calls are made. The native Vercel Analytics component stays inert until consent; only then does it load the provider collection script, with details below. Clipboard tests
stub success and refusal; they prove UI handling, not operating-system permission.
Motion is finite, disabled for reduced-motion users, and never
hijacks scrolling. Readable text does not fade through low-contrast states.

## Mobile composition and console evidence

The JSON configuration is always rendered visibly, including on phones without
JavaScript. A dedicated square mobile hero preserves the complete stone silhouette and stays above the CTAs. Phones request 320px/640px WebP sources
instead of the larger desktop variants, including at high device pixel ratios.

Four colored cards pair concise capability summaries with distinct configuration,
connection, delegation, and continuity diagrams. All twelve documentation links stay
server-rendered as compact chips. With motion enabled, the same real cards become a
short sticky deck: the focused card lifts forward, arcs aside, and reveals the offset
layer below as native page scroll advances or reverses. A short reading beat separates
each eased throw; settled cards are opaque and tossed cards disappear completely. The 740px mobile / 1,000px
desktop stage never intercepts scrolling. Mobile card faces are 250px high (350px
on narrow 320px screens where readable text needs more room). Geometry is cached
on layout changes; animation reads are batched before writes, transform updates
do not propagate inherited CSS variables, and unchanged endpoints skip work. Pause, keyboard focus,
live reduced-motion changes, and no JavaScript restore the complete readable static
grid or column without duplicate links. Pointer activation does not reflow targets;
keyboard entry and exit preserve the visible focused link. The local enhancement
script has a 8.5kB uncompressed ceiling (no animation dependency). The desktop hero tilts by at most two degrees while
scrolling away; the mobile hero remains still. Repeated blueprint callouts are removed because
the same capabilities already appear in the cards.

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

`pnpm run screenshots` captures desktop 1440×1000 and mobile 390×844 / 430×932
views, including the initial stack, focused middle, mid-toss, and final release states
at desktop and mobile sizes plus two contact sheets. Add `-- --video` for a genuine
forward-and-reverse browser scroll recording in both desktop and mobile viewports.
No screenshot or contact-sheet dimension exceeds 2000px. Output stays gitignored.

## Local development

```bash
# from this directory (marketing/)
pnpm install                 # isolated install — uses marketing/pnpm-lock.yaml
pnpm run dev                 # astro dev (live preview)
pnpm run build               # astro build + internal-link check
pnpm run test:unit           # SEO/asset/anchor contracts against dist/
pnpm exec playwright install chromium  # local audit browser, once
pnpm run test:browser        # serve dist/ and audit a11y + responsiveness
pnpm exec playwright install webkit  # optional additional local engine
pnpm run test:webkit         # same contracts under WebKit; not a physical iPhone test
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

## Hosting

Use a **separate** `mono-agent-marketing` Vercel project; do not change `mono-agent-docs`.

- `vercel.json` pins `framework: astro`, `buildCommand: pnpm run build`, and `outputDirectory: dist`.
- For CLI deployment from this isolated app, link and deploy from `marketing/`. The uploaded project root is this directory, not the repository root.
- If Git-based deployment is connected later, set its repository root directory to `marketing/`. Do not connect production to a branch without this app. GitHub merge and DNS changes are separate operations.
- The intended custom domain remains `mono-agent.dev`. Domain ownership/DNS must be verified before declaring it live; a working Vercel URL does not prove the custom domain works.
- The static site works without any environment variables. Vercel Analytics requires project-side enablement and explicit visitor consent; no ingestion token or reporting key is required.
- `.vercel/` and `.env*` are local-only and ignored. The Vercel CLI may create an OIDC `.env.local` while linking; it is not needed for this static app and must never be uploaded or committed.

```bash
# After authenticating Vercel; from marketing/
vercel link --project mono-agent-marketing
vercel deploy                 # preview
vercel deploy --prod          # only with production deployment approval
```

## CI

The repo's `ci.yml` runs a dedicated parallel **`marketing`** job: isolated
install, Chromium install, build (with link check), unit contracts against
the build, then the browser audit. Treat a red **`marketing`** check as a
merge blocker by convention, same as the `website` lane.

## Comparison sources

Checked 20 September 2026 against official documentation. This is a positioning
snapshot, not an exhaustive capability matrix or performance claim:

- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/): learning-oriented skills, persistent memory, messaging gateway, scheduled work.
- [OpenClaw](https://docs.openclaw.ai/): self-hosted messaging gateway, sessions, memory, multi-agent routing, browser control UI.
- [Codex CLI](https://developers.openai.com/codex/cli/): terminal editing/review, skills, MCP, scripted `codex exec`.
- [Claude Code](https://code.claude.com/docs/en/overview): multiple coding surfaces, instructions, skills/hooks/MCP and Agent SDK.
- [OpenCode](https://opencode.ai/docs/): provider choice, open-source terminal/desktop/IDE interfaces, Plan and Build modes.

These capabilities overlap with Mono Agent. Do not turn these summaries into
unsupported negative feature claims about another project. Recheck sources when
updating the public comparison.

## Shared infographic and README

`src/components/AgentOverview.astro` is the single authored diagram: real HTML text, inline SVG icons, CSS connectors and a mobile vertical layout. It replaces repeated introductory prose rather than hiding the JSON example. The root README uses deterministic captures of the same component, not a second independently drawn infographic:

```bash
pnpm run build
pnpm run screenshots -- --overview-assets
```

This refreshes `docs/assets/mono-agent-workspace{,-mobile}.png`. The regular screenshot command also captures the diagram at desktop/mobile widths. Consent screenshots are explicitly synthetic: the allowed hostname is overridden locally and every analytics endpoint is intercepted. No live analytics is used by tests or asset generation.

## Optional Vercel Web Analytics

The marketing project uses the Hobby plan: basic page views, daily visitor estimates, referrers and device/location breakdowns, subject to Vercel’s current team-wide allowance (50,000 events/month and one-month reporting window). Custom clicks, section reach, install copies, session replay, campaign funnels and newsletter collection are **not** implemented. No paid upgrade is authorized or needed.

The official `@vercel/analytics/astro` component lives inside an inert HTML template. `public/analytics.js` clones it only after a visitor explicitly opts in. The provider script is not requested before consent. A `window.webAnalyticsBeforeSend` guard rechecks consent/storage/GPC/DNT, drops non-pageview events and strips query strings/fragments from page URLs. Native Astro routing and Vercel’s build-time configuration remain intact.

Consent is stored under `mono-analytics-consent-vercel-v1` for at most 180 days. Consent for the previous provider is not reused; old preference/session identifiers are cleared. Unsupported hosts, unavailable storage, malformed/expired/future preferences and GPC/DNT cannot grant permission. Withdrawal normally reloads the page to unload the SDK, including across tabs. If a browser refuses to save withdrawal, the in-page guard keeps collection off and warns that the choice may not persist. No tracking cookies, `enableCookie`, own visitor/session identifiers, person profiles or custom events are used.

Vercel processes request information for daily visitor estimates, approximate geography and browser/device categories, and may receive the referrer provided by the browser. This is **not** the previous EU-only/no-geolocation setup. The privacy page describes that difference. `PUBLIC_PRIVACY_CONTACT` can optionally supply a valid public `mailto:` contact; never put a private API key in public environment variables.

### Enablement and reporting

Enable Web Analytics for `mono-agent-marketing` in Vercel’s Analytics dashboard, deploy and verify real consented visits. The project was already enabled when this integration was implemented. No PostHog account or reporting credentials are needed. The docs project is not instrumented by this change.

Authenticated CLI reporting is supported without Observability Plus:

```sh
vercel metrics schema vercel.analytics.page_view.count --scope robert-sreberskis-projects
vercel metrics vercel.analytics.page_view.count --project mono-agent-marketing --prod --since 7d --scope robert-sreberskis-projects --format json
```

`metrics schema` takes team scope, not `--project`; metric queries accept project selection. Empty results mean there is no data for the query, not that installation is proven. Provider bot filtering can exclude automated browsers. Do not manufacture visitor traffic or represent local mocked requests as ingested events.

Tests run the real installed Astro component/SDK against a deterministic local provider stub. An optional `VERCEL_VENDOR_FIXTURE=/absolute/path/to/captured-script.js` runs the same tests against an unmodified captured public Vercel collection script, still with every ingestion request intercepted locally. Any test-only bot-detection overrides are confined to that intercepted local harness, never production.

## Search discovery and canonical URLs

`astro.config.mjs` uses `src/site.mjs` as the production-origin authority. Production sets `PUBLIC_SITE_URL=https://mono-agent.dev` after DNS and HTTPS verification. Local and CI builds use the same verified custom domain by default. `Seo.astro`, JSON-LD, `robots.txt` and `sitemap.xml` all derive from that one origin. The crawler files are generated static routes, not independent files with hardcoded domains.

The home title describes the embeddable companion and TypeScript framework; the description names models/tools/memory, local-first use and embedding. The privacy page has distinct metadata. Both have absolute canonical/social URLs, meaningful image alternatives and a real 1200×630 image. Structured data describes a WebSite, WebPage and actual SoftwareSourceCode with its repository/language/license—not invented ratings, an unsupported search action or a social card masquerading as an organization logo.

Vercel preview builds emit `noindex, follow`; generated `mono-agent-marketing-*.vercel.app` deployment/branch aliases also receive an `X-Robots-Tag: noindex, follow` header. The custom production domain remains indexable. The former marketing and docs Vercel aliases are configured as permanent 308 redirects in their respective Vercel project domain settings, preserving paths and query strings. Robots allows crawling so search engines can see the indexing directives. All substantive content and links render without JavaScript or analytics consent. No keyword-meta tag, fabricated freshness timestamp, doorway page or unsupported FAQ rich-result promise is added.

### Owner steps outside the build

1. Verify the current URL-prefix property in Google Search Console and the site in Bing Webmaster Tools. Their issued **public verification values** can be supplied as `PUBLIC_GOOGLE_SITE_VERIFICATION` and `PUBLIC_BING_SITE_VERIFICATION` in Vercel, then redeployed. Do not invent verification values; no search account is connected by these placeholders.
2. Submit the live `/sitemap.xml`, inspect the homepage, and monitor indexing/canonical selection and real queries. A passing test is not proof a search engine indexed the site.
3. For a future domain migration, verify the new domain’s DNS and HTTPS pages first. Set the exported build environment `PUBLIC_SITE_URL=https://mono-agent.dev` in Vercel and redeploy; canonicals, schema, sitemap and social asset URLs change together. For a local smoke build, prefix `PUBLIC_SITE_URL=https://mono-agent.dev pnpm run build`.
4. Configure permanent redirects from the former production host and any nonpreferred custom-domain variant to the chosen canonical domain, avoiding redirect chains. Update the search properties/sitemap and inbound project links at that time. Do not redirect before the target works.

Metadata improves accurate discovery and previews; it cannot guarantee ranking, rich results, indexation, or a particular snippet. Organic growth still depends on useful documentation/content, real references and the product's relevance. Track Core Web Vitals with real-user data once available; one lab audit is not field performance.

## Blog

`/blog/` is a Markdown content collection (`src/content/blog/<slug>/index.md`
plus sibling images) with an index, per-post pages, RSS (`/blog/rss.xml`), and
sitemap entries. It ships empty and builds, tests, and reads intentionally
with zero posts. The authoring contract an automated daily process follows is
[`BLOG.md`](./BLOG.md): front-matter limits, image and honesty rules, and the
exact local validation commands.
