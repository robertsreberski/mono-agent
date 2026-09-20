# mono-agent marketing site

The prospective marketing site at **<https://mono-agent.dev/>** (Vercel hosting — see [Hosting](#hosting)). A standalone
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
  The v0.22.0 release notes and published app/web tarballs confirm projects, tags,
  and persistent subagents are released (checked 2026-09-20). The repository
  `docs/reference/release-status.md` still describes the older 0.21.1 boundary;
  do not repeat its stale source-only labels for these capabilities. Never present
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
control. The proof sequence is customize, delegate, inspect. A TypeScript
composition excerpt names the configured responder; it is not a runnable app and links
the imports and complete integration example. A source-linked comparison puts Hermes and OpenClaw alongside Mono Agent,
then covers Codex CLI, Claude Code, and OpenCode in a native disclosure. It compares documented focus, not
feature absence, exclusivity, or benchmark performance. All comparison content is
server-rendered. The enhancement script handles the menu, deck, and copy command;
FAQ disclosures are native HTML.

No model calls or third-party scripts are loaded. Optional analytics uses the PostHog Capture API only after consent, with details below. Clipboard tests
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
- The static site works without any environment variables. PostHog stays off until its public build variables and operator contact are set; see below.
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

This refreshes `docs/assets/mono-agent-workspace{,-mobile}.png`. The regular screenshot command also captures the diagram at desktop/mobile widths. Consent screenshots are explicitly synthetic: a fake public token is injected locally and every PostHog request is intercepted. No live analytics is used by tests or asset generation.

## Optional PostHog analytics

Newsletter signup is intentionally postponed. PostHog is opt-in, EU-only, and disabled unless the public project token is supplied. No SDK/autocapture, remote scripts, cookies, fingerprinting, person profiles, replay or form values are used. The browser sends a small allowlisted payload directly to the documented [Capture API](https://posthog.com/docs/api/capture).

Set these **public build variables** in the separate Vercel marketing project, then rebuild:

- `PUBLIC_POSTHOG_KEY`: the EU project's public ingestion token (`phc_…`), **not** a personal API key.
- `PUBLIC_PRIVACY_CONTACT`: the operator's public `mailto:` address for data requests. A configured token without this contact fails the build.

Production collection is restricted to `mono-agent.dev`, `www.mono-agent.dev` and `mono-agent-marketing.vercel.app`. Branch previews and local tests cannot accidentally report into production. Consent is off by default; GPC/DNT override stored acceptance. A local preference expires after 180 days. An accepted session uses a random per-tab ID, renewed after 30 minutes idle or 24 hours total. Session IDs follow PostHog’s UUIDv7 requirement. These measure consenting sessions, not deduplicated people across devices. Storage failure never grants consent. Withdrawal clears the session ID and stops future events, including across tabs. Event delivery errors are reported in the browser console without blocking the site; there is no retry queue.

| Event | Allowed additional fields |
| --- | --- |
| `$pageview` | Referring hostname; short alphanumeric/underscore/hyphen `utm_source`, `utm_medium`, `utm_campaign` tags |
| `$pageleave` | None |
| `section_viewed` | Static section ID, once per page after consent |
| `github_clicked`, `docs_clicked`, `blueprint_opened` | Static placement ID |
| `install_command_copied` | None; emitted only on clipboard success |
| `faq_opened` | Numeric question index |

Shared properties are pathname/current URL without query or fragment, hostname, mobile/desktop category, per-tab session ID, `$process_person_profile: false` and `$geoip_disable: true`. Do not encode personal information in campaign tags. Hosting/ingestion providers still receive network connection metadata; this is not a promise of absolute anonymity.

In PostHog, create a **Marketing** dashboard with pageviews/sessions by source and campaign, section reach, GitHub/docs conversions, and install-command copies. Use `$pageview → github_clicked` and `$pageview → install_command_copied` funnels. A 200 ingestion response alone is not reporting proof: verify the named events in the actual project before calling analytics live.

For maintainer reporting, grant project-scoped read-only query access separately. A personal query key belongs in owner-only local secret storage, never in `PUBLIC_*`, the repository, or chat. No PostHog reporting credentials or MCP connection are bundled here. Dashboard creation and live ingestion verification require that account access.
