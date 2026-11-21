# mono-agent marketing site

The marketing site at **<https://mono-agent.dev/>**, with documentation separately hosted at **<https://docs.mono-agent.dev/>** (see [Hosting](#hosting)). A standalone
[Astro](https://astro.build/) static app: a crawlable homepage, a Markdown
blog, a privacy page, one stylesheet, a consent-gated analytics module, and one
small local progressive-enhancement module (under 12 kB uncompressed). The
primary call to action is the getting-started tutorial on the docs site;
GitHub sits beside it.

## Architecture

- **`marketing/` is an isolated app.** It has its own `pnpm-workspace.yaml`,
  so it never enters the root `pnpm -r build`, `pnpm -r test`, release graph,
  or `check:architecture`. Install and build it on its own, following the
  `website/` precedent.
- **The homepage is "The coworker in a folder".** It is a faithful port of the
  reviewed field-manual design: a cover with the note you wrote and the note the
  agent left you, five numbered sections (the folder, mixed models, the phone
  console, memory, the tool choice) and a detachable setup sheet. Content is
  authored in `src/pages/index.astro` and `src/components/landing/`. The copy rules
  live in a comment at the top of `index.astro` — read them before editing copy.
  Every claim was verified against the published v0.27.1 release; the version
  line, stamp and release-notes link come from `src/site-links.mjs`. Do not add
  claims without the same source check against the current release.
- **The example agent is real.** `src/example-agent/payments-maintainer/` is a
  ten-file agent folder that `mono-agent validate` (v0.27.1) accepts: exit 0, with
  only the provider-credential and sandbox sections waiting. The page imports
  those files at build time (`src/example-agent/files.ts`, Vite `?raw`) and shows
  them byte-for-byte, so the page cannot drift from the folder.
  `manifest.json` beside it holds the display order and labels.
  Its `.env.example` carries key names only, and its own `.gitignore` keeps keys,
  history and scratch output out of git. `marketing/.gitignore` re-includes the
  config and `.env.example` that broader ignore rules would otherwise drop from
  git. The build never imports a dotfile: the page reads those two files from
  non-dot mirrors in `src/example-agent/dotfiles/`, because hosting uploads may
  drop `.env*` and ignore files (`.vercelignore` still excludes `.env*`).
  `tests/example-agent.test.mjs` keeps each mirror byte-identical to the real
  file. Edit both together. To re-validate, copy the folder to a temporary
  directory outside the repository and run `mono-agent validate` there with an
  empty `HOME`.
- **Artwork is ink on paper.** The drawings in `public/art/folder-art-*.webp` are
  transparent masks painted with the page ink through inline SVG, so the same art
  prints correctly in light and dark schemes. They are decorative and
  `aria-hidden`; none is presented as product UI.
- **The console images are real.** `public/art/folder-console-*.webp` are
  captures of the actual web console (desktop and phone, one per colour scheme)
  showing an example conversation, never a live session. The figure labels them
  "Real console, example conversation", and a hidden transcript describes them for
  screen readers. They were captured during the design review; their recipe is
  not reproducible from this repository alone, so the optimized files are committed.
- **Typography is self-hosted.** Source Serif 4, Barlow Condensed (500, 700) and
  Courier Prime (400, 700) are bundled under their SIL Open Font Licenses in
  `public/fonts/`. They are the Google Fonts Latin WOFF2 subsets (127,688 bytes
  total; Source Serif 4 is the variable wght/opsz cut). The page makes no runtime
  font-provider requests. Characters outside the subsets, such as the
  non-breaking hyphen, fall back to a system font, and italics are synthesized.
- **One stylesheet, both schemes.** `public/styles.css` is the design's
  stylesheet followed by a site section for the shared shell (skip link,
  colophon footer, consent slip) and the reading pages. Light and dark follow
  `prefers-color-scheme`; there is no theme toggle and no JavaScript involved.
- **SEO is tested, not assumed.** `tests/seo.test.mjs` audits the built
  `dist/`: title/description/canonical, absolute Open Graph/Twitter URLs, the
  real 1200×630 card dimensions, sitemap/robots, honest JSON-LD, single-H1
  structure, working anchors, the local script budget, and claim guards. The
  social card is a capture of the real homepage, regenerated with
  `pnpm run assets` after a build.

## Interaction design

Every section renders without JavaScript. The example folder is a list of
native `<details>` disclosures that show each file in full. `public/folder.js`
reads the same `data-*` attributes and swaps in the explorer: an ARIA tree with
a file sheet on desktop, and a drill-down list with back buttons that restore
focus on phones (660px and below). It also reveals the two copy buttons. Copy
reports success only after the clipboard (or the legacy fallback) succeeds;
otherwise it selects the command and says so. Clipboard tests stub success
and refusal; they prove UI handling, not operating-system permission.

No model calls are made. The native Vercel Analytics component stays inert until
consent; only then does it load the provider collection script, with details below.
The only motion is the result note settling onto the page once, which is disabled
for reduced-motion users. Readable text never fades through low-contrast states.

The blog and the privacy page use the same masthead, paper and colophon, but
they are reading pages: a restrained leaf at a comfortable measure, with the
display face for headings and the serif for prose. Code blocks are printed on
light note paper in both schemes, like every paper sheet on the site. The
homepage masthead stays exactly as designed (GitHub · Docs); the blog and the
privacy page are linked from the colophon footer, and posts keep their
"Home / Blog" breadcrumb.

## Screenshots for review

`pnpm run screenshots` captures every homepage section, the colophon, the explorer
with a file open, the blog index, a post and the privacy page, in light and dark,
at 320, 390, 430 and 1440 px. Add `-- --webkit` to repeat them in WebKit. Consent
screenshots are explicitly synthetic: the allowed hostname is overridden locally and
every analytics endpoint is intercepted. No screenshot dimension exceeds 2000px,
and output stays gitignored. No live analytics is used by tests or asset
generation.

The former workspace infographic (`AgentOverview`) and its
`screenshots -- --overview-assets` mode were retired with the previous homepage.
The root README's `docs/assets/mono-agent-workspace*.png` images remain as
committed files and can no longer be regenerated from this app.

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
pnpm run assets              # recapture public/og-1200x630.jpg from the built homepage
```

`scripts/check-links.mjs` validates the built `dist/` (same shape as the
website's checker) and fails the build on a broken internal link.
`tests/site.browser.spec.ts` audits the previewed homepage with axe (zero
WCAG 2.0 A/AA, 2.1 A/AA, or 2.2 AA violations) in light and dark, including with
a file open in the explorer. It asserts no horizontal overflow from 320 px to
desktop, the cover tabs in the first viewport, 44px tap targets, the explorer's
byte-for-byte files and keyboard pattern, the console annotations, copy
handling, reduced motion, no-JavaScript fallbacks, and that no page makes a
third-party request or logs an error without consent. `tests/example-agent.test.mjs`
pins the example folder and its rendering.

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

The separate **`mono-agent-marketing`** Vercel project is connected to this
repository's Git integration with `marketing/` as its root directory. Vercel
checks run on pull requests, and merges to `main` trigger production deployment.
Keep `mono-agent-docs` separate; no manual CLI deploy is part of this workflow.

- `vercel.json` pins `framework: astro`, `buildCommand: pnpm run build`, and `outputDirectory: dist`.
- The production custom-domain target is `mono-agent.dev`. Verify its deployed bytes and headers separately; a successful Vercel check alone does not prove the custom domain serves the intended revision.
- The static site works without any environment variables. Vercel Analytics requires project-side enablement and explicit visitor consent; no ingestion token or reporting key is required.
- `.vercel/` and `.env*` are local-only and ignored; local credentials must never be uploaded or committed.

## CI

The repo's `ci.yml` runs a dedicated parallel **`marketing`** job: isolated
install, Chromium install, build (with link check), unit contracts against
the build, then the browser audit. Treat a red **`marketing`** check as a
merge blocker by convention, same as the `website` lane.

## Comparison copy

The "Keep your tools. Add a coworker." section describes what you would reach
for each tool for — Mono Agent, Claude Code, OpenClaw, Hermes Agent and Mastra —
as approved in the design review. It is a positioning note, not a feature
matrix, ranking or performance claim. Do not turn these one-liners into
unsupported negative claims about another project; recheck the projects'
official documentation before changing them.

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

The home title is the design's headline, "The coworker in a folder — Mono Agent"; the description says what the folder holds (plain files, chosen models, skills) and that it can be shared. The privacy page has distinct metadata. Both have absolute canonical/social URLs, meaningful image alternatives and a real 1200×630 image. Structured data describes a WebSite, WebPage and actual SoftwareSourceCode with its repository/language/license—not invented ratings, an unsupported search action or a social card masquerading as an organization logo.

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

## Hosted config schema

`public/schema.json` is the canonical `mono-agent.config.json` JSON Schema,
served at `https://mono-agent.dev/schema.json` (its `$id`, and the `$schema`
value `mono-agent init` writes). It is a committed generated asset: run
`pnpm run generate:config-reference` from the repository root, which writes it
byte-identically alongside `packages/app/schema/mono-agent.config.schema.json`.
Root `pnpm test` (app config-reference tests) and `tests/schema.test.mjs` fail
if the copies drift. The repository file stays in place, so configs that still
reference the former raw GitHub URL keep resolving.

