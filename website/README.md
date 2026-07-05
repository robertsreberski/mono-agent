# mono-agent documentation site

The published docs at **<https://mono-agent-docs.vercel.app/>** are an [Astro Starlight](https://starlight.astro.build/) app deployed on Vercel. The prose itself is **not** authored here — it lives, canonically, as Markdown under [`../docs/`](../docs/). This `website/` directory only renders it.

## Architecture

- **`../docs/` is the single source of truth.** It is kept in git, browsable on GitHub, and referenced by the `mono-agent-composer` skill. Edit docs there, not here.
- **`website/` is an isolated app.** It has its own `pnpm-workspace.yaml` so it never enters the root `pnpm -r build` / `pnpm -r test` / `check:architecture` (which stays at 25 packages; the root release test lane guards this count). Install and build it on its own.
- **Content is *synced*, not symlinked.** `scripts/sync-content.mjs` mirrors `../docs/**` into `src/content/docs/` (gitignored) before each dev/build. Starlight only applies its Markdown features — callout asides, heading links — to files physically under `src/content/docs`, so a copy is required. The mirror preserves the `docs/` tree exactly, so the "Edit this page" link (`editLink.baseUrl` → `.../edit/main/docs/`) resolves back to the canonical file.
- **Internal-only folders are excluded** from the published site: `docs/superpowers/` and `docs/skills/` (see `EXCLUDE_TOP` in `sync-content.mjs`).

## Local development

```bash
# from this directory (website/)
pnpm install                 # isolated install — uses website/pnpm-lock.yaml
pnpm run dev                 # syncs ../docs, then astro dev (live preview)
pnpm run build               # syncs, astro build, then the link checker
pnpm run check:links         # validate the built dist/ only
pnpm run sync                # re-mirror ../docs -> src/content/docs without building
```

`scripts/check-links.mjs` validates the built `dist/` (the real rendered output, so it is independent of the Markdown processor) and fails the build on a broken internal link.

## Version pins — do not bump blindly

`package.json` pins **`astro@^5.18`** and **`@astrojs/starlight@^0.37`**. This is deliberate:

> Starlight **0.38+ requires Astro 6**, whose new Markdown processor breaks both callout asides (they render as bare `<div>`s) and the upstream `starlight-links-validator`.

Because of that, link validation uses the custom `scripts/check-links.mjs` (which checks the built `dist/`, not the processor's AST) rather than `starlight-links-validator`. Before raising either pin, verify that asides still render styled and that the custom link checker still passes against the new output.

## Vercel deployment

`vercel.json` pins `framework: astro`, `buildCommand: pnpm run build`, `outputDirectory: dist`. In the Vercel project, set **Root Directory = `website`** so the isolated workspace is what builds. The site is live at `https://mono-agent-docs.vercel.app/`.

## One-off migration scripts

`scripts/migrate-frontmatter.mjs`, `scripts/migrate-callouts.mjs`, and `scripts/migrate-links.mjs` were used once to convert the old just-the-docs / Jekyll content (`nav_order` → `sidebar.order`, `{: .note }` → `:::note` asides, relative `.md` links → root-relative routes). They are kept for reference; you do not run them in the normal authoring loop.
