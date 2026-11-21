// @ts-check
import { defineConfig } from "astro/config";
import { resolveSiteUrl } from "./src/site.mjs";

export default defineConfig({
  site: resolveSiteUrl(),
  trailingSlash: "always",
  compressHTML: true,
  markdown: {
    // Blog code is printed on light note paper in both colour schemes, like
    // every paper sheet on the site, so it uses one high-contrast light theme.
    shikiConfig: { theme: "github-light-high-contrast" },
  },
  // Every page and crawler endpoint is pre-rendered; JS only enhances the UI.
});