`vercel.json` gives the route `application/json; charset=utf-8`, `nosniff`,
`Access-Control-Allow-Origin: *` (browser-based editors and validators fetch it
cross-origin) and mandatory revalidation. Like the installer, the
extension-bearing file is not subject to trailing-slash page routing. Local
`astro preview` does not apply `vercel.json` headers; after the authorized
merge/deployment, verify the custom-domain bytes and headers separately.

## Public shell installer

`public/install.sh` and `public/install.sh.sha256` are committed generated assets,
served at `https://mono-agent.dev/install.sh` and its `.sha256` sibling. Vercel's
Git integration deploys the marketing project on a main merge; do not run a
manual deploy as part of artifact maintenance. Extension-bearing static files
are not subject to the site's page trailing-slash routing. Exact response
headers in `vercel.json` select plain text, nosniff, and mandatory revalidation.

Author sources live in `scripts/installer/` at the repository root. After a
`.nvmrc` change (also keep root engines and the support floor in agreement), run:

```sh
node scripts/installer/generate.mjs
node scripts/installer/generate.mjs --check
node --test scripts/installer/test/*.test.mjs
sh -n marketing/public/install.sh
shellcheck -s sh marketing/public/install.sh
```

Run those commands from the repository root, not this standalone app. A standalone
marketing build needs no files outside this directory: it copies the committed
assets byte-for-byte. Unit contracts check built bytes, checksum and route/header
configuration. Fixture tests are offline; `node scripts/installer/live-proof.mjs`
is an explicit network-using, throwaway-HOME smoke for official Node plus published
CLI/native dependencies. It must run as a non-root user and touches no real shell
startup files, agents or services.

