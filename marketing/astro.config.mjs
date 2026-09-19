// @ts-check

import { defineConfig } from "astro/config";

// The prospective production origin. Keep this absolute and stable: it feeds
// the canonical link, sitemap lookup, and Open Graph/Twitter card URLs.
const site = "https://mono-agent.dev";

// https://astro.build/config
export default defineConfig({
  site,
  compressHTML: true,
  // No client-side JavaScript on this site: every route is static HTML + CSS.
});
