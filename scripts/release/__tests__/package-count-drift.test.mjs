import { readFileSync } from "node:fs";

import { describe, test } from "vitest";

import { packageCatalog } from "../../package-catalog.mjs";

const publishablePackages = packageCatalog.filter((entry) => entry.publishable === true);
const pluginTierCount = publishablePackages.filter((entry) => entry.tier === "plugin").length;
const coreTierCount = publishablePackages.length - pluginTierCount;

const expectedCounts = {
  core: coreTierCount,
  plugin: pluginTierCount,
};

// Both tier counts are guarded so prose that splits "N core + M plugin-tier
// extras" cannot silently drift from the catalog when the tiers change.
const guardedPackageCountReferences = [
  {
    filePath: "website/README.md",
    description: "the isolated app architecture note (core count)",
    pattern: /stays at (?<count>\d+) core packages/u,
    tier: "core",
  },
  {
    filePath: "website/README.md",
    description: "the isolated app architecture note (plugin-tier count)",
    pattern: /plus (?<count>\d+) plugin-tier extras/u,
    tier: "plugin",
  },
  {
    filePath: "PACKAGES.md",
    description: "the catalog count prose (core count)",
    pattern: /(?<count>\d+) core publishable packages/u,
    tier: "core",
  },
  {
    filePath: "PACKAGES.md",
    description: "the catalog count prose (plugin-tier count)",
    pattern: /plus (?<count>\d+) plugin-tier extras/u,
    tier: "plugin",
  },
  {
    filePath: "README.md",
    description: "the package architecture catalog count (core count)",
    pattern: /(?<count>\d+) core publishable packages/u,
    tier: "core",
  },
  {
    filePath: "README.md",
    description: "the package architecture catalog count (plugin-tier count)",
    pattern: /plus (?<count>\d+) plugin-tier extras/u,
    tier: "plugin",
  },
];

function readRepositoryFile(filePath) {
  return readFileSync(new URL(`../../../${filePath}`, import.meta.url), "utf8");
}

describe("package count drift guard", () => {
  test.each(guardedPackageCountReferences)(
    "$filePath keeps its $tier package count aligned with the package catalog",
    ({ filePath, description, pattern, tier }) => {
      const contents = readRepositoryFile(filePath);
      const match = pattern.exec(contents);

      if (!match) {
        throw new Error(
          `${filePath} must include a package-count reference for ${description}; update the guard if the prose intentionally changed.`,
        );
      }

      const foundCount = Number(match.groups?.count);
      const expected = expectedCounts[tier];

      if (foundCount !== expected) {
        throw new Error(
          `${filePath} has stale ${tier} package count ${foundCount}; expected ${expected} from scripts/package-catalog.mjs`,
        );
      }
    },
  );
});
