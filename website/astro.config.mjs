// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Canonical URL: auto-filled from Vercel's production domain at build time (enables
// the sitemap + canonical tags on deploys); left undefined locally.
const site = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : undefined;

// https://astro.build/config
export default defineConfig({
  // Served from the Vercel project root (no GitHub Pages base path).
  site,
  integrations: [
    starlight({
      title: 'mono-agent',
      favicon: '/favicon.svg',
      description:
        'Config-first agent framework — one mono-agent.config.json turns any folder ' +
        'into a running agent over webhook, OpenAI-compatible API, Telegram, Slack, ' +
        'WhatsApp, A2A, and cron, with tiered memory, sandboxing, and observability.',
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
      sidebar: [
        { label: 'Getting Started', autogenerate: { directory: 'getting-started' } },
        { label: 'Configuration', autogenerate: { directory: 'config' } },
        { label: 'Runtime & Providers', autogenerate: { directory: 'runtime' } },
        { label: 'Channels', autogenerate: { directory: 'channels' } },
        { label: 'Memory', autogenerate: { directory: 'memory' } },
        { label: 'Context & Skills', autogenerate: { directory: 'context' } },
        { label: 'Tools, MCP & Sandbox', autogenerate: { directory: 'tools' } },
        { label: 'Observability & CLI', autogenerate: { directory: 'observability' } },
        { label: 'Programmatic', autogenerate: { directory: 'programmatic' } },
        { label: 'Evals', autogenerate: { directory: 'evals' } },
        { label: 'Playbooks', autogenerate: { directory: 'playbooks' } },
        { label: 'Reference', autogenerate: { directory: 'reference' } },
      ],
    }),
  ],
});
