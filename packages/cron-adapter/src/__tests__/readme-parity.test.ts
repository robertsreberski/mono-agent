import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readmeUrl = new URL("../../README.md", import.meta.url);

function section(page: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = page.indexOf(marker);
  if (start === -1) {
    throw new Error(`missing README section ${marker}`);
  }
  const rest = page.slice(start + marker.length);
  const end = rest.search(/^## /mu);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("cron adapter README parity", () => {
  it("keeps direct overlap controls distinct from the agent-app config surface", async () => {
    const readme = await readFile(readmeUrl, "utf8");

    expect(readme).toContain("programmatic-only");
    expect(readme).toContain("`startCronAdapter`");
    expect(readme).toContain('`overlap: "skip" | "queue" | "replace"`');
    expect(readme).toContain("`maxQueueDepth`");
    expect(readme).toContain("`overflow`");
    expect(readme).toContain('default `overflow: "preserve"` warns but keeps every firing');
    expect(readme).toContain('`overflow: "coalesce"` or `"drop-oldest"` to bound pending memory');
    expect(readme).toContain('pins `overlap: "skip"`');
    expect(readme).not.toMatch(/does not[^.\n]*queue overlapping jobs/iu);
  });

  it("keeps the public API and result inventory aligned with package exports", async () => {
    const readme = await readFile(readmeUrl, "utf8");
    const publicApi = section(readme, "Public API");
    const responsibility = section(readme, "Responsibility");

    expect(publicApi).toContain("`CRON_CONFIG_FIELDS`");
    expect(publicApi).toContain("`toCronJobs`");
    expect(readme).not.toContain("`cronFieldGroup`");
    expect(responsibility).toContain(
      "succeeded, failed, cancelled, skipped, queued, or dropped results",
    );
  });
});
