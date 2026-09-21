// @ts-check
import { defineConfig } from "astro/config";
import { resolveSiteUrl } from "./src/site.mjs";

export default defineConfig({
  site: resolveSiteUrl(),
  trailingSlash: "always",
  compressHTML: true,
  markdown: {
    // Single dark theme matching the site canvas; blog code blocks inherit it.
    shikiConfig: { theme: "github-dark" },
  },
  // Every page and crawler endpoint is pre-rendered; JS only enhances the UI.
});