After the authorized merge/deployment, separately verify the custom-domain URL,
redirect chain, content type and checksum against the reviewed artifact. A local
build does not prove production DNS or the deployed revision. The script checksum
shares the script's host trust boundary and is not an independent signature.

Installer maintenance notes: curl uses `-q` first (no curlrc trust overrides) and
slow-transfer limits. `SSL_CERT_FILE` is mapped to npm's `NODE_EXTRA_CA_CERTS`
when not explicitly set. The shim pins only its own Node executable; child PATH
is unchanged. Opt-in Bash edits select `.bash_profile` on macOS, `.bashrc` on
Linux; Zsh uses `.zshrc`. PATH cleanup preserves unsafe/modified files, restores
existing modes, and removes empty files created by the installer. No runnable
private Node is required to remove the CLI prefix (PATH cleanup may be skipped).

Upgrades prune to current + previous plus service-referenced generations.
Uninstall scans LaunchAgents and XDG systemd user definitions and refuses when
they reference this prefix’s runtime or CLI executable (raw, XML-escaped, or
systemd-escaped paths; not a PATH entry alone), with `mono-agent stop` / `mono-agent web stop`
instructions. It never stops services itself. `--force-uninstall` explicitly
bypasses this protection and can break those services. Live smoke covers pruning
and refusal using only a fake plist in its throwaway HOME.

CI checks ShellCheck on Ubuntu and fixtures on both runner OSes without matrix
fail-fast. To reproduce historical runner diagnostics, from the repository root:

```sh
docker run --rm -v "$PWD:/repo:ro" koalaman/shellcheck:v0.9.0 -s sh /repo/marketing/public/install.sh
```

The parent-scoped `~/.mono-agent/.cli-install-lock` remains held throughout CLI
subtree deletion, preventing a concurrent installer from being deleted mid-stage.
A missing current generation skips PATH cleanup but does not block removal;
`--force-uninstall` warns explicitly for both failed and positive service scans.
Host preflight is on main and ships in the next package release; published
0.26.0 still gets the explicit legacy warning.
