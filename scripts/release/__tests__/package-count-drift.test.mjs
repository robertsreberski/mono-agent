import { readFileSync } from "node:fs";

import { describe, test } from "vitest";

import { packageCatalog } from "../../package-catalog.mjs";

const expectedPublishablePackageCount = packageCatalog.filter((entry) => entry.publishable === true).length;

const guardedPackageCountReferences = [
  {
    filePath: "website/README.md",
    description: "the isolated app architecture note",
    pattern: /stays at (?<count>\d+) packages/u,
  },
];

function readRepositoryFile(filePath) {
  return readFileSync(new URL(`../../../${filePath}`, import.meta.url), "utf8");
}

describe("package count drift guard", () => {
  test.each(guardedPackageCountReferences)(
    "$filePath keeps its package count aligned with the package catalog",
    ({ filePath, description, pattern }) => {
      const contents = readRepositoryFile(filePath);
      const match = pattern.exec(contents);

      if (!match) {
        throw new Error(
          `${filePath} must include a package-count reference for ${description}; update the guard if the prose intentionally changed.`,
        );
      }

      const foundCount = Number(match.groups?.count);

      if (foundCount !== expectedPublishablePackageCount) {
        throw new Error(
          `${filePath} has stale package count ${foundCount}; expected ${expectedPublishablePackageCount} from scripts/package-catalog.mjs`,
        );
      }
    },
  );
});
