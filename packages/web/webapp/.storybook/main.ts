import type { StorybookConfig } from "@storybook/react-vite";
import { resolve } from "node:path";

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.tsx"],
  addons: [],
  framework: { name: "@storybook/react-vite", options: {} },
  docs: { autodocs: "tag" },
  viteFinal: async (config) => {
    return {
      ...config,
      base: "./",
      resolve: { ...config.resolve, alias: [
        { find: /^.*\/console-store$/, replacement: resolve(process.cwd(), "src/stories/store.ts") },
        ...(Array.isArray(config.resolve?.alias) ? config.resolve.alias : []),
      ] },
      // Product Vite config installs a PWA worker; Storybook is a separate site.
      plugins: config.plugins?.flat(Infinity).filter((plugin) => plugin && !/pwa|workbox/i.test(plugin.name ?? "")) as typeof config.plugins,
    };
  },
};

export default config;
