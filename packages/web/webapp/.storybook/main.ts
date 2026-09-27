import type { StorybookConfig } from "@storybook/react-vite";
import { resolve } from "node:path";

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.tsx"],
  addons: [],
  framework: { name: "@storybook/react-vite", options: {} },
  viteFinal: async (config) => {
    const plugins = ((config.plugins ?? []) as unknown[]).flat(Infinity)
      .filter((plugin) => plugin && typeof plugin === "object"
        && !/pwa|workbox/i.test(String((plugin as { name?: string }).name ?? "")));
    return {
      ...config,
      base: "./",
      resolve: { ...config.resolve, alias: [
        { find: /^.*\/console-store$/, replacement: resolve(process.cwd(), "src/stories/store.ts") },
        ...(Array.isArray(config.resolve?.alias) ? config.resolve.alias : []),
      ] },
      // Product Vite config installs a PWA worker; Storybook is a separate site.
      plugins: plugins as typeof config.plugins,
    };
  },
};

export default config;
