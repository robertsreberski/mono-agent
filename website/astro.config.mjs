// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { rehypeFocusableTables } from './scripts/rehype-focusable-tables.mjs';

// Canonical URL: auto-filled from Vercel's production domain at build time (enables
// the sitemap + canonical tags on deploys); left undefined locally.
const site = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : undefined;

// https://astro.build/config
export default defineConfig({
  // Served from the Vercel project root (no GitHub Pages base path).
  site,
  // Starlight makes wide tables horizontally scrollable. Put those regions in
  // the keyboard tab order so keyboard users can reach and scroll them too.
  markdown: {
    processor: unified({ rehypePlugins: [rehypeFocusableTables] }),
  },
  // docs/reference/recipes.md was renamed to docs/reference/presets.md; keep the
  // old URL working for external bookmarks and deep links.
  redirects: {
    '/reference/recipes/': '/reference/presets/',
  },
  integrations: [
    starlight({
      title: 'mono-agent',
      favicon: '/favicon.svg',
      description:
        'Config-first AI agent for coding and non-coding work in a persistent web ' +
        'workspace — one mono-agent.config.json defines the model routes, tools, ' +
        'skills, memory, channels, and sandbox.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/robertsreberski/mono-agent',
        },
      ],
      // "Edit this page on GitHub" — content lives under docs/ in the repo.
      editLink: {
        baseUrl: 'https://github.com/robertsreberski/mono-agent/edit/main/docs/',
      },
      // Curated section order, mirroring the old just-the-docs nav_order.
      // The browser console is the primary product surface, so it gets its own
      // top-level entry instead of being buried in the observability list; the
      // page keeps its stable /observability/web-console/ URL. Because a page
      // listed manually is still emitted by a sibling autogenerate group, the
      // observability group below spells out its pages explicitly — add new
      // observability pages to that list.
      sidebar: [
        { label: 'Getting Started', items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Web workspace', items: [{ label: 'Browser console', slug: 'observability/web-console' }] },
        { label: 'Configuration', items: [{ autogenerate: { directory: 'config' } }] },
        { label: 'Runtime & Providers', items: [{ autogenerate: { directory: 'runtime' } }] },
        { label: 'Channels', items: [{ autogenerate: { directory: 'channels' } }] },
        { label: 'Memory', items: [{ autogenerate: { directory: 'memory' } }] },
        { label: 'Context & Skills', items: [{ autogenerate: { directory: 'context' } }] },
        { label: 'Tools, MCP & Sandbox', items: [{ autogenerate: { directory: 'tools' } }] },
        {
          label: 'Observability & CLI',
          items: [
            { slug: 'observability' },
            { slug: 'observability/artifacts-and-traces' },
            { slug: 'observability/phoenix-and-backfill' },
            { slug: 'observability/cli-reference' },
            { slug: 'observability/tui' },
            { slug: 'observability/linux-services' },
          ],
        },
        { label: 'Programmatic', items: [{ autogenerate: { directory: 'programmatic' } }] },
        { label: 'Playbooks', items: [{ autogenerate: { directory: 'playbooks' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
});
