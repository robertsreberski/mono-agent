// @ts-check
import { defineConfig } from "astro/config";
import { resolveSiteUrl } from "./src/site.mjs";

export default defineConfig({
  site: resolveSiteUrl(),
  trailingSlash: "always",
  compressHTML: true,
  // Every page and crawler endpoint is pre-rendered; JS only enhances the UI.
});
