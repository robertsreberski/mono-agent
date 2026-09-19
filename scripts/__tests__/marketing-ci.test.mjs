import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";

describe("marketing CI contract", () => {
  test("keeps the isolated build, contracts, and rendered audit lane exact", () => {
    const source = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const document = parseDocument(source, { merge: false, strict: true, uniqueKeys: true, version: "1.2" });
    expect([...document.errors, ...document.warnings]).toEqual([]);
    const workflow = document.toJS({ mapAsMap: false });
    const marketing = workflow.jobs.marketing;

    expect(marketing).toEqual({
      name: "Marketing",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      defaults: { run: { "working-directory": "marketing" } },
      steps: [
        { name: "Checkout", uses: "actions/checkout@v4" },
        {
          name: "Setup Node",
          uses: "actions/setup-node@v4",
          with: { "node-version": "24" },
        },
        { name: "Install pinned pnpm", run: "npm install --global pnpm@11.18.0" },
        { name: "Install marketing dependencies", run: "pnpm install --frozen-lockfile" },
        { name: "Install Chromium", run: "pnpm exec playwright install --with-deps chromium" },
        {
          name: "Build marketing site (astro build -> check-links)",
          run: "pnpm run build",
        },
        // Contracts read dist/, so the build must precede them.
        { name: "Test marketing contracts against the build", run: "pnpm run test:unit" },
        { name: "Audit the built page for accessibility and responsiveness", run: "pnpm run test:browser" },
      ],
    });
  });
});
